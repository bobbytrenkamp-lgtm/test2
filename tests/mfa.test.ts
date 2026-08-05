import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { totp } from '@cre/database';
import {
  authed,
  createTestContext,
  hasDatabase,
  registerActor,
  type Actor,
  type TestContext,
} from './helpers.js';

/**
 * Multi-factor authentication through the API.
 *
 * The algorithm itself is checked against the RFC's published vectors in
 * `packages/database/src/totp.test.ts`. These are the questions the algorithm
 * cannot answer:
 *
 *   - is the code checked *before* a session exists, or after — because a
 *     cookie issued first and questioned second is not a second factor;
 *   - does the secret ever come back out of the API once issued;
 *   - is a recovery code really single-use;
 *   - can an enrolment be completed with a code that does not verify.
 *
 * Each of those is a way to build something that passes for MFA and is not.
 */
describe.skipIf(!hasDatabase)('multi-factor authentication', () => {
  let ctx: TestContext;
  let actor: Actor;
  const email = 'mfa-user@example.invalid';
  const password = 'demo-password-2026-mfa';

  beforeAll(async () => {
    ctx = await createTestContext();
    actor = await registerActor(ctx.app, email, 'MFA User', password);
  }, 90_000);

  afterAll(async () => {
    await ctx?.close();
  });

  const login = async (payload: Record<string, unknown>) =>
    ctx.app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      headers: { 'x-requested-with': 'cre-platform' },
      payload: { email, password, ...payload },
    });

  let secret = '';
  let recoveryCodes: string[] = [];

  it('signs in with a password alone before anything is enrolled', async () => {
    const response = await login({});
    expect(response.statusCode).toBe(200);
  });

  it('issues a secret and an enrolment URI, and is not yet enrolled', async () => {
    const response = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/auth/mfa/enrol',
      headers: authed(actor.cookie),
      payload: {},
    });
    expect(response.statusCode).toBe(200);
    const body = response.json() as { secret: string; uri: string };
    secret = body.secret;
    expect(secret).toMatch(/^[A-Z2-7]+$/);
    expect(body.uri).toContain('otpauth://totp/');

    // Issuing a secret must not protect the account yet: the user may never
    // have successfully scanned it, and flipping the flag here would lock them
    // out with a secret they do not have.
    const status = await ctx.app.inject({
      method: 'GET',
      url: '/api/v1/auth/mfa',
      headers: authed(actor.cookie),
    });
    const state = status.json() as { enrolled: boolean; pending: boolean };
    expect(state.enrolled).toBe(false);
    expect(state.pending).toBe(true);

    // And the password alone still works, because nothing is enrolled.
    expect((await login({})).statusCode).toBe(200);
  });

  it('refuses to confirm an enrolment with a code that does not verify', async () => {
    const response = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/auth/mfa/confirm',
      headers: authed(actor.cookie),
      payload: { code: '000000' },
    });
    // 000000 is a real code for some secret at some moment, so this could in
    // principle be a false failure; the odds are one in a million and the
    // alternative is not testing the rejection path at all.
    expect(response.statusCode).toBe(400);

    const status = await ctx.app.inject({
      method: 'GET',
      url: '/api/v1/auth/mfa',
      headers: authed(actor.cookie),
    });
    expect((status.json() as { enrolled: boolean }).enrolled).toBe(false);
  });

  it('confirms with a real code and returns recovery codes once', async () => {
    const response = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/auth/mfa/confirm',
      headers: authed(actor.cookie),
      payload: { code: totp(secret) },
    });
    expect(response.statusCode).toBe(200);
    const body = response.json() as { enrolled: boolean; recoveryCodes: string[] };
    expect(body.enrolled).toBe(true);
    expect(body.recoveryCodes).toHaveLength(10);
    recoveryCodes = body.recoveryCodes;
  });

  it('never hands the secret back out once it has been issued', async () => {
    /*
     * The point of the second factor is that somebody holding a stolen session
     * still cannot act as the user. If the API would tell that session the
     * TOTP secret, the factor is decorative.
     */
    for (const url of ['/api/v1/auth/me', '/api/v1/auth/mfa']) {
      const response = await ctx.app.inject({ method: 'GET', url, headers: authed(actor.cookie) });
      expect(response.statusCode).toBe(200);
      expect(response.body).not.toContain(secret);
    }
  });

  it('refuses a password-only login once enrolled', async () => {
    const response = await login({});
    expect(response.statusCode).toBe(401);
    expect(response.body).toContain('MFA_REQUIRED');
    // No session may have been issued alongside the refusal.
    expect(response.headers['set-cookie']).toBeUndefined();
  });

  it('refuses a wrong code, and issues no session with it', async () => {
    const response = await login({ code: '123456' });
    expect(response.statusCode).toBe(401);
    expect(response.headers['set-cookie']).toBeUndefined();
  });

  it('accepts the current code', async () => {
    const response = await login({ code: totp(secret) });
    expect(response.statusCode).toBe(200);
    expect(response.headers['set-cookie']).toBeDefined();
  });

  it('accepts a recovery code, and only once', async () => {
    const code = recoveryCodes[0] as string;

    const first = await login({ code });
    expect(first.statusCode).toBe(200);

    // Single use is the whole property. A recovery code that keeps working is
    // a permanent password that bypasses the second factor.
    const second = await login({ code });
    expect(second.statusCode).toBe(401);

    // A different unused code still works, so spending one does not spend all.
    const other = await login({ code: recoveryCodes[1] as string });
    expect(other.statusCode).toBe(200);
  });

  it('counts down the remaining recovery codes', async () => {
    const status = await ctx.app.inject({
      method: 'GET',
      url: '/api/v1/auth/mfa',
      headers: authed(actor.cookie),
    });
    // Ten issued, two spent above.
    expect((status.json() as { recoveryCodesRemaining: number }).recoveryCodesRemaining).toBe(8);
  });

  it('will not enrol a second authenticator over a working one', async () => {
    const response = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/auth/mfa/enrol',
      headers: authed(actor.cookie),
      payload: {},
    });
    // Issuing a new secret here would silently invalidate the authenticator
    // entry that currently works.
    expect(response.statusCode).toBe(400);
  });

  it('requires the password to remove the second factor', async () => {
    const wrong = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/auth/mfa/disable',
      headers: authed(actor.cookie),
      payload: { password: 'not-the-password' },
    });
    expect(wrong.statusCode).toBe(400);

    // Still enrolled after the failed attempt.
    const stillOn = await login({});
    expect(stillOn.statusCode).toBe(401);

    const right = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/auth/mfa/disable',
      headers: authed(actor.cookie),
      payload: { password },
    });
    expect(right.statusCode).toBe(200);

    // And the password alone signs in again.
    expect((await login({})).statusCode).toBe(200);
  });

  it('discards the recovery codes with the factor they belonged to', async () => {
    // A code left behind by a removed enrolment would be a way in that no
    // screen shows and nobody remembers.
    const response = await ctx.app.inject({
      method: 'GET',
      url: '/api/v1/auth/mfa',
      headers: authed(actor.cookie),
    });
    expect((response.json() as { recoveryCodesRemaining: number }).recoveryCodesRemaining).toBe(0);
  });
});

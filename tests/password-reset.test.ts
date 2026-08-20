import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  HEADERS,
  createTestContext,
  hasDatabase,
  registerActor,
  type TestContext,
} from './helpers.js';
import type { Mailer, MailMessage } from '../apps/api/src/mailer.js';

/**
 * Password reset delivery.
 *
 * Found by a launch-readiness review: `POST /auth/password-reset/request`
 * created a real, usable reset token but never sent it anywhere — delivery
 * was "deliberately abstracted", per the route's own comment, with no
 * mailer actually wired in. A password-reset flow that only works by
 * reading the token off the HTTP response (never sent to the address that
 * owns the account) is not a reset flow a real user could complete.
 *
 * A recording spy stands in for a mail server here, the same way the rest
 * of this suite uses a real (if scratch) PostgreSQL schema rather than a
 * mock — the point is proving the route actually calls the mailer with a
 * usable link, not that some object's method was invoked.
 */
class SpyMailer implements Mailer {
  readonly sent: MailMessage[] = [];
  async send(message: MailMessage): Promise<void> {
    this.sent.push(message);
  }
}

/**
 * Stands in for a relay that rejects, times out, or is simply unreachable —
 * the case the route's own doc comment now names directly: this must never
 * surface as anything different from the identical response a nonexistent
 * address gets, or the enumeration-safety property is only true when the
 * mailer happens to be working.
 */
class FailingMailer implements Mailer {
  async send(): Promise<void> {
    throw new Error('mail relay unreachable (simulated)');
  }
}

describe.skipIf(!hasDatabase)('password reset', () => {
  let ctx: TestContext;
  let mailer: SpyMailer;

  beforeAll(async () => {
    mailer = new SpyMailer();
    ctx = await createTestContext({ mailer });
  }, 60_000);

  afterAll(async () => {
    await ctx?.close();
  });

  it('sends a reset link to the address that owns the account', async () => {
    const actor = await registerActor(ctx.app, 'reset-me@example.invalid', 'Reset Me');

    const response = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/auth/password-reset/request',
      headers: HEADERS,
      payload: { email: actor.email },
    });
    expect(response.statusCode).toBe(200);
    const body = response.json() as { ok: boolean; developmentToken?: string };
    expect(body.ok).toBe(true);
    expect(body.developmentToken).toBeTruthy();

    expect(mailer.sent).toHaveLength(1);
    const message = mailer.sent[0] as MailMessage;
    expect(message.to).toBe(actor.email);
    // The link carries the same token the response echoed back for
    // development convenience -- proving the mailer was not sent some
    // separate, disconnected message.
    expect(message.text).toContain(`token=${body.developmentToken}`);
    expect(message.text).toContain('/reset-password?token=');

    // The token in the email actually works, end to end.
    const confirm = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/auth/password-reset/confirm',
      headers: HEADERS,
      payload: { token: body.developmentToken, password: 'a-new-sufficiently-long-password' },
    });
    expect(confirm.statusCode).toBe(200);
  });

  it('does not send mail, or otherwise disclose whether the address exists, for an unknown email', async () => {
    const before = mailer.sent.length;
    const response = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/auth/password-reset/request',
      headers: HEADERS,
      payload: { email: 'nobody-at-all@example.invalid' },
    });
    expect(response.statusCode).toBe(200);
    const body = response.json() as { ok: boolean; developmentToken?: string; message: string };
    expect(body.ok).toBe(true);
    expect(body.developmentToken).toBeUndefined();

    // Same message either way -- the response for a real address (previous
    // test) and a nonexistent one must read identically, or the wording
    // alone would leak which accounts exist.
    expect(body.message).toBe('If that address has an account, a reset link is on its way.');
    expect(mailer.sent).toHaveLength(before);
  });
});

describe.skipIf(!hasDatabase)('password reset when the mailer itself fails', () => {
  let ctx: TestContext;

  beforeAll(async () => {
    ctx = await createTestContext({ mailer: new FailingMailer() });
  }, 60_000);

  afterAll(async () => {
    await ctx?.close();
  });

  it('still returns the same 200 and the same message a real account normally gets', async () => {
    const actor = await registerActor(ctx.app, 'reset-mailer-down@example.invalid', 'Reset Me Too');

    const response = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/auth/password-reset/request',
      headers: HEADERS,
      payload: { email: actor.email },
    });

    // Before this fix, the mailer's rejection propagated unhandled and the
    // framework's own error handler turned it into a 500 — the one thing
    // this route's own doc comment says must never happen: a real account
    // and a nonexistent one must be indistinguishable from the response
    // alone, and a 500 only a real account can ever trigger is exactly the
    // kind of distinguishing signal that promise exists to rule out.
    expect(response.statusCode).toBe(200);
    const body = response.json() as { ok: boolean; message: string };
    expect(body.ok).toBe(true);
    expect(body.message).toBe('If that address has an account, a reset link is on its way.');
  });
});

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

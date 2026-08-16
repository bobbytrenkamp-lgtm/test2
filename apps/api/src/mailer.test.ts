import { describe, expect, it } from 'vitest';
import type { FastifyBaseLogger } from 'fastify';
import { loadEnv } from './env.js';
import { ConsoleMailer, SmtpMailer, createMailer } from './mailer.js';

const BASE_ENV = {
  NODE_ENV: 'test',
  DATABASE_URL: 'postgres://user:pass@localhost:5432/db',
  SESSION_SECRET: 'test-session-secret-that-is-long-enough-to-pass',
  SESSION_COOKIE_SECURE: 'false',
};

/** A minimal stand-in for Fastify's logger; ConsoleMailer only ever calls `.info`. */
function fakeLogger(): FastifyBaseLogger & { calls: unknown[] } {
  const calls: unknown[] = [];
  return {
    calls,
    info: (...args: unknown[]) => calls.push(args),
  } as unknown as FastifyBaseLogger & { calls: unknown[] };
}

describe('createMailer', () => {
  it('defaults to a ConsoleMailer, which logs rather than sends', async () => {
    const env = loadEnv(BASE_ENV);
    expect(env.MAIL_DRIVER).toBe('console');
    const log = fakeLogger();
    const mailer = createMailer(env, log);
    expect(mailer).toBeInstanceOf(ConsoleMailer);

    await mailer.send({ to: 'someone@example.invalid', subject: 'Hello', text: 'Body' });
    expect(log.calls).toHaveLength(1);
  });

  it('builds an SmtpMailer when MAIL_DRIVER=smtp and SMTP_HOST is set', () => {
    const env = loadEnv({ ...BASE_ENV, MAIL_DRIVER: 'smtp', SMTP_HOST: 'smtp.example.invalid' });
    const mailer = createMailer(env, fakeLogger());
    expect(mailer).toBeInstanceOf(SmtpMailer);
  });

  it('refuses to start with MAIL_DRIVER=smtp and no SMTP_HOST', () => {
    // Found by the same review: without this check, a deployment could set
    // MAIL_DRIVER=smtp, forget SMTP_HOST, and the server would start
    // successfully with a mailer that fails on the first real send instead
    // of refusing at startup the way every other misconfiguration here does.
    expect(() => loadEnv({ ...BASE_ENV, MAIL_DRIVER: 'smtp' })).toThrow(/SMTP_HOST is required/);
  });
});

import { z } from 'zod';

/**
 * Environment validation.
 *
 * The process refuses to start on a misconfigured environment rather than
 * failing later on the first request. A short session secret in particular is
 * treated as a hard error: signing sessions with a guessable key would make
 * every other access control in the platform decorative.
 */
const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
  API_PORT: z.coerce.number().int().min(1).max(65535).default(4000),
  /**
   * PostgreSQL connections this process may hold.
   *
   * **This is not a throughput knob.** The concurrency test measured 5, 10, 30
   * and 60 connections under 200 parallel clients and found throughput flat to
   * slightly worse as the pool grew, with the latency tail lengthening. The
   * constraint is the single Node process — serialising large cash-flow
   * payloads is CPU work, and more connections only add contention for it.
   * Throughput scales by running more API processes, not a bigger pool.
   *
   * It is here because a deployment has to *bound* connections against the
   * database's own `max_connections`: every API process multiplies this, and a
   * database that refuses connections is a worse failure than a slow one.
   */
  DATABASE_MAX_CONNECTIONS: z.coerce.number().int().min(1).max(200).default(10),
  API_HOST: z.string().default('0.0.0.0'),
  WEB_ORIGIN: z.string().default('http://localhost:5173'),
  SESSION_SECRET: z
    .string()
    .min(
      32,
      "SESSION_SECRET must be at least 32 characters. Generate one with: node -e \"console.log(require('crypto').randomBytes(48).toString('base64url'))\"",
    ),
  SESSION_COOKIE_SECURE: z
    .enum(['true', 'false'])
    .default('false')
    .transform((value) => value === 'true'),
  STORAGE_DRIVER: z.enum(['local', 's3']).default('local'),
  STORAGE_LOCAL_DIR: z.string().default('./uploads'),
  AI_ASSISTANT_PROVIDER: z.string().default('none'),
  /**
   * `console` logs the message instead of sending it — always what runs in
   * development and test, so the password-reset flow is exercisable without
   * a mail server. `smtp` sends for real, through `nodemailer` (a free
   * library, no paid API) against whatever relay `SMTP_HOST` names; picking
   * and provisioning that relay is an operator decision this platform does
   * not make for you, the same way `STORAGE_DRIVER: s3` names a driver
   * without bundling an AWS account.
   */
  MAIL_DRIVER: z.enum(['console', 'smtp']).default('console'),
  MAIL_FROM: z.string().default('CRE Platform <no-reply@localhost>'),
  SMTP_HOST: z.string().optional(),
  SMTP_PORT: z.coerce.number().int().min(1).max(65535).default(587),
  SMTP_USER: z.string().optional(),
  SMTP_PASSWORD: z.string().optional(),
  SMTP_SECURE: z
    .enum(['true', 'false'])
    .default('false')
    .transform((value) => value === 'true'),
  /** Set to "true" to allow open self-registration. */
  ALLOW_SELF_REGISTRATION: z
    .enum(['true', 'false'])
    .default('true')
    .transform((value) => value === 'true'),
  /**
   * `none` (default) never scans an upload — nothing to configure, which is
   * why a fresh checkout can run the rent-roll and actuals import wizards
   * with nothing installed. Every response from those two import routes
   * says explicitly whether the file was scanned, so "not scanned" is a
   * visible fact, not a silent gap. `clamav` requires a reachable `clamd`
   * (the docker-compose stack runs one as a service — free and open
   * source, no paid API) and refuses the specific upload, not the whole
   * server, if the scanner cannot be reached when a scan is due.
   */
  SCAN_DRIVER: z.enum(['none', 'clamav']).default('none'),
  SCAN_HOST: z.string().default('localhost'),
  SCAN_PORT: z.coerce.number().int().min(1).max(65535).default(3310),
});

export type Env = z.infer<typeof envSchema>;

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const parsed = envSchema.safeParse(source);
  if (!parsed.success) {
    const problems = parsed.error.issues
      .map((issue) => `  - ${issue.path.join('.')}: ${issue.message}`)
      .join('\n');
    throw new Error(`Invalid environment configuration:\n${problems}`);
  }
  if (parsed.data.NODE_ENV === 'production' && !parsed.data.SESSION_COOKIE_SECURE) {
    throw new Error(
      'SESSION_COOKIE_SECURE must be "true" in production so session cookies are only sent over HTTPS.',
    );
  }
  if (parsed.data.MAIL_DRIVER === 'smtp' && !parsed.data.SMTP_HOST) {
    throw new Error('SMTP_HOST is required when MAIL_DRIVER is "smtp".');
  }
  return parsed.data;
}

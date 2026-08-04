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
  /** Set to "true" to allow open self-registration. */
  ALLOW_SELF_REGISTRATION: z
    .enum(['true', 'false'])
    .default('true')
    .transform((value) => value === 'true'),
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
  return parsed.data;
}

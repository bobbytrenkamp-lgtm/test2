import { randomBytes } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../apps/api/src/server.js';
import { loadEnv } from '../apps/api/src/env.js';
import { closeDatabase, createDatabase, migrate, type Sql } from '../packages/database/src/index.js';

/**
 * Integration-test harness.
 *
 * Each suite gets its own PostgreSQL schema, so tests can run against a real
 * database — real constraints, real transactions, real SQL — without sharing
 * state. Testing organization isolation against a mock would prove nothing;
 * the point is that the actual queries are scoped correctly.
 */

const BASE_URL = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;

export const hasDatabase = Boolean(BASE_URL);

export interface TestContext {
  app: FastifyInstance;
  sql: Sql;
  schema: string;
  close: () => Promise<void>;
}

export async function createTestContext(): Promise<TestContext> {
  if (!BASE_URL) throw new Error('TEST_DATABASE_URL or DATABASE_URL must be set to run these tests.');

  const schema = `test_${randomBytes(6).toString('hex')}`;
  const admin = createDatabase({ connectionString: BASE_URL });
  await admin.unsafe(`CREATE SCHEMA "${schema}"`);
  await admin.end({ timeout: 5 });

  const url = new URL(BASE_URL);
  url.searchParams.set('options', `-c search_path=${schema}`);
  const sql = createDatabase({ connectionString: url.toString() });
  await migrate(sql);

  const app = await buildServer({
    env: loadEnv({
      ...process.env,
      NODE_ENV: 'test',
      DATABASE_URL: url.toString(),
      SESSION_SECRET: 'test-session-secret-that-is-long-enough-to-pass',
      SESSION_COOKIE_SECURE: 'false',
      ALLOW_SELF_REGISTRATION: 'true',
    }),
    db: sql,
    logger: process.env.TEST_LOG === '1',
  });

  return {
    app,
    sql,
    schema,
    close: async () => {
      await app.close();
      await sql.unsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await sql.end({ timeout: 5 });
      await closeDatabase();
    },
  };
}

/** Every state-changing call carries the header the CSRF check requires. */
export const HEADERS = { 'x-requested-with': 'cre-platform', 'content-type': 'application/json' };

export interface Actor {
  cookie: string;
  userId: string;
  email: string;
}

export async function registerActor(
  app: FastifyInstance,
  email: string,
  name: string,
  password = 'a-sufficiently-long-password',
): Promise<Actor> {
  const response = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/register',
    headers: HEADERS,
    payload: { email, name, password },
  });
  if (response.statusCode !== 201) {
    throw new Error(`Registration failed (${response.statusCode}): ${response.body}`);
  }
  const cookie = extractCookie(response.headers['set-cookie']);
  const body = response.json() as { user: { id: string } };
  return { cookie, userId: body.user.id, email };
}

export async function signIn(
  app: FastifyInstance,
  email: string,
  password = 'a-sufficiently-long-password',
): Promise<string> {
  const response = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    headers: HEADERS,
    payload: { email, password },
  });
  if (response.statusCode !== 200) {
    throw new Error(`Sign-in failed (${response.statusCode}): ${response.body}`);
  }
  return extractCookie(response.headers['set-cookie']);
}

function extractCookie(raw: string | string[] | undefined): string {
  const values = Array.isArray(raw) ? raw : raw ? [raw] : [];
  const session = values.find((value) => value.startsWith('cre_session='));
  if (!session) throw new Error('No session cookie was set on the response.');
  return session.split(';')[0] as string;
}

export function authed(cookie: string): Record<string, string> {
  return { ...HEADERS, cookie };
}

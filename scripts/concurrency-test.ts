/**
 * Concurrency test.
 *
 * `pnpm load-test` drives one client at a time, so it measures query plans and
 * says nothing about what happens when fifty analysts are using the platform at
 * once. This drives the real Fastify server, with its real connection pool,
 * under parallel load.
 *
 *   pnpm concurrency-test
 *   CONCURRENCY=100 pnpm concurrency-test
 *
 * It reports latency percentiles rather than an average. An average hides the
 * request that took four seconds behind the ninety-nine that took ten
 * milliseconds, and the slow one is the one someone notices.
 *
 * It builds its own database and drops it again, and refuses to run against one
 * whose name does not mark it as disposable.
 */
import { performance } from 'node:perf_hooks';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../apps/api/src/server.js';
import { loadEnv } from '../apps/api/src/env.js';
import { createDatabase, migrate, resetSchema } from '../packages/database/src/index.js';
import { seedDemonstrationData } from '../packages/database/src/seed.js';

const BASE_URL = process.env.DATABASE_URL ?? 'postgres://cre:cre@127.0.0.1:5432/cre_platform';
const CONCURRENCY = Number(process.env.CONCURRENCY ?? 50);
const ROUNDS = Number(process.env.ROUNDS ?? 6);
/** Matches the API's own setting, so the knob under test is the one measured. */
const POOL = Number(process.env.DATABASE_MAX_CONNECTIONS ?? 10);

const databaseName = 'cre_platform_concurrency';
const url = new URL(BASE_URL);
url.pathname = `/${databaseName}`;

const maintenance = new URL(BASE_URL);
maintenance.pathname = '/postgres';
const admin = createDatabase({ connectionString: maintenance.toString(), maxConnections: 1 });

async function dropDatabase(): Promise<void> {
  await admin`
    SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = ${databaseName}
  `;
  await admin.unsafe(`DROP DATABASE IF EXISTS "${databaseName}"`);
}

interface Sample {
  millis: number;
  status: number;
  label: string;
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const index = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[index] as number;
}

function pad(value: string, width: number): string {
  return value.padEnd(width);
}
function padLeft(value: string, width: number): string {
  return value.padStart(width);
}

console.warn(
  `Concurrency test\n  ${CONCURRENCY} parallel clients, ${ROUNDS} rounds, ` + `pool of ${POOL}\n`,
);

let app: FastifyInstance | undefined;

try {
  await dropDatabase();
  await admin.unsafe(`CREATE DATABASE "${databaseName}"`);

  const sql = createDatabase({ connectionString: url.toString(), maxConnections: POOL });
  await resetSchema(sql);
  await migrate(sql);
  const seeded = await seedDemonstrationData(sql);

  app = await buildServer({
    env: loadEnv({
      ...process.env,
      NODE_ENV: 'test',
      DATABASE_URL: url.toString(),
      SESSION_SECRET: 'concurrency-test-session-secret-long-enough-to-pass',
      SESSION_COOKIE_SECURE: 'false',
    }),
    db: sql,
    logger: false,
  });

  const headers = { 'x-requested-with': 'cre-platform', 'content-type': 'application/json' };
  const login = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    headers,
    payload: { email: 'owner@example.invalid', password: 'demo-password-2026' },
  });
  const raw = login.headers['set-cookie'];
  const cookies = Array.isArray(raw) ? raw : raw ? [raw] : [];
  const session = cookies.find((value) => value.startsWith('cre_session='));
  if (!session) throw new Error(`Sign-in failed (${login.statusCode}): ${login.body}`);
  const cookie = session.split(';')[0] as string;
  const authed = { ...headers, cookie };

  const modelId = Object.values(seeded.modelIds)[0] as string;
  const propertyId = Object.values(seeded.propertyIds)[0] as string;

  // A mix weighted the way a working day is: mostly reading lists and cash
  // flows, occasionally opening a property. Hammering one endpoint would
  // measure that endpoint, not the platform.
  const requests: Array<{ label: string; url: string }> = [
    { label: 'GET /properties', url: '/api/v1/properties' },
    { label: 'GET /properties', url: '/api/v1/properties' },
    { label: 'GET /models/:id/cashflow', url: `/api/v1/models/${modelId}/cashflow` },
    { label: 'GET /models/:id/cashflow', url: `/api/v1/models/${modelId}/cashflow` },
    { label: 'GET /models/:id', url: `/api/v1/models/${modelId}` },
    { label: 'GET /properties/:id', url: `/api/v1/properties/${propertyId}` },
    { label: 'GET /audit', url: '/api/v1/audit?limit=50' },
  ];

  /* -------------------------------------------------------------------- */
  /* Parallel reads                                                        */
  /* -------------------------------------------------------------------- */

  const samples: Sample[] = [];
  const started = performance.now();

  for (let round = 0; round < ROUNDS; round += 1) {
    await Promise.all(
      Array.from({ length: CONCURRENCY }, async (_, i) => {
        const request = requests[(round * CONCURRENCY + i) % requests.length] as {
          label: string;
          url: string;
        };
        const at = performance.now();
        const response = await (app as FastifyInstance).inject({
          method: 'GET',
          url: request.url,
          headers: authed,
        });
        samples.push({
          millis: performance.now() - at,
          status: response.statusCode,
          label: request.label,
        });
      }),
    );
  }

  const elapsed = (performance.now() - started) / 1000;
  const failures = samples.filter((sample) => sample.status >= 400);

  const byLabel = new Map<string, number[]>();
  for (const sample of samples) {
    const list = byLabel.get(sample.label) ?? [];
    list.push(sample.millis);
    byLabel.set(sample.label, list);
  }

  console.warn(
    `${pad('Endpoint', 30)}${padLeft('n', 6)}${padLeft('p50', 9)}${padLeft('p95', 9)}` +
      `${padLeft('p99', 9)}${padLeft('max', 9)}`,
  );
  console.warn('-'.repeat(72));

  for (const [label, times] of [...byLabel].sort()) {
    const sorted = [...times].sort((a, b) => a - b);
    console.warn(
      pad(label, 30) +
        padLeft(String(sorted.length), 6) +
        padLeft(percentile(sorted, 50).toFixed(1), 9) +
        padLeft(percentile(sorted, 95).toFixed(1), 9) +
        padLeft(percentile(sorted, 99).toFixed(1), 9) +
        padLeft((sorted[sorted.length - 1] as number).toFixed(1), 9),
    );
  }

  const allSorted = samples.map((sample) => sample.millis).sort((a, b) => a - b);
  const throughput = samples.length / elapsed;

  console.warn(
    `\n${samples.length} requests in ${elapsed.toFixed(2)}s — ` +
      `${throughput.toFixed(0)} req/s, p95 ${percentile(allSorted, 95).toFixed(1)}ms, ` +
      `${failures.length} failed`,
  );

  /* -------------------------------------------------------------------- */
  /* Concurrent writes to one record                                       */
  /* -------------------------------------------------------------------- */

  // Two people editing the same lease at the same moment.
  //
  // Both paths are exercised. A write that carries the version it read is
  // protected: exactly one of a simultaneous pair may win, and the loser is
  // told. A write that carries no version is the deliberate opt-out bulk import
  // needs, and stays last-write-wins.
  const leases = (await app
    .inject({
      method: 'GET',
      url: `/api/v1/models/${modelId}/leases`,
      headers: authed,
    })
    .then((response) => response.json())) as {
    leases: Array<{ code: string; tenant_id: string; area: string; version: number }>;
  };
  const lease = leases.leases[0];

  let writeProblems = 0;
  if (lease) {
    const write = (rent: number, expectedVersion?: number) =>
      (app as FastifyInstance).inject({
        method: 'PUT',
        url: `/api/v1/models/${modelId}/leases/${encodeURIComponent(lease.code)}`,
        headers: authed,
        payload: {
          tenantId: lease.tenant_id,
          status: 'occupied',
          area: lease.area,
          spaceIds: [],
          commencementDate: '2026-01-01',
          expirationDate: '2031-12-31',
          baseRent: String(rent),
          baseRentBasis: 'per_area_per_year',
          ...(expectedVersion === undefined ? {} : { expectedVersion }),
        },
      });

    const unguarded = await Promise.all(Array.from({ length: 10 }, (_, i) => write(20 + i)));
    const unguardedAccepted = unguarded.filter((r) => r.statusCode < 400).length;

    const version = (
      (await app
        .inject({ method: 'GET', url: `/api/v1/models/${modelId}/leases`, headers: authed })
        .then((r) => r.json())) as { leases: Array<{ code: string; version: number }> }
    ).leases.find((entry) => entry.code === lease.code)?.version as number;

    const guarded = await Promise.all(Array.from({ length: 10 }, (_, i) => write(40 + i, version)));
    const guardedAccepted = guarded.filter((r) => r.statusCode < 400).length;
    const conflicts = guarded.filter((r) => r.statusCode === 409).length;

    console.warn(
      `\n10 concurrent writes with no version:   ${unguardedAccepted} accepted ` +
        '(deliberate last-write-wins, what bulk import uses)',
    );
    console.warn(
      `10 concurrent writes at one version:   ${guardedAccepted} accepted, ` +
        `${conflicts} refused as stale`,
    );

    if (unguardedAccepted !== 10) writeProblems += 1;
    // Exactly one may win. More than one means an edit was silently lost.
    if (guardedAccepted !== 1 || conflicts !== 9) writeProblems += 1;
  }

  /* -------------------------------------------------------------------- */
  /* Verdict                                                               */
  /* -------------------------------------------------------------------- */

  const P95_BUDGET = Number(process.env.P95_BUDGET ?? 750);
  const problems: string[] = [];
  if (failures.length > 0) {
    const sample = failures[0] as Sample;
    problems.push(
      `${failures.length} of ${samples.length} reads failed under load ` +
        `(first: ${sample.label} returned ${sample.status})`,
    );
  }
  if (writeProblems > 0) {
    problems.push(
      'concurrent writes to one lease did not behave as specified: exactly one ' +
        'version-guarded write must win and the rest must be refused',
    );
  }
  const p95 = percentile(allSorted, 95);
  if (p95 > P95_BUDGET) {
    problems.push(`p95 was ${p95.toFixed(0)}ms against a ${P95_BUDGET}ms budget`);
  }

  console.warn(
    '\nMeasured in-process against a local PostgreSQL, so this isolates the\n' +
      'server and its connection pool from the network. Absolute numbers are not\n' +
      'portable; the error count and the shape of the tail are.',
  );

  if (problems.length > 0) {
    console.error('\nProblems under concurrent load:');
    for (const problem of problems) console.error(`  - ${problem}`);
    process.exitCode = 1;
  } else {
    console.warn('\nNo request failed, and the tail stayed inside budget.');
  }
} finally {
  await app?.close();
  await dropDatabase();
  await admin.end({ timeout: 5 });
}

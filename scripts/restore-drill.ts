/**
 * Backup and restore drill.
 *
 * A backup nobody has restored is a hope, not a backup. This takes a real
 * `pg_dump`, restores it into a scratch database, and then asks the only
 * question that actually matters for this platform:
 *
 *   **does a stored valuation still reproduce from the restored data?**
 *
 * Row counts prove the rows travelled. They do not prove the backup preserved
 * enough to defend a number to an investment committee. So the drill reads a
 * `model_versions.input` out of the *restored* database, runs it through the
 * engine, and compares the output against the `calculation_runs.result` that
 * was stored before the dump was taken. The expected value is therefore not
 * produced by this script — it was produced by a different process, at an
 * earlier time, and merely survived.
 *
 *   pnpm drill:restore
 *   DATABASE_URL=… pnpm drill:restore
 *
 * The scratch database is dropped on the way out, including after a failure.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ENGINE_VERSION, calculate } from '../packages/calculation-engine/src/index.js';
import { createDatabase } from '../packages/database/src/index.js';
import type { ModelInput, ModelResult } from '../packages/domain-models/src/index.js';

const SOURCE_URL = process.env.DATABASE_URL ?? 'postgres://cre:cre@127.0.0.1:5432/cre_platform';

/** Tables whose row counts must survive the round trip exactly. */
const COUNTED_TABLES = [
  'organizations',
  'users',
  'memberships',
  'properties',
  'spaces',
  'tenants',
  'leases',
  'lease_rent_steps',
  'models',
  'model_versions',
  'calculation_runs',
  'audit_log',
];

interface Failure {
  check: string;
  detail: string;
}

const failures: Failure[] = [];
const passed: string[] = [];
const skipped: string[] = [];

function check(name: string, ok: boolean, detail: string): void {
  if (ok) passed.push(name);
  else failures.push({ check: name, detail });
}

function run(command: string, args: string[]): string {
  return execFileSync(command, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

const source = new URL(SOURCE_URL);
const sourceName = decodeURIComponent(source.pathname.replace(/^\//, ''));
const scratchName = `${sourceName}_restore_drill`;

const maintenance = new URL(SOURCE_URL);
maintenance.pathname = '/postgres';

const scratchUrl = new URL(SOURCE_URL);
scratchUrl.pathname = `/${scratchName}`;

const workDir = mkdtempSync(join(tmpdir(), 'cre-restore-drill-'));
const dumpFile = join(workDir, 'cre.dump');

console.warn(`Restore drill\n  source:  ${sourceName}\n  scratch: ${scratchName}\n`);

const admin = createDatabase({ connectionString: maintenance.toString(), maxConnections: 1 });

async function dropScratch(): Promise<void> {
  // Terminate anything still attached, or DROP DATABASE refuses.
  await admin`
    SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = ${scratchName}
  `;
  await admin.unsafe(`DROP DATABASE IF EXISTS "${scratchName}"`);
}

try {
  // -- 1. Back up ------------------------------------------------------------
  run('pg_dump', ['--format=custom', '--file', dumpFile, SOURCE_URL]);
  const dumpBytes = Number(run('stat', ['-c', '%s', dumpFile]).trim());
  check('the dump is non-empty', dumpBytes > 0, `${dumpBytes} bytes`);
  console.warn(`  dump taken: ${(dumpBytes / 1024).toFixed(0)} kB`);

  // -- 2. Restore into a clean database --------------------------------------
  await dropScratch();
  await admin.unsafe(`CREATE DATABASE "${scratchName}"`);
  run('pg_restore', ['--dbname', scratchUrl.toString(), '--no-owner', '--no-privileges', dumpFile]);
  console.warn('  restored into the scratch database');

  const original = createDatabase({ connectionString: SOURCE_URL, maxConnections: 2 });
  const restored = createDatabase({ connectionString: scratchUrl.toString(), maxConnections: 2 });

  try {
    // -- 3. The migration chain survived intact ------------------------------
    const migrationsOf = async (sql: ReturnType<typeof createDatabase>): Promise<string> => {
      const rows = (await sql`
        SELECT name, checksum FROM schema_migrations ORDER BY name
      `) as unknown as Array<{ name: string; checksum: string }>;
      return rows.map((row) => `${row.name}:${row.checksum}`).join('\n');
    };
    const before = await migrationsOf(original);
    const after = await migrationsOf(restored);
    check(
      'the migration chain and its checksums match',
      before === after && before.length > 0,
      before === after ? `${before.split('\n').length} migrations` : 'checksums differ',
    );

    // -- 4. Every row travelled ---------------------------------------------
    for (const table of COUNTED_TABLES) {
      const countOf = async (sql: ReturnType<typeof createDatabase>): Promise<string> => {
        const rows = (await sql.unsafe(
          `SELECT count(*)::text AS n FROM ${table}`,
        )) as unknown as Array<{ n: string }>;
        return rows[0]?.n ?? 'missing';
      };
      const a = await countOf(original);
      const b = await countOf(restored);
      check(`${table} row count matches`, a === b, `source ${a}, restored ${b}`);
    }

    // -- 5. A stored valuation still reproduces ------------------------------
    // This is the drill's reason for existing. Everything above proves bytes
    // moved; this proves the backup is worth having.
    const candidates = (await restored`
      SELECT v.id            AS version_id,
             v.input         AS input,
             v.engine_version AS version_engine,
             r.result        AS result,
             r.engine_version AS run_engine
      FROM model_versions v
      JOIN calculation_runs r ON r.model_version_id = v.id
      WHERE r.status = 'succeeded' AND r.result IS NOT NULL
      ORDER BY r.created_at
    `) as unknown as Array<{
      version_id: string;
      input: ModelInput;
      version_engine: string;
      result: ModelResult;
      run_engine: string;
    }>;

    check(
      'the restored database holds at least one calculated version',
      candidates.length > 0,
      `${candidates.length} version/run pairs`,
    );

    let reproducible = 0;
    for (const candidate of candidates) {
      const stored = candidate.result;

      if (stored.engineVersion !== candidate.run_engine) {
        check(
          `version ${candidate.version_id}: stored result names its engine`,
          false,
          `result says ${stored.engineVersion}, row says ${candidate.run_engine}`,
        );
        continue;
      }

      // A result produced by a different engine version is not expected to
      // reproduce — that is what a major version bump means. Reporting it as a
      // failed restore would blame the backup for a deliberate change in the
      // engine, so it is counted and skipped instead. The stored result remains
      // the record of what was concluded at the time, which is why it is kept.
      if (stored.engineVersion !== ENGINE_VERSION) {
        skipped.push(
          `${candidate.version_id}: calculated by engine ${stored.engineVersion}, this build is ${ENGINE_VERSION}`,
        );
        continue;
      }
      reproducible += 1;

      // Recalculate from the restored input, pinning the timestamp so the
      // comparison is of financial content and not of when it was run.
      const recomputed = calculate(candidate.input, { calculatedAt: stored.calculatedAt });

      // The trace is stored separately and deliberately emptied on the run row,
      // so it is not part of what a restore has to reproduce.
      const normalise = (result: ModelResult): string => canonical({ ...result, trace: [] });

      const same = normalise(recomputed) === normalise(stored);
      check(
        `version ${candidate.version_id} recalculates to its stored result`,
        same,
        same
          ? `engine ${recomputed.engineVersion}, ${recomputed.annual.length} fiscal years`
          : firstDifference(normalise(stored), normalise(recomputed)),
      );
    }

    // A backup full of results this engine can no longer reproduce has not
    // demonstrated anything, however many rows survived.
    check(
      'at least one stored valuation was reproducible on this engine version',
      reproducible > 0,
      `${reproducible} of ${candidates.length} at engine ${ENGINE_VERSION}`,
    );
  } finally {
    await original.end({ timeout: 5 });
    await restored.end({ timeout: 5 });
  }
} finally {
  await dropScratch();
  await admin.end({ timeout: 5 });
  rmSync(workDir, { recursive: true, force: true });
}

/**
 * Serialises with object keys in a fixed order.
 *
 * PostgreSQL's `jsonb` does not preserve key insertion order — it stores keys
 * sorted by length and then bytewise — so a result that has been through the
 * database has the same content in a different textual order than one the
 * engine has just produced. Comparing raw `JSON.stringify` output would report
 * a difference on every single record and prove nothing. Array order is left
 * alone, because in a cash flow the order of periods is the meaning.
 */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonical(entry)}`);
    return `{${entries.join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

/** Points at where two serialised results diverge, rather than printing both. */
function firstDifference(expected: string, actual: string): string {
  let index = 0;
  while (index < expected.length && index < actual.length && expected[index] === actual[index]) {
    index += 1;
  }
  const window = 90;
  const from = Math.max(0, index - window / 2);
  return (
    `diverges at character ${index}\n` +
    `      stored:     …${expected.slice(from, from + window)}…\n` +
    `      recomputed: …${actual.slice(from, from + window)}…`
  );
}

console.warn(`\n${passed.length} check(s) passed.`);
if (skipped.length > 0) {
  console.warn(`${skipped.length} stored result(s) skipped as a different engine version:`);
  for (const entry of skipped) console.warn(`  - ${entry}`);
}
if (failures.length > 0) {
  console.error(`\n${failures.length} check(s) FAILED:`);
  for (const failure of failures) console.error(`  - ${failure.check}: ${failure.detail}`);
  console.error('\nThe backup cannot be relied on until these pass.');
  process.exit(1);
}
console.warn('The backup restores, and a stored valuation reproduces from it.');

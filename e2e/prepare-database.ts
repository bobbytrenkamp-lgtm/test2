/**
 * Prepares the end-to-end database.
 *
 * The suite asserts on specific figures from the demonstration seed, so it
 * needs a database in a known state rather than whatever the last run left
 * behind. This creates the database if it is absent, drops and rebuilds its
 * schema from the migrations, and seeds it — every time, so a failure is a real
 * regression and never yesterday's leftover row.
 *
 * It refuses to touch a database whose name does not mark it as the end-to-end
 * one. Dropping a schema is not something to get almost right.
 */
import { rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDatabase, migrate, resetSchema } from '../packages/database/src/index.js';
import { seedDemonstrationData } from '../packages/database/src/seed.js';

const url = process.env.E2E_DATABASE_URL ?? 'postgres://cre:cre@127.0.0.1:5432/cre_platform_e2e';
const parsed = new URL(url);
const databaseName = decodeURIComponent(parsed.pathname.replace(/^\//, ''));

if (!/e2e/i.test(databaseName)) {
  throw new Error(
    `Refusing to rebuild "${databaseName}": this script drops and recreates the public schema, ` +
      'so the database name must contain "e2e" to make the intent unmistakable. ' +
      'Set E2E_DATABASE_URL to a dedicated database.',
  );
}

async function ensureDatabaseExists(): Promise<void> {
  const maintenance = new URL(url);
  maintenance.pathname = '/postgres';
  const admin = createDatabase({ connectionString: maintenance.toString(), maxConnections: 1 });
  try {
    const rows = (await admin`
      SELECT 1 FROM pg_database WHERE datname = ${databaseName}
    `) as unknown as unknown[];
    if (rows.length === 0) {
      // CREATE DATABASE cannot be parameterised, and the name has already been
      // checked against the pattern above.
      await admin.unsafe(`CREATE DATABASE "${databaseName.replace(/"/g, '""')}"`);
      console.warn(`Created database ${databaseName}.`);
    }
  } finally {
    await admin.end({ timeout: 5 });
  }
}

await ensureDatabaseExists();

// Sessions cached by a previous run point at rows that are about to be dropped.
rmSync(join(dirname(fileURLToPath(import.meta.url)), '.auth'), { recursive: true, force: true });

const sql = createDatabase({ connectionString: url, maxConnections: 4 });
try {
  await resetSchema(sql);
  const { applied } = await migrate(sql);
  const seeded = await seedDemonstrationData(sql);
  console.warn(
    `End-to-end database ready: ${applied.length} migration(s), organization ${seeded.organizationId}.`,
  );
} finally {
  await sql.end({ timeout: 5 });
}

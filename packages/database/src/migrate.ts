import { readFile, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Sql } from './client.js';

/**
 * Migration runner.
 *
 * Migrations are hand-written SQL so that the exact statements applied to a
 * production database are reviewable in the diff. Each file runs inside a
 * transaction and its checksum is recorded, so an edited migration that has
 * already been applied is refused rather than silently ignored.
 */

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations');

export interface AppliedMigration {
  name: string;
  checksum: string;
  applied_at: Date;
}

async function ensureMigrationsTable(sql: Sql): Promise<void> {
  await sql`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name       text PRIMARY KEY,
      checksum   text NOT NULL,
      applied_at timestamptz NOT NULL DEFAULT now()
    )
  `;
}

export async function listMigrationFiles(dir = MIGRATIONS_DIR): Promise<string[]> {
  const entries = await readdir(dir);
  return entries.filter((name) => name.endsWith('.sql')).sort();
}

export interface MigrateResult {
  applied: string[];
  skipped: string[];
}

export async function migrate(sql: Sql, dir = MIGRATIONS_DIR): Promise<MigrateResult> {
  await ensureMigrationsTable(sql);
  const files = await listMigrationFiles(dir);
  const existing = (await sql`
    SELECT name, checksum FROM schema_migrations
  `) as unknown as Array<{ name: string; checksum: string }>;
  const byName = new Map(existing.map((row) => [row.name, row.checksum]));

  const applied: string[] = [];
  const skipped: string[] = [];

  for (const file of files) {
    const contents = await readFile(join(dir, file), 'utf8');
    const checksum = createHash('sha256').update(contents).digest('hex');
    const previous = byName.get(file);

    if (previous) {
      if (previous !== checksum) {
        throw new Error(
          `Migration ${file} has already been applied but its contents have changed. ` +
            'Add a new migration instead of editing an applied one.',
        );
      }
      skipped.push(file);
      continue;
    }

    await sql.begin(async (tx) => {
      await tx.unsafe(contents);
      await tx`
        INSERT INTO schema_migrations (name, checksum) VALUES (${file}, ${checksum})
      `;
    });
    applied.push(file);
  }

  return { applied, skipped };
}

/** Drops and recreates the public schema. Test and local development only. */
export async function resetSchema(sql: Sql): Promise<void> {
  if (process.env.NODE_ENV === 'production') {
    throw new Error('resetSchema must never run against a production database.');
  }
  await sql.unsafe('DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public;');
}

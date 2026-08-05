#!/usr/bin/env node
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Refuses a migration that would break a rollback.
 *
 * The deployment guide says rollback works by redeploying the previous images
 * and leaving the schema in place, because "migrations are backward compatible
 * by policy". That was a policy with nothing enforcing it. One `DROP COLUMN`
 * and the rollback stops working — the previous release starts selecting a
 * column that is no longer there — and nobody finds out until the day they need
 * to roll back, which is the worst possible day to find out.
 *
 * So the policy is a gate. A migration may add; it may not remove or narrow
 * anything the previous release still reads or writes.
 *
 * ## The escape hatch
 *
 * Sometimes a destructive change is genuinely right — dropping a column no
 * release still references, after the release that stopped using it has shipped
 * everywhere. That is a two-step dance and it is fine, but it has to be a
 * decision rather than an accident, so it requires an explicit marker naming
 * the release that stopped using the thing:
 *
 *   -- rollback-unsafe: <why, and which release stopped using it>
 *
 * The marker does not make the migration safe. It records that somebody
 * considered the rollback and accepted the consequence.
 */

const here = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS = join(here, '..', 'packages', 'database', 'migrations');

/**
 * Patterns that break a rollback, and why.
 *
 * Deliberately matched on statement shape rather than parsed: a parser would be
 * more precise and would also be a dependency, and the shapes below are the
 * ones a hand-written migration actually takes.
 */
const DESTRUCTIVE = [
  {
    pattern: /\bDROP\s+TABLE\b/i,
    reason: 'drops a table the previous release may still read',
  },
  {
    pattern: /\bDROP\s+COLUMN\b/i,
    reason: 'drops a column the previous release may still select or insert',
  },
  {
    pattern: /\bALTER\s+TABLE\s+\S+\s+RENAME\b/i,
    reason: 'renames a table, which the previous release cannot find',
  },
  {
    pattern: /\bRENAME\s+COLUMN\b/i,
    reason: 'renames a column, which the previous release cannot find',
  },
  {
    pattern: /\bDROP\s+(?:NOT\s+NULL|DEFAULT)\b/i,
    reason: 'relaxes a constraint the previous release relies on',
  },
  {
    // A NOT NULL added without a default rejects the previous release's inserts.
    pattern: /\bADD\s+COLUMN\b(?![^;]*\bDEFAULT\b)[^;]*\bNOT\s+NULL\b/i,
    reason: 'adds a NOT NULL column with no default, so the previous release cannot insert',
  },
  {
    pattern: /\bSET\s+NOT\s+NULL\b/i,
    reason: 'makes an existing column NOT NULL, rejecting rows the previous release still writes',
  },
  {
    // An index is a performance artefact and the previous release runs without
    // it, so dropping one is not listed. A constraint is different: dropping a
    // UNIQUE lets in duplicates the previous release assumes cannot exist.
    pattern: /\bDROP\s+CONSTRAINT\b/i,
    reason: 'drops a constraint the previous release assumes is enforced',
  },
];

const MARKER = /--\s*rollback-unsafe:\s*\S/i;

const files = readdirSync(MIGRATIONS)
  .filter((name) => name.endsWith('.sql'))
  .sort();

let failures = 0;
let accepted = 0;

for (const file of files) {
  const sql = readFileSync(join(MIGRATIONS, file), 'utf8');
  // Comments carry the reasoning in this codebase and would otherwise trip
  // every pattern that appears in an explanation of why it was avoided.
  const statements = sql.replace(/--[^\n]*/g, '');
  const acknowledged = MARKER.test(sql);

  for (const { pattern, reason } of DESTRUCTIVE) {
    if (!pattern.test(statements)) continue;
    if (acknowledged) {
      accepted += 1;
      console.warn(`  ${file}: ${reason} — accepted by an explicit rollback-unsafe marker`);
      continue;
    }
    failures += 1;
    console.error(`\n${file}`);
    console.error(`  ${reason}.`);
    console.error(
      '  A rollback redeploys the previous release against this schema, so this would break it.',
    );
    console.error(
      '  Either make the change additive, or add a marker recording the decision:\n' +
        '      -- rollback-unsafe: <why, and which release stopped using it>',
    );
  }
}

console.warn(`\nChecked ${files.length} migration(s) for rollback safety.`);
if (accepted > 0) {
  console.warn(`${accepted} destructive change(s) accepted by an explicit marker.`);
}

if (failures > 0) {
  console.error(
    `\n${failures} migration issue(s) would break a rollback. See docs/deployment-guide.md.`,
  );
  process.exit(1);
}

console.warn('Every migration leaves the previous release able to run against this schema.');

#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Refuses documentation that has drifted from the code.
 *
 * `docs/testing-strategy.md` states, per suite, how many tests it holds, and
 * `docs/feature-status.md` opens with a verification block reporting the totals.
 * Both are written by hand, and both went stale repeatedly: at one point the
 * strategy claimed 164 regression tests against 202 real ones, and the status
 * page described a 23-test browser suite that had grown to 50.
 *
 * A number nobody checks is a number that is wrong, and a document that is
 * wrong about the easily checkable parts earns no trust on the parts nobody can
 * check. The standing rule says documentation is updated in the same commit as
 * the behaviour it describes; this is what makes that rule cost something to
 * break.
 *
 * ## What it can and cannot see
 *
 * It compares counts, because counts are mechanically checkable. It cannot tell
 * whether a row marked "Tested" describes what the tests actually assert, or
 * whether prose about a feature is true. Those still need a reader. This closes
 * the gap that kept reopening, not every gap.
 *
 * Tests are enumerated, never executed: `vitest list` and `playwright --list`
 * both report what exists without running it, so this stays cheap enough to sit
 * in front of the suite rather than after it.
 *
 * Database-backed suites are skipped by `describe.skipIf(!hasDatabase)` and are
 * therefore invisible to `vitest list` without a DATABASE_URL. Rather than
 * silently compare against a short list, the check says it is comparing a
 * subset and exempts the totals.
 */

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');

const hasDatabase = Boolean(process.env.DATABASE_URL);

const read = (name) => readFileSync(join(root, 'docs', name), 'utf8');

/** Runs a command and returns stdout, or null if it could not be run. */
function capture(command, args) {
  try {
    return execFileSync(command, args, {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      maxBuffer: 32 * 1024 * 1024,
    });
  } catch {
    return null;
  }
}

/* -------------------------------------------------------------------------- */
/* What the code actually holds                                               */
/* -------------------------------------------------------------------------- */

function actualUnitTests() {
  const output = capture('npx', ['vitest', 'list']);
  if (output === null) return null;
  const perFile = new Map();
  let total = 0;
  for (const line of output.split('\n')) {
    const [file] = line.split(' > ');
    if (!file || !file.endsWith('.test.ts')) continue;
    perFile.set(file, (perFile.get(file) ?? 0) + 1);
    total += 1;
  }
  return { perFile, total };
}

function actualBrowserTests() {
  const output = capture('npx', ['playwright', 'test', '--list', '--reporter=line']);
  if (output === null) return null;
  const perFile = new Map();
  let total = 0;
  for (const line of output.split('\n')) {
    // "  [chromium] › underwriting.spec.ts:152:3 › ..." — the project tag
    // varies (setup vs chromium) and is not what is being counted.
    const match = /›\s+([\w.-]+\.(?:spec|setup)\.ts):\d+/.exec(line);
    if (!match) continue;
    const file = match[1];
    perFile.set(file, (perFile.get(file) ?? 0) + 1);
    total += 1;
  }
  return { perFile, total };
}

/* -------------------------------------------------------------------------- */
/* What the documentation claims                                              */
/* -------------------------------------------------------------------------- */

/**
 * Rows of the form `| … | \`path/to/file.ts\` | 42 | … |`.
 *
 * Matched on the backticked path rather than on column position, so reordering
 * or adding a column to those tables does not quietly stop the check working.
 */
function claimedCounts(markdown) {
  const claims = new Map();
  const row = /\|[^|\n]*\|\s*`([^`]+\.(?:test|spec|setup)\.ts)`\s*\|\s*(\d+)\s*\|/g;
  let match;
  while ((match = row.exec(markdown)) !== null) {
    claims.set(match[1], Number(match[2]));
  }
  return claims;
}

function claimedTotal(markdown, pattern) {
  const match = pattern.exec(markdown);
  return match ? Number(match[1]) : null;
}

/* -------------------------------------------------------------------------- */

const problems = [];
const note = (message) => problems.push(message);

const strategy = read('testing-strategy.md');
const status = read('feature-status.md');

const unit = actualUnitTests();
const browser = actualBrowserTests();

if (unit === null) {
  note('Could not enumerate the unit tests (`vitest list` failed). Nothing was checked.');
}
if (browser === null) {
  note('Could not enumerate the browser tests (`playwright test --list` failed).');
}

const claims = claimedCounts(strategy);

if (unit && browser) {
  for (const [path, claimed] of claims) {
    const file = path.split('/').pop();
    // A unit suite is claimed by its full path; a browser suite by `e2e/x.spec.ts`.
    const isBrowser = path.startsWith('e2e/');
    const found = isBrowser ? browser.perFile.get(file) : unit.perFile.get(path);

    if (found === undefined) {
      // A database suite is invisible without a DATABASE_URL, which is not drift.
      if (!isBrowser && !hasDatabase) continue;
      note(`docs/testing-strategy.md lists \`${path}\`, which holds no tests (or does not exist).`);
      continue;
    }
    if (found !== claimed) {
      note(
        `docs/testing-strategy.md says \`${path}\` holds ${claimed} test(s); it holds ${found}.`,
      );
    }
  }
}

/*
 * Totals. Only checked with a database, because without one the unit list is a
 * subset and every total would fail for a reason that is not drift.
 */
if (unit && browser && hasDatabase) {
  const totals = [
    {
      label: 'docs/testing-strategy.md total tests',
      claimed: claimedTotal(strategy, /\*\*(\d+) tests in total\.\*\*/),
      actual: unit.total,
    },
    {
      label: 'docs/testing-strategy.md total browser tests',
      claimed: claimedTotal(strategy, /\*\*(\d+) browser tests in total\*\*/),
      actual: browser.total,
    },
    {
      label: 'docs/feature-status.md verification block, tests',
      claimed: claimedTotal(status, /^Tests\s+(\d+) passed/m),
      actual: unit.total,
    },
    {
      label: 'docs/feature-status.md verification block, browser tests',
      claimed: claimedTotal(status, /^Browser\s+(\d+) passed/m),
      actual: browser.total,
    },
  ];

  for (const { label, claimed, actual } of totals) {
    if (claimed === null) {
      note(`${label}: could not find the figure to check. Has the wording changed?`);
    } else if (claimed !== actual) {
      note(`${label} says ${claimed}; there are ${actual}.`);
    }
  }

  // The two documents also have to agree with each other, which they can fail
  // to do even when each is individually checkable.
  const combined = claimedTotal(strategy, /for (\d+) across the whole repository/);
  if (combined !== null && combined !== unit.total + browser.total) {
    note(
      `docs/testing-strategy.md says ${combined} tests across the repository; ` +
        `${unit.total} + ${browser.total} = ${unit.total + browser.total}.`,
    );
  }
}

if (problems.length > 0) {
  console.error('\nDocumentation does not match the code:\n');
  for (const problem of problems) console.error(`  - ${problem}`);
  console.error(
    '\nUpdate the documentation in the same change as the behaviour, which is the\n' +
      'standing rule in docs/implementation-roadmap.md. A document that is wrong\n' +
      'about its own test counts earns no trust on the parts nobody can check.\n',
  );
  process.exit(1);
}

console.warn(
  `Documentation matches the code: ${claims.size} suite count(s) checked` +
    (hasDatabase
      ? `, and the totals agree (${unit.total} tests, ${browser.total} browser tests).`
      : '. Totals were not checked — set DATABASE_URL to include the database suites.'),
);

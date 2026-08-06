#!/usr/bin/env node
/**
 * Prepares a working copy of the platform, from nothing to a running sign-in.
 *
 * The quick start in the README is four commands that each assume the previous
 * one left the machine in the right state. On a fresh PostgreSQL install it
 * does not: `.env.example` connects as a role named `cre`, and nothing in this
 * repository ever creates that role, so `pnpm db:migrate` dies with
 * `password authentication failed for user "cre"` — a message that says
 * nothing about the fact that the account simply does not exist yet.
 *
 * This script closes that gap. It checks the prerequisites, writes a `.env`
 * with a real secret, creates the role and the database if they are missing,
 * migrates, seeds, and prints the credentials to sign in with.
 *
 *   pnpm start       # prepare everything, then run it
 *   pnpm bootstrap   # prepare only, without starting
 *
 * It is deliberately **not** called `setup`. `pnpm setup` is a built-in pnpm
 * command that configures pnpm's own install directory, and it wins over a
 * script of the same name — so `pnpm setup` would silently do something else
 * entirely and never touch this file. Found by running it.
 *
 * ## Rules it follows
 *
 * It is **idempotent**: every step checks before it acts, so running it twice
 * is not an error and the second run does almost nothing.
 *
 * It **never overwrites your `.env`**. If one exists it is read, not replaced,
 * even when the values in it look wrong — the script says what looks wrong and
 * leaves the file alone.
 *
 * It **never seeds over existing data**. Demonstration data is only created
 * into an empty database, so a database you have been working in is safe.
 *
 * It **stops rather than guessing** when it cannot do something itself. Where
 * provisioning needs a PostgreSQL superuser it cannot reach, it prints the
 * exact SQL to run and exits, instead of failing somewhere further along where
 * the cause is no longer visible.
 *
 * No dependency beyond Node's own modules and the `psql` client that ships
 * with PostgreSQL, because it has to run before `pnpm install` has necessarily
 * finished being useful.
 */

import { execFileSync, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { copyFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
// URL is a global at runtime, but imported explicitly so the lint configuration
// for .mjs files does not have to assume which globals Node provides.
import { URL, fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const envPath = join(root, '.env');
const examplePath = join(root, '.env.example');

const MINIMUM_NODE = [20, 11];

/** Steps report through these so the transcript reads the same throughout. */
const say = (message) => console.warn(message);
const step = (message) => console.warn(`\n▸ ${message}`);
const ok = (message) => console.warn(`  ✓ ${message}`);
const note = (message) => console.warn(`  · ${message}`);

class SetupError extends Error {
  /** @param {string} message @param {string[]} [remedy] */
  constructor(message, remedy = []) {
    super(message);
    this.remedy = remedy;
  }
}

/* ------------------------------------------------------------------ *
 * Prerequisites
 * ------------------------------------------------------------------ */

function checkNode() {
  const [major, minor] = process.versions.node.split('.').map(Number);
  const [wantMajor, wantMinor] = MINIMUM_NODE;
  if (major < wantMajor || (major === wantMajor && minor < wantMinor)) {
    throw new SetupError(
      `Node ${process.versions.node} is too old; this needs ${wantMajor}.${wantMinor} or newer.`,
      ['Install Node 22 from https://nodejs.org (the LTS download), then run this again.'],
    );
  }
  ok(`Node ${process.versions.node}`);
}

function checkPsql() {
  const result = spawnSync('psql', ['--version'], { encoding: 'utf8' });
  if (result.error || result.status !== 0) {
    throw new SetupError('PostgreSQL’s `psql` client is not on your PATH.', [
      'PostgreSQL 16 or newer needs to be installed and running. Then re-run `pnpm bootstrap`.',
      '',
      '  macOS      brew install postgresql@16 && brew services start postgresql@16',
      '  Ubuntu     sudo apt install postgresql-16 && sudo systemctl start postgresql',
      '  Windows    https://www.postgresql.org/download/windows/  (the installer adds psql to PATH)',
      '',
      'Postgres.app on macOS also works — https://postgresapp.com — but remember to',
      'add its bin directory to PATH so `psql` is found.',
    ]);
  }
  ok(result.stdout.trim());
}

/* ------------------------------------------------------------------ *
 * Environment file
 * ------------------------------------------------------------------ */

function generateSecret() {
  return randomBytes(48).toString('base64url');
}

/**
 * Writes `.env` if it is absent, and reports on it either way.
 *
 * An existing file is never rewritten. Someone who has pointed this at their
 * own database, or changed a port, should not have that undone by a setup
 * script — so a placeholder secret is reported as something to fix rather than
 * quietly fixed.
 */
function ensureEnv() {
  if (existsSync(envPath)) {
    ok('.env already exists — left exactly as it is');
    const contents = readFileSync(envPath, 'utf8');
    if (/^SESSION_SECRET=change-me/m.test(contents)) {
      note('SESSION_SECRET is still the placeholder. Replace it before this leaves your machine:');
      note(`    SESSION_SECRET=${generateSecret()}`);
    }
    return contents;
  }

  if (!existsSync(examplePath)) {
    throw new SetupError('Neither .env nor .env.example is present; cannot configure anything.');
  }

  copyFileSync(examplePath, envPath);
  const configured = readFileSync(envPath, 'utf8').replace(
    /^SESSION_SECRET=.*$/m,
    `SESSION_SECRET=${generateSecret()}`,
  );
  writeFileSync(envPath, configured);
  ok('.env created from .env.example, with a freshly generated SESSION_SECRET');
  note('.env is gitignored and must never be committed.');
  return configured;
}

/** @param {string} contents */
function readDatabaseUrl(contents) {
  const match = /^DATABASE_URL=(.+)$/m.exec(contents);
  if (!match) {
    throw new SetupError('.env has no DATABASE_URL line, so there is nothing to connect to.');
  }
  const raw = match[1].trim().replace(/^["']|["']$/g, '');
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    throw new SetupError(`DATABASE_URL in .env is not a valid URL: ${raw}`);
  }
  return {
    url: raw,
    user: decodeURIComponent(parsed.username) || 'postgres',
    password: decodeURIComponent(parsed.password),
    host: parsed.hostname || 'localhost',
    port: parsed.port || '5432',
    database: parsed.pathname.replace(/^\//, '') || 'postgres',
  };
}

/* ------------------------------------------------------------------ *
 * Database provisioning
 * ------------------------------------------------------------------ */

/**
 * Runs one statement, returning stdout or `null` if it did not succeed.
 *
 * `null` is deliberately not an exception: most callers here are *probing*,
 * and a refused connection is an expected answer rather than a fault.
 *
 * `-w` is not optional. Without it `psql` prompts on the terminal —
 * `Password for user root:` — and a script that is meant to run unattended
 * stops dead waiting for input that will never come. With it, a connection
 * needing a password fails immediately and the next candidate is tried.
 *
 * @param {{command: string, args: string[]}} via @param {string} sql
 */
function psql(via, sql) {
  const result = spawnSync(via.command, [...via.args, '-w', '-tAX', '-c', sql], {
    encoding: 'utf8',
    env: { ...process.env, PGCONNECT_TIMEOUT: '5' },
  });
  if (result.error || result.status !== 0) return null;
  return result.stdout.trim();
}

/** @param {ReturnType<typeof readDatabaseUrl>} db */
function canConnect(db) {
  return psql({ command: 'psql', args: [db.url] }, 'select 1') === '1';
}

/**
 * Finds a connection with rights to create a role and a database.
 *
 * The routes are ordered by how a developer machine is usually set up. Two of
 * them go over the Unix socket rather than TCP, because that is where peer
 * authentication lives: on a Linux package install the `postgres` role is
 * reachable as the `postgres` system account and by no other means, which is
 * why a TCP-only search finds nothing there and reports a working database as
 * unreachable.
 *
 * `sudo -n` never prompts, for the same reason `psql -w` never prompts.
 *
 * @param {ReturnType<typeof readDatabaseUrl>} db
 */
function findSuperuser(db) {
  const me = process.env.USER ?? process.env.USERNAME ?? 'your account';
  const tcp = ['-h', db.host, '-p', db.port, '-d', 'postgres'];
  const candidates = [
    // Homebrew and Postgres.app make the logged-in user a superuser.
    { label: `${me} over TCP`, command: 'psql', args: tcp },
    { label: 'the postgres role over TCP', command: 'psql', args: [...tcp, '-U', 'postgres'] },
  ];

  /*
   * Socket routes are only offered for a local server, and always carry the
   * port from DATABASE_URL.
   *
   * Both halves of that are load-bearing, and the second was a real bug. A
   * socket connection with no `-p` goes to whatever server owns the default
   * socket, which need not be the one the connection string names. Pointed at
   * port 5499 with a server on 5432, the script "found" a superuser, reported
   * the role and database as already present, and then failed to connect —
   * blaming `pg_hba.conf` for what was really nothing listening on 5499. It
   * had inspected a different server than the one it was asked about.
   */
  if (['localhost', '127.0.0.1', '::1', ''].includes(db.host)) {
    const socket = ['-p', db.port, '-d', 'postgres'];
    // Peer authentication over the Unix socket — no -h.
    candidates.push({ label: `${me} over the local socket`, command: 'psql', args: socket });
    // The standard route on a Linux package install.
    candidates.push({
      label: 'the postgres system account (sudo)',
      command: 'sudo',
      args: ['-n', '-u', 'postgres', 'psql', ...socket],
    });
  }

  for (const candidate of candidates) {
    const answer = psql(candidate, 'select current_user');
    if (answer) return { ...candidate, currentUser: answer };
  }
  return null;
}

/**
 * Creates the role and database the connection string names, if missing.
 *
 * @param {ReturnType<typeof readDatabaseUrl>} db
 */
function provision(db) {
  const superuser = findSuperuser(db);
  if (!superuser) {
    throw new SetupError(
      `Cannot reach PostgreSQL at ${db.host}:${db.port} with rights to create the database.`,
      [
        'The server may not be running, or may need a password this script cannot supply.',
        '',
        'Check it is running:',
        '  macOS    brew services start postgresql@16',
        '  Ubuntu   sudo systemctl start postgresql',
        '',
        'If it is running and you have a superuser password, run these once yourself',
        'and then re-run `pnpm bootstrap`:',
        '',
        `  CREATE ROLE ${db.user} LOGIN PASSWORD '${db.password}';`,
        `  CREATE DATABASE ${db.database} OWNER ${db.user};`,
        '',
        `(on Linux, usually: sudo -u postgres psql -c "…")`,
      ],
    );
  }
  note(`connected as ${superuser.currentUser} via ${superuser.label}`);

  const roleExists = psql(superuser, `select 1 from pg_roles where rolname = '${db.user}'`) === '1';
  if (roleExists) {
    ok(`role "${db.user}" already exists`);
  } else {
    // Quoted identifier, literal password: the role name is an identifier and
    // the password is a string, and they are not interchangeable.
    const created = psql(
      superuser,
      `CREATE ROLE "${db.user}" LOGIN PASSWORD '${db.password.replace(/'/g, "''")}'`,
    );
    if (created === null) {
      throw new SetupError(`Could not create the role "${db.user}".`, [
        `Run it yourself, then re-run \`pnpm bootstrap\`:`,
        `  CREATE ROLE ${db.user} LOGIN PASSWORD '${db.password}';`,
      ]);
    }
    ok(`role "${db.user}" created`);
  }

  const dbExists =
    psql(superuser, `select 1 from pg_database where datname = '${db.database}'`) === '1';
  if (dbExists) {
    ok(`database "${db.database}" already exists`);
  } else {
    const created = psql(superuser, `CREATE DATABASE "${db.database}" OWNER "${db.user}"`);
    if (created === null) {
      throw new SetupError(`Could not create the database "${db.database}".`, [
        `Run it yourself, then re-run \`pnpm bootstrap\`:`,
        `  CREATE DATABASE ${db.database} OWNER ${db.user};`,
      ]);
    }
    ok(`database "${db.database}" created, owned by "${db.user}"`);
  }
}

/* ------------------------------------------------------------------ *
 * Migrate and seed
 * ------------------------------------------------------------------ */

/** @param {string} script @param {ReturnType<typeof readDatabaseUrl>} db */
function run(script, db) {
  execFileSync('pnpm', ['run', script], {
    cwd: root,
    stdio: 'inherit',
    env: { ...process.env, DATABASE_URL: db.url },
  });
}

/**
 * True when the database already holds an organization.
 *
 * The seed creates rather than upserts, so running it twice would either
 * duplicate the demonstration organization or collide on a unique email. A
 * database with anything in it is left alone.
 *
 * @param {ReturnType<typeof readDatabaseUrl>} db
 */
function alreadySeeded(db) {
  const count = psql({ command: 'psql', args: [db.url] }, 'select count(*) from organizations');
  return count !== null && count !== '0';
}

/**
 * The sign-in addresses already in the database.
 *
 * Read back rather than restated, so this cannot drift from what the seed
 * creates, and so it stays true for a database whose accounts have since been
 * changed. Passwords are not stored in a recoverable form and are not shown.
 *
 * @param {ReturnType<typeof readDatabaseUrl>} db
 */
function existingAccounts(db) {
  const rows = psql(
    { command: 'psql', args: [db.url] },
    'select email from users where is_active order by email limit 10',
  );
  return rows ? rows.split('\n').filter(Boolean) : [];
}

/* ------------------------------------------------------------------ *
 * Main
 * ------------------------------------------------------------------ */

try {
  say('Preparing the CRE platform.\n');

  step('Checking prerequisites');
  checkNode();
  checkPsql();

  step('Configuring the environment');
  const env = ensureEnv();
  const db = readDatabaseUrl(env);
  ok(`database "${db.database}" on ${db.host}:${db.port} as "${db.user}"`);

  step('Preparing the database');
  if (canConnect(db)) {
    ok('connected with the credentials in .env — nothing to create');
  } else {
    note('cannot connect with those credentials yet; checking what is missing');
    provision(db);
    if (!canConnect(db)) {
      throw new SetupError(
        'The role and database exist, but connecting with the credentials in .env still fails.',
        [
          'This usually means PostgreSQL is configured to reject password logins from',
          'this host. Check the `pg_hba.conf` rules for host connections, or point',
          'DATABASE_URL in .env at a connection that does work.',
        ],
      );
    }
    ok('connected');
  }

  step('Applying migrations');
  run('db:migrate', db);

  step('Loading demonstration data');
  let seededNow = false;
  if (alreadySeeded(db)) {
    ok('the database already holds data — not seeding over it');
    note(`To start over from empty: dropdb ${db.database} && pnpm bootstrap`);
  } else {
    run('db:seed', db);
    seededNow = true;
  }

  say('\n────────────────────────────────────────────────────────');
  say('Ready. Start it with:\n');
  say('    pnpm dev\n');
  say('Then open http://localhost:5173 and sign in.');
  if (seededNow) {
    // The seed prints them itself, immediately above this banner.
    say('The credentials are printed above. All that data is fictional.');
  } else {
    // Nothing was printed this run, so pointing at "above" would be a lie.
    // The accounts are read back from the database rather than restated here,
    // so this cannot drift from whatever the seed actually created.
    say('This database was set up earlier, so no credentials were printed');
    const accounts = existingAccounts(db);
    if (accounts.length > 0) {
      say('just now. The accounts that exist are:\n');
      for (const account of accounts) say(`    ${account}`);
    } else {
      say('just now, and no accounts were found to list.');
    }
  }
  say('────────────────────────────────────────────────────────');
} catch (error) {
  if (error instanceof SetupError) {
    console.error(`\n✗ ${error.message}`);
    for (const line of error.remedy) console.error(line ? `  ${line}` : '');
    console.error('');
  } else {
    console.error('\n✗ Setup failed.');
    console.error(error instanceof Error ? error.message : error);
  }
  process.exitCode = 1;
}

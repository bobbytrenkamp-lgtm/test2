# Deployment guide

## Status of this document

Local development on a directly installed PostgreSQL 16 is **verified**:
migrations, seed, the full test suite, the browser suite and the web build were
all run successfully.

Backup and restore is now **drilled** — `pnpm drill:restore` runs a real dump,
a real restore, and confirms a stored valuation reproduces from the restored
data. It runs on every CI build.

The Docker images are **still never built**. The Compose file itself is
validated (`docker compose config` passes), and several defects found by reading
the Dockerfiles have been fixed — a lockfile fallback that silently defeated
`--frozen-lockfile`, a missing workspace manifest that made the frozen install
fail in the first place, and a missing `.dockerignore` that would have copied
host-built `node_modules` over the Alpine ones. But **a review is not a build**.

The blockage has since been diagnosed exactly, which matters because the earlier
wording ("the registry is unreachable") sent the wrong signal. The Docker daemon
runs and the registry API is reachable: `registry-1.docker.io/v2/` answers 401
as it should unauthenticated, and `auth.docker.io/token` answers 200. What is
blocked is the **blob CDN** — `production.cloudfront.docker.com` returns 403,
an egress policy denial from the session's proxy. So manifests resolve and
layers cannot be fetched, and `docker pull node:22-alpine` fails partway with a
403 on the layer download.

That is a single host to allow. Anyone with an environment that permits
`production.cloudfront.docker.com` (or any registry mirror serving the same
images) should run:

```bash
docker compose build && docker compose up
```

and report what breaks. Until then the images are **unbuilt, not merely
untested**, and nothing in this guide about the container path has been
executed.

## Requirements

- Node 20.11 or later (built and tested on 22)
- PostgreSQL 16 or later
- pnpm 9

No paid service, external API or proprietary component is required. The whole
stack runs on locally installed open-source components; see
[`zero-cost-operation.md`](zero-cost-operation.md) for the audit, including how
the CI workflow is configured to stay inside GitHub's free allowance.

## Local development, without Docker (verified)

```bash
pnpm install
pnpm start
```

Open http://localhost:5173 and sign in with the credentials it prints. All
seeded data is fictional.

`pnpm start` runs `scripts/setup.mjs` and then `pnpm dev`. Use `pnpm bootstrap`
to prepare without starting. The name matters: `pnpm setup` is a built-in pnpm
command that configures pnpm's own install directory and takes precedence over
a script of that name, so it would never run this.

### What the script does, and what it refuses to do

It checks Node and `psql`, writes `.env` from `.env.example` with a generated
`SESSION_SECRET`, creates the PostgreSQL role and database named in
`DATABASE_URL` if they are missing, migrates, and seeds.

It is idempotent. It never overwrites an existing `.env` — a placeholder secret
is reported, not silently replaced. It never seeds into a database that already
holds an organization, so a database being worked in is safe. Where it needs a
superuser it cannot reach, it prints the two `CREATE` statements to run and
exits, rather than failing later where the cause is no longer visible.

### The defect it was written for

The previous instructions here were `createdb cre_platform && pnpm db:migrate`.
On a fresh PostgreSQL install that fails: `.env.example` connects as a role
named `cre`, and nothing in this repository has ever created that role. The
error is `password authentication failed for user "cre"`, which describes an
authentication problem rather than a missing account and sends the reader
looking in the wrong place. Anyone following the documented quick start on a
clean machine hit it.

Provisioning searches for a superuser over TCP first, then over the Unix socket
where peer authentication lives — the only route to the `postgres` role on a
Linux package install. Socket routes are offered only for a local host and
always carry the port from `DATABASE_URL`; a socket connection without an
explicit port reaches whatever server owns the default socket, which is not
necessarily the one the connection string names.

## Local development, with Docker (unverified)

```bash
docker compose -f infrastructure/docker-compose.yml up --build
```

Brings up PostgreSQL, the API, the worker and the web client. The API container
runs migrations on start.

## Environment

Validated at startup; the process **refuses to start** if any of these is wrong.

| Variable | Required | Notes |
| --- | --- | --- |
| `DATABASE_URL` | yes | |
| `SESSION_SECRET` | yes | 32+ characters. Rotating it invalidates every session. |
| `NODE_ENV` | | `development`, `test` or `production` |
| `API_PORT`, `API_HOST` | | Default 4000 / 0.0.0.0 |
| `WEB_ORIGIN` | | CORS and CSP origin |
| `SESSION_COOKIE_SECURE` | | **Must be `true` in production** — enforced |
| `ALLOW_SELF_REGISTRATION` | | Set `false` to require invitations |
| `STORAGE_DRIVER`, `STORAGE_LOCAL_DIR` | | `local` by default — uploaded documents (`POST /documents`) are written under `STORAGE_LOCAL_DIR` (`./uploads` by default). `s3` names the interface a real object store would implement, the same way `MAIL_DRIVER=smtp` names a relay this platform does not provision, but nothing implements it yet — **required and enforced at startup**, the same way a missing `SMTP_HOST` is: the process refuses to start with `STORAGE_DRIVER=s3` rather than accepting the setting and failing the first upload. |
| `AI_ASSISTANT_PROVIDER` | | `none` by default; the assistant is disabled |
| `MAIL_DRIVER` | | `console` by default — logs the message instead of sending it, which is why password reset works out of the box in development with nothing configured. Set `smtp` to actually deliver mail. |
| `MAIL_FROM` | | The `From` address on outgoing mail. Defaults to a placeholder that no real deployment should keep. |
| `SMTP_HOST` | when `MAIL_DRIVER=smtp` | **Required and enforced at startup** once `MAIL_DRIVER=smtp` — the process refuses to start without it, the same way a misconfigured `SESSION_COOKIE_SECURE` refuses. This platform bundles no mail relay; point it at one you operate or one you have an account with. |
| `SMTP_PORT`, `SMTP_SECURE`, `SMTP_USER`, `SMTP_PASSWORD` | | Standard SMTP connection settings, passed straight to `nodemailer` |
| `SCAN_DRIVER` | | `none` by default — no upload is scanned, and every import response says so via `scanned: false`. Set `clamav` to scan through a `clamd` daemon (the `docker-compose.yml` `clamav` service, or one you operate). |
| `SCAN_HOST`, `SCAN_PORT` | when `SCAN_DRIVER=clamav` | Default `localhost:3310`. Unlike `SMTP_HOST`, there is no startup check — a `clamd` this deployment cannot reach fails the specific upload (`503 SCANNER_UNAVAILABLE`) rather than the whole server. |
| `CHROMIUM_EXECUTABLE_PATH` | | Read by the worker only, for server-side PDF rendering (`apps/worker/src/pdf.ts`). Unset, `playwright-core` resolves whichever Chromium it already manages itself (the case in local development and this repository's own CI). The production image sets it to `/usr/bin/chromium-browser`, the binary Alpine's own `chromium` package installs, because Playwright's own browser download targets glibc and the image is musl-based. |

Secrets belong in the platform's secret manager. `.env` is git-ignored.

## Production topology

```
            TLS termination / reverse proxy
                        │
        ┌───────────────┼───────────────┐
   static web       API (N)         worker (M)
   (any CDN)           └──────┬──────────┘
                        PostgreSQL (primary + replica)
```

- Serve `apps/web/dist` as static files. **Do not** use GitHub Pages or any
  static host for anything but public documentation or a read-only demo — it
  cannot host authentication, the database, workers, uploads or confidential
  models.
- Run the API behind TLS with `SESSION_COOKIE_SECURE=true`.
- Any number of workers may run; `FOR UPDATE SKIP LOCKED` makes them safe.
- Serve the web client and API from the same hostname so the session cookie is
  first-party.

Nothing is tied to a specific hosting vendor: the platform needs a Node runtime,
a PostgreSQL database, and a place to serve static files.

## Migrations

```bash
pnpm db:migrate
```

Each file runs in a transaction and is checksummed. An already-applied migration
whose contents changed is **refused**, not silently skipped — add a new
migration instead of editing an applied one.

Deploy order: migrate, then release the API and worker. Migrations are written to
be backward compatible with the previous release so a rollback does not need a
down migration — and that is **enforced**, not merely intended:

```bash
pnpm check:migrations
```

It refuses a migration that drops a table or column, renames either, relaxes a
constraint, or adds a `NOT NULL` column without a default. Each of those leaves
the previous release unable to run against the new schema, which is exactly what
a rollback asks it to do. The check runs on every CI build.

A destructive change is sometimes right — dropping a column after the release
that stopped using it has shipped everywhere. That is a two-step dance, and it
has to be a decision rather than an accident, so it needs an explicit marker:

```sql
-- rollback-unsafe: notes was removed in 4.0.0 and no release still reads it.
```

The marker does not make the migration safe. It records that somebody considered
the rollback and accepted the consequence.

## Health and observability

`GET /api/v1/health` returns `{"status":"ok"}` after a successful database round
trip. Point liveness and readiness probes at it.

The worker emits structured JSON logs (`job.succeeded`, `job.failed`,
`jobs.reaped`) carrying job kind, identifier and duration — **never payloads**,
which would contain tenant data.

No error-monitoring provider is wired. `docs/architecture.md` describes where it
would attach.

## Backup and restore (drilled, and drilled in CI)

```bash
pnpm drill:restore                    # against $DATABASE_URL
DATABASE_URL=… pnpm drill:restore     # against a specific database
```

`scripts/restore-drill.ts` takes a real `pg_dump`, restores it into a scratch
database, runs 20 checks, and drops the scratch database again — including after
a failure. It runs on every CI build, so the procedure cannot rot unnoticed.

What it checks, in order of what it actually proves:

1. The dump is non-empty and `pg_restore` completes.
2. The migration chain and every checksum match the source exactly.
3. Row counts match across twelve tables, including `audit_log`.
4. **A stored valuation reproduces.** For every `model_versions` row with a
   succeeded run, the drill reads the stored engine input *out of the restored
   database*, runs it through the engine, and compares the output against the
   `calculation_runs.result` recorded before the dump was taken.

Point 4 is the reason the script exists. Row counts prove the rows travelled;
they do not prove the backup preserved enough to defend a number. The expected
value is not produced by the drill — it was produced by a different process at
an earlier time and merely had to survive.

The comparison is made on a canonical serialisation with object keys sorted.
PostgreSQL's `jsonb` does not preserve key insertion order, so a result that has
been through the database is textually reordered relative to a freshly computed
one. Comparing raw JSON would report a difference on every record and prove
nothing. Array order is left alone: in a cash flow, the order of periods is the
meaning.

Everything needed to reproduce a valuation is in the database: `model_versions`
holds the exact engine input and `calculation_runs` holds the result.

### What the drill found

The seed calculated its models but never froze a version, so `model_versions`
was empty: the demonstration data did not demonstrate versioning, the Versions
tab was blank, and the drill had no stored valuation to reproduce. The seed now
freezes a version per model and calculates against it, which is how the platform
is meant to be used.

## Manual backup and restore

```bash
pg_dump --format=custom --file=cre-$(date +%F).dump "$DATABASE_URL"
createdb cre_restore
pg_restore --dbname="postgres://…/cre_restore" --no-owner --no-privileges cre-2026-08-04.dump
```

## Rollback

1. Redeploy the previous API and worker images.
2. Leave the schema in place. `pnpm check:migrations` gates every build on the
   previous release still being able to run against it, so this is safe by
   construction rather than by intention.
3. Confirm `GET /api/v1/health` reports `"status": "ok"` before declaring the
   rollback complete. It reports `"degraded"` unless a query actually reaches the
   database, which is the point: a process that starts is not the same as one
   that can serve.
4. If a migration must be reversed, write a **new forward** migration that
   reverses it, so the checksum chain stays intact.

What this does **not** cover: a release that wrote data the previous release
cannot read — a new enum value in a column it validates, say. The schema check
cannot see that, and no automated check here does. Treat a data-shape change as
a two-step release the same way a column drop is.

## Least privilege

The application role needs `SELECT`, `INSERT`, `UPDATE`, `DELETE` on application
tables and `USAGE` on sequences. It does not need `SUPERUSER`, `CREATEDB` or
`CREATEROLE`. Run migrations under a separate role holding DDL rights.

Recommended and **not yet applied**: revoke `UPDATE` and `DELETE` on `audit_log`
from the application role, so append-only is enforced by the database rather than
by convention.

## Scaling notes

Stateless API and worker processes scale horizontally. The database is the
constraint. When it becomes one: read replicas for reporting, then partition
`calculation_runs` and `audit_log` by time.

These are no longer guesses. `pnpm load-test` builds 5,000 properties and
200,000 leases and times the queries the interface issues; `pnpm concurrency-test`
drives 200 parallel clients through the real server. The second corrected an
assumption worth repeating here: the connection pool is **not** the throughput
constraint — measured across 5 to 60 connections it was flat to worse, because
the single Node process is the bottleneck. Throughput scales by running more API
processes, not by raising the pool.

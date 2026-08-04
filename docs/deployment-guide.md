# Deployment guide

## Status of this document

Local development on a directly installed PostgreSQL 16 is **verified**:
migrations, seed, the full test suite and the web build were all run
successfully.

The Docker Compose files are **written but never executed** — the build
environment had no Docker daemon. Backup and restore procedures are documented
but have **not been drilled**. Treat both as untested until someone runs them.

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
cp .env.example .env
# Generate a session secret:
node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"
# Put it in .env as SESSION_SECRET.

pnpm install
createdb cre_platform
pnpm db:migrate
pnpm db:seed          # fictional demonstration data
pnpm dev              # api :4000, web :5173, worker
```

Open http://localhost:5173 and sign in with the credentials the seed prints.
All seeded data is fictional.

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
| `STORAGE_DRIVER`, `STORAGE_LOCAL_DIR` | | Object storage abstraction |
| `AI_ASSISTANT_PROVIDER` | | `none` by default; the assistant is disabled |

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
down migration.

## Health and observability

`GET /api/v1/health` returns `{"status":"ok"}` after a successful database round
trip. Point liveness and readiness probes at it.

The worker emits structured JSON logs (`job.succeeded`, `job.failed`,
`jobs.reaped`) carrying job kind, identifier and duration — **never payloads**,
which would contain tenant data.

No error-monitoring provider is wired. `docs/architecture.md` describes where it
would attach.

## Backup and restore (documented, not drilled)

```bash
# Backup
pg_dump --format=custom --file=cre-$(date +%F).dump "$DATABASE_URL"

# Restore into a clean database
createdb cre_restore
pg_restore --dbname="postgres://…/cre_restore" --clean --if-exists cre-2026-08-04.dump

# Verify
psql "$RESTORE_URL" -c "SELECT count(*) FROM calculation_runs;"
psql "$RESTORE_URL" -c "SELECT name, checksum FROM schema_migrations ORDER BY name;"
```

Everything needed to reproduce a valuation is in the database: `model_versions`
holds the exact engine input and `calculation_runs` holds the result.

**Recommended before relying on this:** a restore drill into a scratch database,
confirming a stored version recalculates to its stored result. This has not been
done.

## Rollback

1. Redeploy the previous API and worker images.
2. Leave the schema in place — migrations are backward compatible by policy.
3. If a migration must be reversed, write a **new forward** migration that
   reverses it, so the checksum chain stays intact.

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
`calculation_runs` and `audit_log` by time. No load testing has been done, so
these are informed expectations rather than measurements.

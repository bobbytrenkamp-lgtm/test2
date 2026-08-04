# Architecture

## Shape

```
                 ┌────────────────────────────────────────────┐
   browser ─────►│ apps/web        React + Vite, session cookie│
                 └───────────────┬────────────────────────────┘
                                 │ /api/v1  (same origin)
                 ┌───────────────▼────────────────────────────┐
                 │ apps/api        Fastify                    │
                 │  identity → capability → org-scoped query  │
                 └───┬───────────────────────┬────────────────┘
                     │                       │
      ┌──────────────▼──────────┐   ┌────────▼─────────────────┐
      │ packages/calculation-   │   │ packages/database        │
      │ engine  (pure, no I/O)  │   │ SQL migrations + repos   │
      └─────────────────────────┘   └────────┬─────────────────┘
                     ▲                       │
                     │              ┌────────▼─────────────────┐
      ┌──────────────┴──────────┐   │ PostgreSQL 16            │
      │ apps/worker             │   │ (also the job queue)     │
      │ FOR UPDATE SKIP LOCKED  │──►└──────────────────────────┘
      └─────────────────────────┘
```

| Package | Responsibility | Depends on |
| --- | --- | --- |
| `packages/domain-models` | Zod schemas, engine input/result types, permission model | zod |
| `packages/calculation-engine` | All financial mathematics | domain-models, decimal.js |
| `packages/database` | Migrations, repositories, password hashing, seed | domain-models, engine, postgres |
| `packages/reporting` | Import parsing, report definitions, export renderers | domain-models, engine, exceljs |
| `apps/api` | HTTP surface, authentication, authorization, audit | all packages, fastify |
| `apps/worker` | Background jobs | all packages |
| `apps/web` | Analyst interface | domain-models (types only), react |

The dependency graph is acyclic and the engine sits at the bottom of it. The
engine imports no I/O, no framework and no environment; it cannot reach the
network or the filesystem even by accident.

## Decisions

Full records are in `docs/decisions/`. In brief:

**Fastify over Express or Next API routes.** Schema-first, fast, and its plugin
model makes the "identity resolved once, authorization per route" split
explicit. Next.js was rejected because it would place the engine inside the web
framework's module graph.

**React + Vite SPA over server-rendered React.** The analyst workspace is a
single long-lived session over dense grids, not a set of documents. An SPA with
a same-origin cookie gives the interaction model without a rendering framework
in the middle. Vite proxies `/api` in development so the cookie behaves exactly
as it does in production behind one hostname.

**Hand-written SQL migrations over a generator.** The schema carries domain
rules as constraints, and those read more clearly as SQL. Migrations run in a
transaction, are checksummed, and an edited applied migration is refused rather
than silently skipped.

**postgres.js without an ORM.** Numeric columns are configured to return
**strings**, not JavaScript numbers. Letting a driver coerce `numeric` to a
float would reintroduce exactly the binary rounding the engine exists to avoid.

**PostgreSQL as the job queue.** `FOR UPDATE SKIP LOCKED` lets any number of
workers consume one queue without coordinating. Adding Redis or SQS would mean a
second thing to operate, back up and secure for no capability the platform needs
today. If throughput ever demands it, `packages/database/src/repositories/jobs.ts`
is the seam to replace.

**decimal.js over BigInt minor units.** Rates, areas and per-area rents are not
integers, and the engine divides constantly. Fixed-point integers would push
scaling decisions into every formula.

## Request path

1. **Identity** — a `preHandler` unsigns the `cre_session` cookie, hashes the
   token and resolves it against `sessions`. Failure leaves the request
   anonymous; it does not reject, because public routes exist.
2. **CSRF** — any non-GET request must carry `X-Requested-With: cre-platform`, a
   header a cross-site form post cannot set. With a `SameSite=Lax` cookie this
   blocks forgery without a token round trip.
3. **Authorization** — each protected handler calls
   `requireCapability(request, capability)`, which requires a selected
   organization, a membership role in it, and that role to carry the capability.
4. **Scoping** — every query filters on `organization_id`. A record in another
   organization returns **404, not 403**, because "forbidden" would confirm the
   identifier exists.
5. **Audit** — mutations write an append-only entry recording only the fields
   the change touched.

`tests/authorization.test.ts` proves steps 3–5 against two real organizations
holding real data.

## Model data

Physical structure (property → building → space) is **shared across every model
of a property**. Scenario-specific data — leases, rent steps, expenses, other
revenue, capital, debt, growth curves, market leasing profiles — hangs off
`model_id`.

Cloning a model therefore copies a handful of rows and shares the building. An
upside case costs almost nothing, which is what makes scenario work practical.

`model_versions` stores the **exact engine input** as JSONB alongside the engine
version. A stored version can be recalculated without reading any live table, so
an approved valuation stays reproducible after the live model moves on.

## Calculation path

Synchronous by default — an ordinary model calculates in well under a second.
`POST /models/:id/calculate` runs the engine, stores the result in
`calculation_runs` and the trace separately in `calculation_traces`, and returns
diagnostics with the annual summary.

Queued when the work is large: `async: true` on a calculation, scenario batches,
workbook exports and portfolio roll-ups all become jobs the worker consumes.

## Storage and external services

Every external dependency sits behind an interface so it can be replaced:

| Concern | Today | Replaceable with |
| --- | --- | --- |
| Object storage | `STORAGE_DRIVER=local`, opaque keys in `documents` | S3-compatible service |
| Malware scanning | `scan_status` column, no scanner wired | ClamAV or a hosted scanner |
| Mail | none; reset and invitation tokens returned in non-production | any SMTP or API provider |
| AI assistant | `AI_ASSISTANT_PROVIDER=none`, disabled | any provider, opt-in |

No paid service, API or data source is a dependency. The platform runs entirely
on open-source components.

## The AI assistant

Not implemented, and **disabled by default**. The architecture it would fit is
specified so the constraints are settled before any code exists:

- Deterministic validation and reporting must never depend on it.
- It must cite the exact model records it used and distinguish data from
  inference.
- It must never alter a financial assumption without explicit user approval.
- No model content may leave the deployment without explicit consent.
- No paid provider will be added without approval.

## Performance

Designed for thousands of properties and hundreds of thousands of lease steps.

- Indexes on every foreign key and on the filters that exist:
  `models(property_id)`, `leases(model_id, expiration_date)`,
  `audit_log(organization_id, occurred_at DESC)`, partial index on ready jobs.
- Results are cached as stored calculation runs; reading a cash flow does not
  re-run the engine.
- Traces live in their own table so they load only when the inspector opens.
- Rollover branching is bounded by weight pruning and a generation ceiling.
- Large work is queued rather than run on the request path.

Not yet done: grid virtualisation for very large rent rolls, cursor pagination
on the audit log, and a load-tested performance baseline. These are recorded in
`docs/feature-status.md` rather than claimed.

## Deliberately not distributed

One API process, one worker process, one database. Splitting the engine or the
reporting layer into services would add deployment, versioning and failure modes
without solving a problem the platform currently has. The package boundaries are
already in place, so the split is available when it is operationally justified.

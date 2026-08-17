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
A report rendered to PDF is queued unconditionally, not behind a flag —
launching a browser process always takes long enough to be worth not
blocking a request on; see `apps/worker/src/pdf.ts`.

## Storage and external services

Every external dependency sits behind an interface so it can be replaced:

| Concern | Today | Replaceable with |
| --- | --- | --- |
| Object storage | `STORAGE_DRIVER=local` (default) writes to disk, behind `POST /documents`; opaque keys in `documents`. `s3` names the interface but is refused at startup — nothing implements it yet | S3-compatible service |
| Malware scanning | `SCAN_DRIVER=none` (default) scans nothing; `SCAN_DRIVER=clamav` scans all three upload surfaces (rent-roll import, budget actuals import, document upload) through a `clamd` daemon | ClamAV (built in) or a hosted scanner |
| Mail | `MAIL_DRIVER=console` (default) logs instead of sending; `MAIL_DRIVER=smtp` sends through `nodemailer` | any SMTP or API provider |
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

Designed for thousands of properties and hundreds of thousands of lease steps,
and now **measured** rather than asserted. `pnpm benchmark` times the engine on
four synthetic models and fails the build when a case exceeds its budget; it
runs on every CI build.

| Case | Leases | Rent steps | Months | Time |
| --- | --- | --- | --- | --- |
| Single tenant | 1 | 4 | 120 | ~130 ms |
| Small multi-tenant | 25 | 100 | 120 | ~440 ms |
| Large multi-tenant | 100 | 600 | 120 | ~1.5 s |
| Very large multi-tenant | 300 | 2,400 | 120 | ~4.8 s |

Absolute numbers are not portable between machines. What is portable is the
shape: work per lease-month is roughly flat across the range, so cost grows
linearly with the model and scale is a question of hardware and queueing rather
than of algorithm.

### What the first run found

The first benchmark showed a **2.4-second floor on a single-tenant model** —
almost all of it independent of how many leases the model held. Profiling put
82% of the time inside decimal.js's `pow`, which evaluates a *fractional*
exponent through a natural logarithm and an exponential at full precision.

Two places were calling it once per period:

- `discountFactor` computes `(1 + r)^(-i/12)` per period, and `irrMonthly`
  evaluates an NPV on each of its 200 bisection steps — 24,000 fractional powers
  per IRR on a ten-year model. Since `(1 + r)^(-i/12)` is `f^i` for
  `f = (1 + r)^(-1/12)`, the fractional power is now taken once and the series
  follows by multiplication.
- `xirr` did the same per cash flow. The flows are sorted, so the running factor
  is carried forward and multiplied by the gap to the next one; a monthly series
  has only a handful of distinct gaps, so those are computed once per rate.

The single-tenant case went from 2,386 ms to 128 ms — **18× faster** — and the
whole test suite from 57 seconds to under 4. No calculated figure changed:
`discountFactors` is asserted to agree with `discountFactor` to 28 decimal
places, and all 309 tests passed before and after.

That is the argument for measuring rather than reasoning about performance. The
platform was doing the most expensive operation decimal.js offers, tens of
thousands of times, to compute a number that needed it once.

- Indexes on every foreign key and on the filters that exist:
  `models(property_id)`, `leases(model_id, expiration_date)`,
  `audit_log(organization_id, occurred_at DESC)`, partial index on ready jobs.
- Results are cached as stored calculation runs; reading a cash flow does not
  re-run the engine.
- Traces live in their own table so they load only when the inspector opens.
- Rollover branching is bounded by weight pruning and a generation ceiling.
- Large work is queued rather than run on the request path.

### The database at scale

`pnpm load-test` builds a scratch organization — 5,000 properties, 10,000
models, 200,000 leases, 50,000 audit rows — and times the queries the interface
actually issues. It runs in CI at a thousand properties.

| Query | Time |
| --- | --- |
| Property list, first page | ~3 ms |
| Property list, deep page (OFFSET 900) | ~3 ms |
| Property search, `name ILIKE` | ~9 ms |
| Model list, whole organization | ~9 ms |
| Audit log, first page of 50,000 | ~22 ms |
| Latest calculation, full result JSONB | ~1 ms |

Every list query stays flat as the tables grow, which is what the pagination and
the indexes are there for. The claim at the top of this section is now measured
rather than asserted.

**What it found.** Portfolio aggregation issued two queries per property — one
to find the leading model, one to read its stored result — in a sequential loop.
At 500 properties that was 1,000 round trips and 248 ms locally. Round trips are
the cost, not the work: against a database one network hop away at 1 ms, a
thousand-property fund would spend about two seconds waiting rather than
computing. It is now a single `DISTINCT ON` query, 49 ms for the same 500
properties, and **one** round trip regardless of size.

The portfolio aggregate had no tests at all when that rewrite happened, so
`tests/portfolios.test.ts` was written alongside it — model precedence,
and the two exclusion reasons a property can be dropped for.

### Under concurrent load

`pnpm concurrency-test` drives the real Fastify server, with its real connection
pool, through a mix of reads weighted the way a working day is. It reports
percentiles rather than an average: an average hides the request that took four
seconds behind the ninety-nine that took ten milliseconds, and the slow one is
the one someone notices.

At **200 parallel clients**, 1,000 requests: roughly **1,000 req/s, p95 ~200 ms,
zero failures**. Latency grows linearly with queue depth and nothing deadlocks
or errors, which is the healthy shape.

**The connection pool is not the constraint.** Measured at 5, 10, 30 and 60
connections under the same load, throughput was flat to slightly *worse* as the
pool grew, and the tail lengthened:

| Pool | Throughput | p95 |
| --- | --- | --- |
| 5 | 1,084 req/s | 184 ms |
| 10 | 844 req/s | 246 ms |
| 30 | 886 req/s | 279 ms |
| 60 | 770 req/s | 420 ms |

The bottleneck is the single Node process — serialising large cash-flow payloads
is CPU work, and more connections only add contention for it. **Throughput
scales by running more API processes, not a bigger pool.** `DATABASE_MAX_CONNECTIONS`
exists to *bound* connections against the database's own `max_connections`,
since every API process multiplies it; it is not a performance dial. That
correction is worth stating plainly because the opposite is the intuitive guess,
and it is what I assumed before measuring.

### Concurrent writes

The first concurrency run found that ten simultaneous writes to one lease all
succeeded and the last one won — an analyst's work disappearing with nobody
told, on a record that decides what a property is worth.

Leases now carry a `version`, incremented on every write. A caller that read the
lease sends the version it saw; if the stored one has moved, the write is
refused with **409** and the current version, so the client can show what
changed rather than guess. The check and the write share one transaction with
the row locked, because reading the version in a separate statement would leave
exactly the race it exists to close.

Ten simultaneous version-guarded writes now resolve to **one accepted and nine
refused**, asserted by both the test suite and the concurrency script.

Sending no version is a deliberate opt-out and stays last-write-wins. Bulk
import uses it: an import is an explicit "replace these rows" and has nothing to
have read first. The lease editor always sends one, because it loaded the lease
before showing it.

Models carry the same protection, and rather more of the leverage: a discount
rate or an exit capitalisation rate moves every figure in the valuation at once,
so two people adjusting assumptions simultaneously is the collision most worth
refusing.

> **The first model implementation was wrong.** The version check and the update
> ran as two separate statements. Each went out on its own pooled connection and
> committed immediately, so the `FOR UPDATE` lock was released before the update
> ran and both simultaneous writers passed the check. The sequential test still
> passed; only the test that fires both writes through `Promise.all` caught it.
> That is the whole reason those tests are written that way, and why the check
> and the write now share one transaction — as the lease implementation already
> did.

The assumption **collections** — expenses, other revenue, capital, debt, growth
curves and market leasing profiles — carry versions too, but **per row rather
than per model**. That was the whole reason they were left out of the model
change rather than folded into it: binding them to a model-wide version would
make one analyst adding a roof replacement collide with another adjusting the
insurance line, and a guard that refuses unrelated edits does not get respected,
it gets worked around. Two writers to the same row now resolve to one accepted
and one refused; two writers to different rows both succeed, and a test asserts
that second half explicitly, because a lock that is too broad passes every test
that only checks the first.

The guard lives in the shared collection registration rather than in each of the
six upserts, so it cannot drift between them and a seventh collection inherits
it. A test still walks all six, since "it is shared code" is an argument, not
evidence.

### The cash-flow grid

A monthly view of a ten-year forecast is 121 columns across 27 line items, and
every figure is a button so it can be opened in the calculation inspector —
3,240 interactive elements. `pnpm profile:grid` measured switching into that
view at a median of **429 ms**, against 163 ms for the annual view's 270 cells.
A hundred milliseconds is roughly where an interaction stops feeling immediate,
so this was well past it.

Only the columns near the viewport are now rendered; the rest are represented
by a spacer of the width they would have occupied, so the scrollbar and the
frozen first column behave exactly as before. Below 24 columns nothing is
virtualised at all, which leaves the annual view and every small model on
precisely the path they were on.

That took the monthly switch to **212 ms** and 594 interactive cells. Better,
and still above the line: the remaining time is the 27 rows and the re-layout
of a sticky-first-column table rather than the column count, so row
virtualisation or a cheaper cell is where to look next. The script says so in
its own output rather than leaving it to be rediscovered.

The risk in rendering part of a table is telling assistive technology the
forecast is shorter than it is. The table carries `aria-colcount` for its true
width and every rendered cell its true `aria-colindex`, and three browser tests
assert the reported dimensions alongside the rendered ones.

## Deliberately not distributed

One API process, one worker process, one database. Splitting the engine or the
reporting layer into services would add deployment, versioning and failure modes
without solving a problem the platform currently has. The package boundaries are
already in place, so the split is available when it is operationally justified.

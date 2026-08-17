# CRE Platform

A commercial real estate underwriting, valuation, cash-flow forecasting, asset
management, debt, scenario and portfolio platform.

Built from generally accepted commercial real estate finance, accounting,
valuation and leasing principles. It is an original design — no proprietary
source, screen layout, wording, report format, calculation behaviour or file
format from any existing product has been copied, and no claim of numerical
parity with any other product is made. Every modelling convention that is a
judgement call is documented, with its reasoning, in
[`docs/calculation-specification.md`](docs/calculation-specification.md).

---

## Quick start

Install **Node 20.11+** (built on 22), **PostgreSQL 16+** and **pnpm 9**, then:

```bash
pnpm install
pnpm start
```

`pnpm start` checks the prerequisites, writes a `.env` with a generated session
secret, creates the PostgreSQL role and database if they do not exist, applies
the migrations, loads the demonstration data, and starts the API, web client and
worker. It is safe to run again: every step checks before it acts, an existing
`.env` is never overwritten, and a database with data in it is never seeded over.

Open http://localhost:5173 and sign in with the credentials it prints. **All
seeded data is fictional** — no real property, tenant, address or transaction
appears anywhere in it.

Use `pnpm bootstrap` to prepare without starting. (Not `pnpm setup` — that is a
built-in pnpm command and does something else entirely.)

<details>
<summary>Doing it by hand</summary>

```bash
cp .env.example .env
node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"
# put that value in .env as SESSION_SECRET

# .env connects as a role named "cre", which a fresh PostgreSQL install
# does not have. Create it, or point DATABASE_URL at a role you do have:
psql -d postgres -c "CREATE ROLE cre LOGIN PASSWORD 'cre'"
createdb -O cre cre_platform

pnpm db:migrate
pnpm db:seed        # fictional demonstration data across five properties
pnpm dev            # api :4000 · web :5173 · worker
```

</details>

## The engine, without installing anything

**https://bobbytrenkamp-lgtm.github.io/test2/**

The calculation engine has no server dependency, so it is published as a single
self-contained page that runs it in your browser against the twenty regression
fixtures — the real engine, not screenshots. `pnpm build:demo` produces the same
file locally at `demo/dist/index.html`.

It is deliberately only the engine. Persistence, authentication, the audit log,
imports, reports and permissions all need the server, and the page says so above
the fold. There is no hosted deployment of the whole platform: its container
images have never been built, which `docs/feature-status.md` records as a
release blocker rather than glosses.

**Nothing in this project costs money.** No paid service, external API, hosted
dependency or commercially licensed component is used; everything runs locally
on open-source components. `pnpm licences` fails the build if a dependency ever
arrives under a paid or copyleft licence, and it runs in CI. The full audit —
including GitHub Actions exposure and what was deferred rather than paid for —
is in [`docs/zero-cost-operation.md`](docs/zero-cost-operation.md).

---

## What is here

| Package | What it does |
| --- | --- |
| `packages/calculation-engine` | Every financial calculation. Pure, deterministic, no I/O. |
| `packages/domain-models` | Schemas, engine types, the permission model. |
| `packages/database` | SQL migrations, repositories, password hashing, seed data. |
| `packages/reporting` | Rent-roll import, report definitions, export renderers. |
| `apps/api` | Fastify API: authentication, authorization, audit. |
| `apps/worker` | Background jobs on a PostgreSQL-backed queue. |
| `apps/web` | React analyst interface. |

## The engine

The heart of the platform, and the part most worth reading first.

- **Deterministic.** Same input plus same engine version, same output. Asserted
  for every regression fixture.
- **Decimal throughout.** 34 digits, half-even. Money never passes through
  binary floating point between the engine and the screen.
- **Traceable.** Any material figure records the assumption, formula, inputs and
  sources that produced it. The interface reads those traces directly — it
  recomputes nothing.
- **Honest.** A missing critical input produces a diagnostic and an explicit
  "not available", never a plausible-looking zero.

It computes the full line stack from potential base rent through to investor
distributions: probability-weighted rollover with downtime and speculative
lease-up of vacant space; triple-net, base-year, expense-stop and fixed
recoveries with gross-up, admin fees and caps; percentage rent on natural and
artificial breakpoints; vacancy that is never deducted twice; fixed and
floating-rate debt with amortisation, refinancing and covenant testing;
discounted cash flow and direct capitalisation; IRR, XIRR, NPV and the full
yield and credit metric set; and LP/GP waterfalls with preferred returns,
catch-up and promote.

## Testing

```bash
pnpm test                                    # engine + import suites
DATABASE_URL=postgres://… pnpm test          # + authorization + vertical slice
pnpm test:e2e                                # Chromium, on the built bundle
```

**1438 tests, plus 231 in the browser.** The regression library holds twenty independently designed
fictional properties whose expected values were derived by hand or recomputed by
a different method than the engine uses — **never** by running the engine and
copying its output, which would make the tests agree with the engine by
construction.

`pnpm test:e2e` rebuilds a dedicated database from the migrations and the seed,
starts the API and a preview server, and drives the **built** bundle in Chromium:
the underwriting path through to the calculation inspector, lease validation,
capability-driven control visibility for three roles, the import wizard, and
`axe-core` accessibility checks on nine screens where any violation fails the
build.

The suites have already caught real bugs: interest never accruing in a loan's
funding month; vacant space never leasing up; `12,500` parsing as `12.5`; error
rows still importing; framework client errors reported as 500s; concurrent
migrations racing on `CREATE EXTENSION`; every form control in the platform
being unlabelled; scrollable tables unreachable by keyboard; a lease holding part
of a space reporting the whole space occupied. Each is described in
[`docs/testing-strategy.md`](docs/testing-strategy.md).

## Documentation

| Document | |
| --- | --- |
| [`repository-assessment.md`](docs/repository-assessment.md) | What was here, and why the platform was built in place |
| [`product-requirements.md`](docs/product-requirements.md) | Scope, principles, definition of done |
| [`architecture.md`](docs/architecture.md) | Structure, request path, decisions |
| [`domain-model.md`](docs/domain-model.md) | Hierarchy, shared vs. scenario data, asset classes |
| [`calculation-specification.md`](docs/calculation-specification.md) | **Every formula, in full** |
| [`import-specification.md`](docs/import-specification.md) | Rent-roll parsing and normalisation rules |
| [`spreadsheet-grid.md`](docs/spreadsheet-grid.md) | Spreadsheet-grade editing: selection, clipboard, undo, batched saves |
| [`reporting-specification.md`](docs/reporting-specification.md) | Reports and output formats |
| [`security-model.md`](docs/security-model.md) | Threat model and what is verified |
| [`testing-strategy.md`](docs/testing-strategy.md) | How correctness is established |
| [`deployment-guide.md`](docs/deployment-guide.md) | Running it, backing it up, rolling it back |
| [`implementation-roadmap.md`](docs/implementation-roadmap.md) | What to build next, in order |
| [`feature-status.md`](docs/feature-status.md) | **What actually exists** |
| [`zero-cost-operation.md`](docs/zero-cost-operation.md) | **Why nothing here can bill you** |
| [`decisions/`](docs/decisions/) | Architecture decision records |

## Status, honestly

[`docs/feature-status.md`](docs/feature-status.md) is authoritative. In summary:

**Solid and tested.** The calculation engine and its regression library; the
database schema and migrations; authentication, authorization, multi-factor
authentication, password reset delivery and cross-organization isolation; the
deterministic import
parser, CSV and Excel alike; malware scanning of both import surfaces —
pluggable, defaults to none, and honest in its response about whether a scan
actually happened; the background worker's claim/run/complete-or-fail cycle,
exercised directly against a real queue on top of the job-queue functions
and individual handlers; budgets, actuals and variance reporting; model
cloning — what eleven copied tables and two remapped foreign keys actually
produce, not just that the endpoint returns 201; sensitivity analysis — a
grid cell checked against an independent engine run, not just its shape;
the rent-roll import commit path — tenant dedup across a re-import,
partial-import-with-errors, saved mapping templates, the audit trail; the
general reports/exports engine — JSON, CSV, XLSX and print HTML checked
against each other, not assumed to agree; server-side PDF rendering — a
real headless browser producing real PDF bytes, queued through the same
job pipeline as a scenario batch, exercised end to end by hand through a
real browser click against real running API, worker and web processes;
import rollback — the commit route now runs entirely in one transaction
(a genuine atomicity bug, fixed alongside rollback itself: the previous
per-lease write opened and committed its own transaction, so a mid-loop
failure left earlier rows standing), and a rollback restores or deletes
exactly what a commit touched, from a snapshot taken in that same
transaction; version comparison and the approval workflow; the vertical slice from
sign-in through to a traced valuation and a frozen approval. The browser
suite reaches the assumptions
editor, scenarios, versions, reports and the portfolio roll-up, not only
the underwriting path — Chromium only, and not a substitute for the
screen-reader audit below.

**Works, not yet proven.** Live ClamAV signature detection specifically —
the scanner's driver selection and its HTTP translation of a
clean/infected/unreachable result are tested against a fake client, but
this environment's egress policy blocks the same CDN a `clamd` container
would need at startup to load real virus definitions, so
end-to-end detection has never run here.

**Designed only.** Documents and configurable dashboards,
mention notifications and an activity feed, a handful of lease-option types
(expansion, purchase, ROFR, ROFO), fund-level recallable distributions, the
live property-research integration, and the optional AI assistant — which
is disabled by default and adds no paid dependency without
approval.

**Written but unverified.** The Docker Compose stack only — the container
images have never been built, because this environment's egress policy
refuses the image-layer CDN. The backup/restore drill is not in this
category: it runs against a real PostgreSQL instance in CI on every build
(`pnpm drill:restore`) and has never failed.

Nothing in this repository is marked *production ready*. That designation is
reserved for features that have also passed an accessibility audit with a
real screen reader, a built and run container image, and a scripted deploy —
none of which has been done. Load testing and the restore drill *have* been
done and run in CI on every build; they are not what is missing. The
`axe-core` checks catch mechanical failures; they are not a screen-reader
audit and are not offered as one.

## Licence

No licence has been chosen yet. Add one before distributing.

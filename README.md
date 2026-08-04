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

```bash
cp .env.example .env
node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"
# put that value in .env as SESSION_SECRET

pnpm install
createdb cre_platform
pnpm db:migrate
pnpm db:seed        # fictional demonstration data across five properties
pnpm dev            # api :4000 · web :5173 · worker
```

Open http://localhost:5173. The seed prints sign-in credentials. **All seeded
data is fictional** — no real property, tenant, address or transaction appears
anywhere in it.

Requires Node 20.11+ (built on 22), PostgreSQL 16+, pnpm 9. No paid service,
external API or proprietary component is needed.

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
```

**218 tests.** The regression library holds twelve independently designed
fictional properties whose expected values were derived by hand or recomputed by
a different method than the engine uses — **never** by running the engine and
copying its output, which would make the tests agree with the engine by
construction.

The suites have already caught real bugs: interest never accruing in a loan's
funding month; vacant space never leasing up; `12,500` parsing as `12.5`; error
rows still importing; framework client errors reported as 500s. Each is
described in [`docs/testing-strategy.md`](docs/testing-strategy.md).

## Documentation

| Document | |
| --- | --- |
| [`repository-assessment.md`](docs/repository-assessment.md) | What was here, and why the platform was built in place |
| [`product-requirements.md`](docs/product-requirements.md) | Scope, principles, definition of done |
| [`architecture.md`](docs/architecture.md) | Structure, request path, decisions |
| [`domain-model.md`](docs/domain-model.md) | Hierarchy, shared vs. scenario data, asset classes |
| [`calculation-specification.md`](docs/calculation-specification.md) | **Every formula, in full** |
| [`import-specification.md`](docs/import-specification.md) | Rent-roll parsing and normalisation rules |
| [`reporting-specification.md`](docs/reporting-specification.md) | Reports and output formats |
| [`security-model.md`](docs/security-model.md) | Threat model and what is verified |
| [`testing-strategy.md`](docs/testing-strategy.md) | How correctness is established |
| [`deployment-guide.md`](docs/deployment-guide.md) | Running it, backing it up, rolling it back |
| [`implementation-roadmap.md`](docs/implementation-roadmap.md) | What to build next, in order |
| [`feature-status.md`](docs/feature-status.md) | **What actually exists** |
| [`decisions/`](docs/decisions/) | Architecture decision records |

## Status, honestly

[`docs/feature-status.md`](docs/feature-status.md) is authoritative. In summary:

**Solid and tested.** The calculation engine and its regression library; the
database schema and migrations; authentication, authorization and
cross-organization isolation; the deterministic import parser; the vertical
slice from sign-in through to a traced valuation and a frozen approval.

**Works, not yet proven.** The web application in full, background jobs, reports
and exports, sensitivity analysis, model cloning, portfolio aggregation. There
are **no automated UI tests**, so a front-end regression would not be caught
automatically. That is the largest gap and the first item on the roadmap.

**Designed only.** Budgets and actuals, variance reporting, collaboration,
configurable dashboards, documents, portfolio reports, Excel *import*,
server-side PDF, multi-factor authentication, and the optional AI assistant —
which is disabled by default and adds no paid dependency without approval.

**Written but unverified.** The Docker Compose stack and the backup/restore
procedure. The build environment had no Docker daemon and no restore drill has
been run. Both are documented; neither should be relied on until executed.

Nothing in this repository is marked *production ready*. That designation is
reserved for features that have also passed load testing, an accessibility audit
with a real screen reader, and a restore drill — none of which has been done.

## Licence

No licence has been chosen yet. Add one before distributing.

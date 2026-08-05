# Implementation roadmap

## Where the build reached

| Phase | Status |
| --- | --- |
| 0. Audit and preservation | **Complete.** Repository was empty; see `docs/repository-assessment.md`. |
| 1. Foundation | **Complete.** Monorepo, environment validation, PostgreSQL, migrations, authentication, organizations, permissions, design system, CI, tests, seed data. |
| 2. Property and lease domain | **Complete.** Properties, buildings, spaces, tenants, leases, rent steps, market leasing assumptions, validation. |
| 3. Calculation engine | **Complete.** Calendar, lease revenue, rent steps, vacancy, expenses, recoveries with multiple pools and reconciliation, NOI, capital, traces, 18 regression fixtures. |
| 4. Valuation and returns | **Complete.** DCF, direct capitalisation, terminal value, sale, IRR, XIRR, equity multiple, NPV, yield metrics. |
| 5. Debt and equity | **Complete.** Facilities, amortisation, floating rates, covenants, refinancing, equity flows, waterfalls. |
| 6. Analyst interface | **Substantially complete.** Workspace, cash-flow grid, validation panel, calculation inspector, fund positions, one keyboard workflow, all covered by a browser suite. Spreadsheet-grade editing is not built. |
| 7. Imports and reports | **Partial.** CSV import with a mapping wizard; Excel and CSV export; nine property reports; print HTML. Excel *import* and server-side PDF are not built. |
| 8. Scenarios and versions | **Substantially complete.** Cloning, immutable versions, sensitivity grids, batch runs, approval workflow, side-by-side version comparison. |
| 9. Budgets and asset management | **Complete.** Budget periods, trial-balance import, variance with materiality, commentary with two-person approval, reforecast carry-forward, interface and tests. |
| 10. Portfolio and funds | **Substantially complete.** Dynamic and static portfolios, aggregation (single-query and tested), concentration analysis, and fund-level commitments, capital calls, distributions, unfunded capital and investor returns. Fund-level waterfalls and recallable distributions are not built. |
| 11. Advanced asset classes | **Partial.** Development, retail percentage rent, multifamily unit modelling work through the common engine. Hotel departmental and data-centre capacity models are not built. |
| 12. Production hardening | **Substantially complete.** Restore drill, engine benchmark, database load test and a concurrency test all run in CI. Machine-checked accessibility on eleven screens. Local error monitoring. Still missing: a screen-reader audit and deployment automation with a rollback path. |

## What to do next, in order

### 1. ~~Test the web application~~ — done

23 Playwright tests now drive Chromium against the built bundle, a real API and
a freshly seeded database: sign in → property → model → calculate → inspect a
traced figure; the lease editor's validation; capability-driven control
visibility for three roles; the import wizard on a part-invalid file; and
`axe-core` on nine screens. See `docs/testing-strategy.md`.

Four defects surfaced immediately and are fixed: every form control in the
platform was unlabelled, scrollable tables were unreachable by keyboard, the
import wizard wrote rows without saying so, and concurrent migrations raced on
`CREATE EXTENSION`.

**What remains here:** the assumptions editor, scenarios, versions, reports and
the portfolio builder are not covered, and the suite runs in Chromium only.

### 2. Verify what is written but unproven — half done

**Backup and restore: drilled.** `pnpm drill:restore` takes a real `pg_dump`,
restores into a scratch database, and confirms that a stored valuation still
reproduces from the restored data — not merely that the row counts match. It
runs on every CI build. It found that the seed never froze a model version, so
the demonstration data had an empty Versions tab and there was no stored
valuation to reproduce; the seed now calculates against a frozen version.

**Docker images: still not built.** The Compose file validates and several real
defects in the Dockerfiles are fixed (a fallback that silently defeated
`--frozen-lockfile`, a missing workspace manifest, a missing `.dockerignore`),
but the base images cannot be pulled where this was developed — the network
policy blocks Docker Hub's blob CDN. A review is not a build. Anyone with
registry access should run `docker compose build && docker compose up` and
report what breaks.

### 3. Close the engine's honest gaps — options partly done

- ~~**Lease options.**~~ Renewal, termination and contraction are now modelled as
  probability-weighted paths, applied in exercise-date order so mutually
  exclusive options behave without special-casing. Three regression fixtures,
  engine 2.0.0. **Expansion is deliberately not modelled**: the option records
  how much area is taken but not which space it comes from, so honouring it
  would either double-count area or invent rentable area the property does not
  have. Adding a space reference to `LeaseOption` is the next step there.
  Purchase, ROFR and ROFO bear on disposition, not operating cash flow.
- ~~**Multiple recovery pools per lease**, reconciliation timing and prior-year
  true-ups.~~ Done. A lease settles any number of pools, each with its own base
  year, cap history and reconciliation, and a tenant can be billed an estimate
  monthly with the difference settled after the year closes. Both default to the
  previous behaviour.

  Writing the round-trip test found a defect of my own making: 2.0.0's
  area-share correction was also being applied when spreading an annual
  entitlement across months, so a lease covering part of a space recovered only
  its share of that space of what it was owed. Engine 3.0.0; fixture 18 covers
  the case and reproduces the old figure when the fix is reverted.
- **Development and refinance fee bases** in the waterfall.
- ~~**Cash-management triggers** on covenant breach.~~ Done. A breach the engine
  only reported was a breach with no consequence: the model showed the covenant
  failing and distributed the cash anyway, overstating the levered return in
  precisely the years a lender is most worried about. Surplus cash is now
  withheld from equity while a breach persists and released on cure, with NOI
  and unlevered cash flow untouched — a financing outcome, not an operating one.
  Engine 3.1.0, default off. **Cash sweep is deliberately not modelled**:
  applying trapped cash to principal makes the schedule depend on the cash flow
  that depends on the schedule, and approximating that would misstate every
  covenant tested against the balance afterwards.

### 4. ~~Budgets, actuals and variance~~ — done

Budget periods, a trial-balance import reading both the wide and long layouts a
ledger exports, budget-versus-actual and budget-versus-forecast variance,
favourable/unfavourable designation with materiality thresholds, and commentary
that cannot be approved by its own author.

The sign convention is the load-bearing decision: amounts are held money-in
positive, money-out negative, which makes a favourable variance simply a
positive one on every account. A miscategorised row then lands in the wrong
subtotal — visible — rather than reversing its own variance, which is not. See
`docs/calculation-specification.md` §21.

**Done: reforecast carry-forward.** `POST /budgets/:id/reforecast` builds the
year as it now looks — the closed months as the ledger recorded them, the rest
as the model still projects — and writes it as a real budget period, so the
variance screen reports against it without a second mechanism existing.

The two halves are never blended: a month is either closed or it is not, and
averaging an actual with a forecast for the same month produces a number that
describes neither. The cut-off is stated rather than inferred, because a single
early posting into next month would otherwise truncate the forecast, and a month
is closed when the accountant says so.

Accounts that do not line up are named in both directions — one the ledger
posted that nothing projects forward, one the forecast expected that never
appeared. A missing posting and a genuine zero look identical in a ledger, so
neither is assumed.

### 5. Spreadsheet-grade editing (phase 6) — partly done

**Done: paste from Excel.** Selecting rows in a spreadsheet and pasting them
into the rent roll is how an analyst actually works, and asking them to save a
CSV first was a step that existed only because the software could not be
bothered. The clipboard hands over tab-separated text, and the existing import
pipeline already detects its delimiter, finds the header row, matches columns
and normalises values — so this is the same proven parser reached by a different
door, not a second reader that would drift from the first. Nothing is written
until the findings have been shown.

**Done: a command palette.** Ctrl/Cmd + K anywhere, filtering properties,
models and screens; arrow keys and Enter; `aria-activedescendant` so the
highlight is announced rather than only shown.

**Still to do:** multi-cell edit, fill-down, undo/redo, column hiding, and saved
views (the `saved_views` table exists and is unused).

### 6. Collaboration (phase 32 of the brief) — comments done

**Done: comments.** The approval workflow could move a model from review back to
draft and record that it happened, but not why — so an analyst learned that
someone disagreed, not what to change.

A comment is anchored to a model, a property or a budget period, so it sits
where the disagreement is. `comments` has no foreign key to the thing it names,
because the thing varies, so the route checks the anchor exists in the caller's
organization before anything is read or written against it.

Two rules carry the rest. **Only the author or someone who can approve may
resolve**: if anyone could close anything, the fastest way past a reviewer's
objection would be to dismiss it, and the review would be decorative. And a
**mention must name a member of the organization** — accepting an arbitrary
identifier would claim to have drawn in someone who will never be told, and
would confirm to a stranger that a guessed user exists.

Comments are not the audit log, and the audit entry deliberately records that a
comment happened without copying what it said. An append-only copy of every word
would make resolving one cosmetic.

**Still to do:** tasks (the table is migrated and unused), notifications, an
activity feed, and a comment thread in the interface — the API is complete and
tested but nothing renders it yet.

### 7. Portfolio reporting and funds (phase 10) — funds done

**Done: fund-level investor economics.** A fund records its investors and their
commitments, the capital called from each and the distributions returned, and
reports the position that adds up to: unfunded capital, proportion called, DPI,
RVPI, TVPI and a net internal rate of return solved from the fund's own dated
flows.

Two decisions carry the rest. Residual value comes from the roll-up of the
portfolio the fund holds — the same one the portfolio screen shows, reached
through the same function, because a second aggregation would drift and a fund
and a portfolio disagreeing about the same assets is a defect nobody notices
until an investor asks. And a fund with no portfolio attached reports zero
residual value **and says why**: substituting contributed capital would give
every such fund a TVPI near 1.0, a number that looks like an answer and is not
one.

Deliberately not modelled, and documented in `fund.ts` rather than approximated:
recallable distributions (the transaction record has no field saying which are
recallable, and inferring it would be guessing at the partnership agreement),
fund-level carried interest and catch-up (the deal waterfall settles one
investment, a fund waterfall settles across the whole portfolio with its own
hurdle and clawback), and management fee mechanics.

The Funds screen carries all of it: the position, the per-investor breakdown,
the capital record the return was solved from, and forms for adding an investor
or recording a call. The demonstration seed creates a fund that is half called,
deliberately — a fund shown fully drawn hides the unfunded figure, which is the
one an investor relations team is asked about most often.

**Still to do:** portfolio-level `ReportDefinition`s, and an investor statement
that can be sent out rather than read on screen.

### 8. Production hardening (phase 12)

~~Engine performance baseline~~ — done. `pnpm benchmark` times four synthetic
models against budgets and runs in CI. Its first run found a 2.4-second floor on
a *single-tenant* model: `discountFactor` and `xirr` were each taking decimal.js's
most expensive operation — a fractional power — once per period, tens of
thousands of times per calculation. Fixed; 18× faster, no figure changed. See
`docs/architecture.md`.

~~Database load test~~ — done. `pnpm load-test` builds 5,000 properties,
10,000 models and 200,000 leases and times the real queries; it runs in CI at a
thousand. Every list query stays flat. It found that portfolio aggregation
issued two round trips per property in a loop — 1,000 of them for a 500-property
fund — now a single `DISTINCT ON` query. The aggregate had no tests at all, so
seven were written alongside the rewrite.

~~Concurrency test~~ — done. `pnpm concurrency-test` drives the real server
through 200 parallel clients: ~1,000 req/s, p95 200 ms, zero failures. It
corrected an assumption of mine — the connection pool is **not** the constraint;
measured across 5 to 60 connections throughput was flat to worse, because the
single Node process is the bottleneck. Throughput scales by running more API
processes. It also records that concurrent lease writes are last-write-wins,
with no optimistic locking.

~~Optimistic locking on lease writes~~ — done. Leases carry a `version`; a
write that names a version the store has moved past is refused with 409 and the
current version, rather than silently discarding someone's edit. Ten
simultaneous guarded writes resolve to one accepted and nine refused. Sending no
version remains a deliberate opt-out, which is what bulk import needs.

Models carry the same protection now. The first attempt at it was wrong — the
check and the update ran as two autocommit statements, so the row lock was
released before the write and both simultaneous writers passed. Only the
`Promise.all` race test caught it.

~~The assumption collections~~ — done. Expenses, other revenue, capital, debt,
growth curves and market leasing profiles each carry a **row-level** version,
not the model's. That distinction is the point: two analysts editing the same
expense line collide, and two editing different lines do not. A model-wide
version could not tell those apart, and one that refuses unrelated edits gets
worked around rather than heeded. The guard lives in the shared collection
registration, so a seventh collection would inherit it; a test asserts all six
are actually covered, because "it is shared" is not evidence.

~~Cursor pagination on the audit log~~ — done. The log paged by `OFFSET`, which
makes PostgreSQL walk and discard every skipped row, so page four hundred costs
four hundred times page one. It now pages by keyset — reading from where the
last page stopped — on an index of `(organization_id, occurred_at DESC,
id DESC)`.

The id in that key is the load-bearing part. `occurred_at` alone is not unique:
a bulk import writes a batch of audit rows inside one statement and PostgreSQL's
`now()` is the transaction's start time, so they genuinely collide. Two rows
that compare equal can land on either side of a page boundary — one shown twice,
another never. On an audit log a silently skipped row is the worst defect
available, so the test writes twenty-five rows sharing one timestamp to the
microsecond and walks every page at three different page sizes.

~~Error monitoring~~ — done, and deliberately a table rather than a hosted
service: it costs nothing, keeps failure detail in the same database as
everything it refers to, and can be replaced later by anything that reads it.

Faults are grouped by a fingerprint that strips identifiers and digits, so one
route failing four thousand times reads as one problem rather than four
thousand, and the count of organizations affected is what separates a support
conversation from an outage.

What is **not** recorded matters as much: no request body, no query values, no
headers, no session token, and the route pattern rather than the resolved path.
An error store is a copy of production data under weaker access controls unless
it is disciplined about that, and the test asserts the absence against the
schema rather than against one write — a column added later has to be argued
for.

~~Grid virtualisation~~ — profiled, then done. `pnpm profile:grid` measured the
monthly view of a ten-year forecast at 3,240 interactive cells and a median of
429 ms to switch into, against 163 ms for the annual view. Rendering only the
columns near the viewport took that to 594 cells and 212 ms.

Still above the hundred-millisecond line, and the script says so: the remaining
time is the rows and the re-layout rather than the column count. Row
virtualisation is the next step, not a further pass at the columns.

Still to do: an audit with a real screen reader, and deployment automation with
a rollback path.
~~Backup and restore drill~~ — done, see item 2.

### 9. Optional extras, only if wanted

Excel import, server-side PDF, multi-factor authentication, malware scanning,
yield capitalisation methods, hotel and data-centre modules, and the AI
assistant — which stays disabled by default and adds no paid dependency without
approval.

## Standing rules

- Nothing is marked Tested in `docs/feature-status.md` without automated tests.
- A regression fixture's expected values are never taken from engine output.
- Any change to existing model numbers is a **major** engine version.
- Documentation is updated in the same commit as the behaviour it describes.

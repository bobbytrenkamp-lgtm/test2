# Feature status

**Engine version 3.2.0 · Last verified 2026-08-05**

This matrix describes **what actually exists**. A feature is marked Tested only
when automated tests cover it; Functional means it works and is reachable in the
interface but is not yet covered by tests. Nothing here is marked complete on the
strength of a page existing.

Status values: `Not started` · `Designed` · `In development` · `Functional` ·
`Tested` · `Production ready` · `Deferred`

Nothing is yet marked **Production ready**. That designation is reserved for
features that have also passed the production-hardening pass in
`docs/implementation-roadmap.md` — load testing, an accessibility audit against
a real screen reader, and a restore drill. The restore drill, an engine
performance baseline and a database load test all now run in CI. Still
outstanding: an audit with a real screen reader.

---

## Verification at the last check

```
Tests       502 passed  (229 engine regression, 31 engine unit, 16 fund,
                         13 version comparison, 18 variance, 51 import,
                         23 authorization, 13 budgets, 7 portfolios,
                         10 funds via the API, 17 optimistic locking,
                         5 recovery pools, 7 audit pagination,
                         7 version comparison via the API, 10 error monitoring,
                         5 reforecast, 10 comments, 10 portfolio reports,
                         13 vertical slice)
Browser      50 passed  (3 sign-in, 5 underwriting and the virtualised grid,
                         2 lease editor, 6 permissions, 1 rent-roll import,
                         5 budgets, 6 palette and paste, 5 funds,
                         2 version comparison, 4 review comments,
                         11 accessibility)
Typecheck   clean across all 7 packages and the browser suite
Lint        clean (eslint, --max-warnings=0)
Web build   succeeds (335 kB, 95 kB gzipped)
Migrations  11 applied against PostgreSQL 16
Seed        5 properties, 1 portfolio, 5 frozen versions, all models
            calculated, an approved FY2026 budget and 6 months of actuals
Drill       21 checks passed (dump, restore, valuations reproduced)
Benchmark   4 cases inside budget (111ms single tenant, 4.2s at 300 leases)
Load test   5,000 properties, 200,000 leases; every query inside budget
Concurrency 200 parallel clients, ~1,000 req/s, p95 200ms, 0 failures
Licences    340 packages, none requiring payment or a commercial licence
```

---

## 1. Calculation engine

| Feature | Status | Notes |
| --- | --- | --- |
| Deterministic monthly engine | Tested | Identical output asserted for repeat runs of all 12 fixtures |
| Decimal arithmetic throughout | Tested | 34 digits, half-even; no float on the money path |
| Forecast calendar, leap years, proration | Tested | 13 calendar tests; actual/actual, 30/360, full-month |
| Custom fiscal years | Tested | Labelled by the year they end in |
| Rent steps with mid-month effect | Tested | Segmented billing |
| Escalations: fixed %, fixed amount, index, market reset | Tested | Step resets the escalation clock |
| Escalation floors and caps | Functional | Implemented; no dedicated fixture |
| Free rent, partial and fractional months | Tested | |
| Percentage rent, natural/artificial breakpoints | Tested | Breakpoint moves with base rent |
| Probability-weighted rollover | Tested | Renewal and new-lease branches, downtime, weight pruning |
| Lease options: renewal, termination, contraction | Tested | Probability-weighted paths applied in exercise-date order; 3 fixtures |
| Lease options: expansion, purchase, ROFR, ROFO | Not started | Diagnosed as not modelled, with the reason |
| Speculative lease-up of vacant space | Tested | Added after occupancy was found flat for a whole forecast |
| Market leasing precedence | Functional | Lease → space → default; winner recorded in trace |
| Operating expenses, all 6 methods | Tested | |
| Occupancy-variable expenses | Tested | |
| Revenue/expense fixed-point solver | Functional | 12 passes, 0.005 tolerance; non-convergence diagnosed |
| Recoveries: NNN, base year, stop, fixed, gross | Tested | |
| Multiple recovery pools per lease | Tested | Each pool keeps its own base year, cap history and reconciliation; fixture 16 and 5 API tests |
| Reconciliation and prior-year true-ups | Tested | Estimate billed monthly, difference settled after year end; fixture 17 |
| Gross-up, admin fees, caps and floors | Tested | Cumulative and non-cumulative |
| Recovery detail rows | Tested | Full workings surfaced, per pool, including the estimate and the true-up |
| Vacancy netting (no double deduction) | Tested | Asserted across every fixture |
| Capital, all methods | Functional | |
| Debt: fixed and floating, IO, amortisation | Tested | Closed-form schedule check |
| Rate floors and caps | Tested | |
| Capitalised interest | Functional | Used in the development fixture |
| Fees: origination, exit, unused | Functional | Origination tested |
| Covenant testing (DSCR, LTV, LTC, debt yield) | Tested | |
| Cash-management triggers on breach | Tested | Surplus withheld from equity while breached, released on cure; NOI and unlevered cash flow unchanged. Cash sweep is not modelled |
| Refinancing | Tested | Payoff and replacement funding |
| DCF, end and mid period | Tested | Verified against closed-form annuities |
| Terminal value, forward and trailing | Tested | Falls back and warns when the forecast is short |
| Direct capitalisation | Functional | Year 1, trailing, stabilised |
| IRR, XIRR, NPV, equity multiple | Tested | Bisection; null when no sign change |
| Full return metric set | Functional | Null, never zero, when inputs are missing |
| LP/GP waterfall | Tested | Preferred, ROC, catch-up, promote |
| Sponsor fees | Functional | Acquisition, asset management, disposition only |
| Development and refinance fee bases | Not started | Diagnosed as not modelled |
| Portfolio aggregation | Tested | Rates rebuilt, IRR from combined flows |
| Calculation traces | Tested | Rent, recoveries, terminal value, DCF |
| Diagnostics | Tested | No fixture raises an error |

**Known engine limitations**

- Lease options: renewal, termination and contraction are modelled as
  probability-weighted branches. **Expansion, purchase, ROFR and ROFO are not**,
  and each raises `LEASE_OPTION_NOT_MODELLED` naming the reason — expansion
  because the option records how much area is taken but not which space it comes
  from, the rest because they bear on disposition rather than operating cash
  flow.
- Percentage rent is spread across the year rather than settled at year end.
- A true-up whose reconciliation month falls beyond the forecast is excluded
  from the cash flow, with `RECONCILIATION_OUTSIDE_FORECAST` naming the amount.
  The forecast does not extend far enough to collect it.
- Multi-currency is rejected rather than converted; one model, one currency.
- Yield capitalisation methods (term and reversion, hardcore, equivalent yield)
  are **not started**.

## 2. Data model and persistence

| Feature | Status | Notes |
| --- | --- | --- |
| Organizations, users, memberships | Tested | |
| Sessions, hashed tokens, sliding expiry | Tested | |
| scrypt password hashing, policy, rehash on login | Tested | |
| Password reset | Functional | Token returned in non-production; no mailer |
| Invitations | Tested | |
| Properties, buildings, spaces | Tested | Property and space tested; building CRUD not exposed |
| Tenants and leases | Tested | |
| Rent steps, escalations, recoveries as structured data | Tested | |
| Model-scoped assumption tables | Functional | |
| Immutable model versions | Tested | Snapshot and recalculate |
| Side-by-side version comparison | Tested | What was edited and what it did; both versions recalculated under one engine so an engine change is never mistaken for an edit |
| Calculation runs and traces | Tested | |
| Audit log | Tested | Append-only by convention; no DB-level grant yet |
| Jobs | Functional | Claim, complete, fail with backoff, reap stalled |
| Budgets, actuals, variance commentary | Tested | Full API, interface and tests; see section 9 |
| Documents, comments, tasks, dashboards | Designed | Tables exist and are migrated; no API |

## 3. API

| Feature | Status | Notes |
| --- | --- | --- |
| Registration, login, logout, session | Tested | |
| Organization create, switch, members, invitations | Tested | |
| Property and space CRUD | Tested | |
| Model CRUD, clone, transition | Tested | |
| Lease CRUD | Tested | |
| Assumption collections | Tested | Six collections through one generic handler; row-level optimistic locking covered on every one |
| Calculate, cash flow, trace | Tested | |
| Sensitivity (one- and two-way) | Functional | Full engine run per cell |
| Scenario batch | Functional | Queued to the worker |
| Fund investors and commitments | Tested | Row-level optimistic locking on a commitment; editable on the Funds screen |
| Capital calls and distributions | Tested | Positive amounts only; the type decides the direction |
| Unfunded capital, DPI, RVPI, TVPI, net IRR | Tested | 16 engine tests against hand-derived figures, 10 through the API, 5 in the browser |
| Fund residual value from the held portfolio | Tested | Same roll-up as the portfolio screen; a fund with none says so on screen |
| Fund-level waterfall, recallable distributions | Not started | Documented as not modelled in `fund.ts` rather than approximated |
| Portfolio reports (summary, concentration, expirations) | Tested | Every rate states its own basis in a column |
| Investor statement and capital account | Tested | Built from the same position the screen shows; states its own limits on its face |
| Portfolio aggregate | Tested | One `DISTINCT ON` query regardless of portfolio size; 7 tests covering precedence and both exclusion reasons |
| Reports (JSON, CSV, XLSX, print HTML) | Functional | |
| Portable JSON export | Functional | Documented, non-proprietary |
| Rent-roll import (analyse, validate, commit) | Functional | Parsing itself is Tested |
| Audit read and NDJSON export | Tested | |
| Capability checks on every protected route | Tested | 23 tests |
| Cross-organization isolation | Tested | 10 dedicated tests |
| CSRF header requirement | Tested | |
| Rate limiting | Functional | Global 600/min; 10/min on auth |
| Generated API documentation | Not started | Routes are typed but no OpenAPI document is emitted |

## 4. Web application

| Feature | Status | Notes |
| --- | --- | --- |
| Sign in, organization switching | Functional | |
| Dashboard | Functional | Metrics, type allocation, recent assets |
| Property list, search, filter, create | Functional | |
| Property workspace | Functional | Overview, spaces, models |
| Model workspace with tabs | Functional | Nine tabs |
| Cash-flow statement, monthly and annual | Tested | Frozen first column, tabular figures; browser test covers both granularities |
| Calculation inspector | Tested | Reads the stored trace; recomputes nothing. Browser test requires a named formula, a decimal result and its sources |
| Rent roll grid and lease editor | Tested | Inline date-order validation, asserted in the browser |
| Assumptions, six collections | Functional | Common fields tabulated; full record edited as JSON |
| Returns, valuation, debt schedule, waterfall | Functional | |
| Sensitivity grids and model cloning | Functional | |
| Validation panel and recovery workings | Functional | |
| Reports with four output formats | Functional | |
| Rent-roll import wizard | Tested | Browser test imports a part-invalid file and checks what reached the rent roll |
| Versions and approval workflow | Tested | Comparison covered in the browser suite |
| Comments on a model, property or budget | Tested | Review tab on the model workspace; author-or-approver resolution, mentions restricted to organization members. Four browser tests across two roles |
| Tasks, mentions notifications, activity feed | Not started | `tasks` table migrated and unused |
| Portfolio roll-up | Functional | |
| Jobs and audit history | Functional | |
| Light and dark themes | Functional | Follows the reader's preference |
| Keyboard shortcuts, unsaved-change warning | Tested | Ctrl/Cmd+Enter recalculates; Ctrl/Cmd+K opens the command palette |
| Command palette | Tested | Filters properties, models and screens; arrow keys, Enter, Escape; `aria-activedescendant` |
| Paste a rent roll from a spreadsheet | Tested | Clipboard TSV through the same import pipeline as CSV; preview before writing |
| Charts with data-table alternatives | Functional | Zero-anchored axes |
| Automated UI tests | Tested | 43 Playwright tests in Chromium on the built bundle. Scenarios, reports and the portfolio builder are not yet covered |
| Accessibility, machine-checked | Tested | `axe-core` on nine screens, WCAG 2.0/2.1 A and AA, any violation fails the build |

**Not started in the interface:** multi-cell edit, fill-down, undo/redo, column
hiding, saved views, configurable dashboard widgets, comments, tasks,
notifications, geographic maps, version side-by-side comparison.

## 5. Reporting and imports

| Feature | Status | Notes |
| --- | --- | --- |
| CSV parsing (quotes, newlines, BOM, delimiters) | Tested | |
| Header-row detection under a title block | Tested | |
| Column mapping suggestion | Tested | Never assigns one column twice |
| Number normalisation | Tested | Separator disambiguation documented |
| Date normalisation | Tested | Ambiguity surfaced, not guessed |
| Status and recovery vocabulary mapping | Tested | |
| Validation with per-row findings | Tested | Error rows never import |
| Duplicate detection | Tested | |
| Transactional import, tenant matching | Functional | |
| Reusable mapping templates | Functional | |
| Nine report definitions | Functional | |
| CSV, XLSX, print HTML, JSON output | Functional | |
| **Excel (.xlsx) file import** | **Not started** | Only CSV is parsed today; exceljs can read, it is not wired |
| Server-side PDF rendering | Deferred | Print HTML works via the browser; needs a headless browser in the worker |
| Import rollback | Not started | Import is transactional; no undo after commit |
| Portfolio reports | Not started | Aggregation exists; no report definitions for it |

## 6. Security

| Feature | Status | Notes |
| --- | --- | --- |
| Server-side authorization on every route | Tested | |
| Organization data isolation | Tested | |
| scrypt hashing, hashed session tokens | Tested | |
| Secure cookie flags; Secure required in production | Functional | Enforced at startup |
| CSRF protection | Tested | |
| Content security policy, security headers | Functional | via helmet |
| Input validation on every route | Tested | zod |
| SQL injection prevention | Functional | Parameterised throughout |
| Rate limiting | Functional | |
| Error messages that leak nothing | Functional | Internals logged, never returned |
| Secrets outside source control | Functional | `.env` git-ignored, validated at startup |
| Multi-factor authentication | Not started | `mfa_enrolled` column only |
| Dependency scanning in CI | Functional | `pnpm audit` runs; not yet failing the build |
| Licence gate in CI | Tested | `scripts/check-licences.mjs` fails the build on a paid, commercial or copyleft licence |
| Malware scanning of uploads | Designed | Column exists; no scanner |
| Upload size and type verification | Partial | Body limit enforced; no upload endpoint yet |
| Database backup and restore | Tested | `pnpm drill:restore`: real dump, real restore, 20 checks including that a stored valuation reproduces. Runs in CI |

## 7. Operations

| Feature | Status | Notes |
| --- | --- | --- |
| Environment validation at startup | Functional | Refuses to start misconfigured |
| Migration runner with checksums | Tested | Exercised by every integration test |
| Demonstration seed | Functional | 5 properties, all calculated |
| Background worker | Functional | Not covered by automated tests |
| Structured JSON logs | Functional | Worker; API uses pino |
| Health endpoint | Functional | |
| Docker Compose | **Designed, unverified** | `docker compose config` validates; images still never built — the registry is unreachable from the build environment |
| CI workflow | Functional | Runs format, lint, typecheck, migrations, tests, build and the licence gate. Verified green on GitHub runners |
| Zero-cost posture | Tested | Audited in `docs/zero-cost-operation.md`; licence gate enforced in CI |
| Error monitoring | Not started | No provider wired |
| Deployment automation, rollback | Documented | Process described; not automated |

## 8. Budgets, actuals and variance

| Feature | Status | Notes |
| --- | --- | --- |
| Budget periods, eight kinds | Tested | Original, approved, revised, actual, current/prior forecast, business plan, reforecast |
| Trial-balance import | Tested | Wide and long layouts, month parsing, sign conversion; dry run before anything is written |
| Budget versus actual | Tested | Both sides named explicitly; never assumes one is "the" budget |
| Budget versus forecast | Tested | Reads the model's monthly cash flow directly — no second data entry pass |
| Favourable/unfavourable designation | Tested | From the sign of the variance; category is for grouping only |
| Materiality thresholds | Tested | Amount and percent applied together; below either is neutral |
| Approval freezes a budget | Tested | Entries and deletion refused afterwards |
| Commentary with two-person approval | Tested | Self-approval refused; approved text recorded; rewriting withdraws approval |
| Accounts on one side only | Tested | Reported rather than passing as a full variance |
| Automatic reforecast carry-forward | Not started | A reforecast is a budget period like any other and must be loaded |

## 9. Testing

| Suite | Status | Count |
| --- | --- | --- |
| Engine regression fixtures | Tested | 15 fixtures, 164 assertions |
| Calendar and metrics unit tests | Tested | 31 |
| Variance calculation | Tested | 18 |
| Import parsing, rent roll | Tested | 30 |
| Import parsing, trial balance | Tested | 21 |
| API authorization and isolation | Tested | 23 |
| Budgets, actuals and variance, API | Tested | 13 |
| Vertical slice, end to end | Tested | 13 |
| Browser end-to-end tests | Tested | 35, Chromium only |
| Automated accessibility tests | Tested | 12 screens under `axe-core`; no screen-reader audit yet |
| Property-based tests | Not started | |
| Performance baseline | Tested | `pnpm benchmark`, 4 cases with budgets, runs in CI |
| Database load test | Tested | `pnpm load-test`, 5,000 properties / 200,000 leases, runs in CI at 1,000 |
| Error monitoring | Tested | Unhandled faults recorded and grouped; the store has no column for a body, query, header or session token, asserted against the schema |
| Cash-flow grid virtualisation | Tested | Columns near the viewport only; `aria-colcount` and `aria-colindex` report the true width. Measured with `pnpm profile:grid` |
| Migration rollback safety | Tested | `pnpm check:migrations` refuses a migration the previous release could not run against; gated in CI |
| Concurrency test | Tested | `pnpm concurrency-test`; 200 parallel clients, ~1,000 req/s, 0 failures |
| Optimistic locking, leases and models | Tested | `version` column, 409 on a stale write, true races asserted with `Promise.all` |
| Optimistic locking, assumption collections | Tested | Row-level `version` on all six collections; same-row writers collide, different-row writers do not. 17 locking tests in total |

---

## The honest summary

**Solid.** The calculation engine and its regression library; the database
schema and migrations; authentication, authorization and organization isolation;
the deterministic import parser; the vertical slice from sign-in through to a
traced valuation.

**Works, not yet proven.** Background jobs, reports and exports, sensitivity
and cloning, portfolio aggregation, and the parts of the web application the
browser suite does not reach — the assumptions editor, scenarios, versions,
reports and the portfolio builder. A regression in those would not be caught
automatically.

**Designed only.** Budgets and actuals, variance reporting, collaboration,
dashboard configuration, documents, portfolio reports, Excel import, PDF
rendering, MFA, malware scanning.

**Unverified.** The Docker images have never been built. The Compose file
validates and several defects found by reading the Dockerfiles are fixed, but
the base images cannot be pulled where this was developed — the network policy
blocks Docker Hub's blob CDN. A review is not a build.

Backup and restore is no longer in this category: `pnpm drill:restore` dumps,
restores and confirms a stored valuation reproduces from the restored data, and
runs on every CI build.

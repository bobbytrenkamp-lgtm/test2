# Feature status

**Engine version 1.0.0 · Last verified 2026-08-04**

This matrix describes **what actually exists**. A feature is marked Tested only
when automated tests cover it; Functional means it works and is reachable in the
interface but is not yet covered by tests. Nothing here is marked complete on the
strength of a page existing.

Status values: `Not started` · `Designed` · `In development` · `Functional` ·
`Tested` · `Production ready` · `Deferred`

Nothing is yet marked **Production ready**. That designation is reserved for
features that have also passed the production-hardening pass in
`docs/implementation-roadmap.md` — load testing, an accessibility audit against
a real screen reader, and a restore drill. None of those has been run.

---

## Verification at the last check

```
Tests       218 passed  (125 engine regression, 27 engine unit, 30 import,
                         23 authorization, 13 vertical slice)
Typecheck   clean across all 7 packages
Lint        clean (eslint, --max-warnings=0)
Web build   succeeds (326 kB, 93 kB gzipped)
Migrations  4 applied against PostgreSQL 16
Seed        5 properties, 1 portfolio, all models calculated
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
| Speculative lease-up of vacant space | Tested | Added after occupancy was found flat for a whole forecast |
| Market leasing precedence | Functional | Lease → space → default; winner recorded in trace |
| Operating expenses, all 6 methods | Tested | |
| Occupancy-variable expenses | Tested | |
| Revenue/expense fixed-point solver | Functional | 12 passes, 0.005 tolerance; non-convergence diagnosed |
| Recoveries: NNN, base year, stop, fixed, gross | Tested | |
| Gross-up, admin fees, caps and floors | Tested | Cumulative and non-cumulative |
| Recovery detail rows | Tested | Full workings surfaced |
| Vacancy netting (no double deduction) | Tested | Asserted across every fixture |
| Capital, all methods | Functional | |
| Debt: fixed and floating, IO, amortisation | Tested | Closed-form schedule check |
| Rate floors and caps | Tested | |
| Capitalised interest | Functional | Used in the development fixture |
| Fees: origination, exit, unused | Functional | Origination tested |
| Covenant testing (DSCR, LTV, LTC, debt yield) | Functional | Reported; does not trigger a cash trap |
| Refinancing | Tested | Payoff and replacement funding |
| DCF, end and mid period | Tested | Verified against closed-form annuities |
| Terminal value, forward and trailing | Tested | Falls back and warns when the forecast is short |
| Direct capitalisation | Functional | Year 1, trailing, stabilised |
| IRR, XIRR, NPV, equity multiple | Tested | Bisection; null when no sign change |
| Full return metric set | Functional | Null, never zero, when inputs are missing |
| LP/GP waterfall | Tested | Preferred, ROC, catch-up, promote |
| Sponsor fees | Functional | Acquisition, asset management, disposition only |
| Development and refinance fee bases | Not started | Diagnosed as not modelled |
| Portfolio aggregation | Functional | Rates rebuilt, IRR from combined flows |
| Calculation traces | Tested | Rent, recoveries, terminal value, DCF |
| Diagnostics | Tested | No fixture raises an error |

**Known engine limitations**

- Lease options (renewal, expansion, contraction, termination, purchase, ROFR,
  ROFO) are captured in the schema and persisted, but **do not yet affect the
  cash flow**. Probability-weighted option exercise is not implemented.
- Percentage rent is spread across the year rather than settled at year end.
- Recovery pools are one per lease; multiple simultaneous pools are not modelled.
- Reconciliation timing and prior-year true-ups are not modelled.
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
| Calculation runs and traces | Tested | |
| Audit log | Tested | Append-only by convention; no DB-level grant yet |
| Jobs | Functional | Claim, complete, fail with backoff, reap stalled |
| Documents, imports, budgets, comments, tasks, dashboards | Designed | Tables exist and are migrated; only imports have an API |

## 3. API

| Feature | Status | Notes |
| --- | --- | --- |
| Registration, login, logout, session | Tested | |
| Organization create, switch, members, invitations | Tested | |
| Property and space CRUD | Tested | |
| Model CRUD, clone, transition | Tested | |
| Lease CRUD | Tested | |
| Assumption collections | Functional | Six collections, generic handlers |
| Calculate, cash flow, trace | Tested | |
| Sensitivity (one- and two-way) | Functional | Full engine run per cell |
| Scenario batch | Functional | Queued to the worker |
| Portfolio aggregate | Functional | Reports exclusions rather than zeroing |
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
| Cash-flow statement, monthly and annual | Functional | Frozen first column, tabular figures |
| Calculation inspector | Functional | Reads the stored trace; recomputes nothing |
| Rent roll grid and lease editor | Functional | Inline date-order validation |
| Assumptions, six collections | Functional | Common fields tabulated; full record edited as JSON |
| Returns, valuation, debt schedule, waterfall | Functional | |
| Sensitivity grids and model cloning | Functional | |
| Validation panel and recovery workings | Functional | |
| Reports with four output formats | Functional | |
| Rent-roll import wizard | Functional | |
| Versions and approval workflow | Functional | |
| Portfolio roll-up | Functional | |
| Jobs and audit history | Functional | |
| Light and dark themes | Functional | Follows the reader's preference |
| Keyboard shortcut, unsaved-change warning | Functional | Ctrl/Cmd+Enter recalculates |
| Charts with data-table alternatives | Functional | Zero-anchored axes |
| Automated UI tests | **Not started** | No component or end-to-end browser tests exist |

**Not started in the interface:** copy/paste from Excel, multi-cell edit,
fill-down, undo/redo, column hiding, saved views, command palette, configurable
dashboard widgets, comments, tasks, notifications, budget entry, geographic
maps, version side-by-side comparison.

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
| Database backup and restore | Designed | Documented; **never executed** |

## 7. Operations

| Feature | Status | Notes |
| --- | --- | --- |
| Environment validation at startup | Functional | Refuses to start misconfigured |
| Migration runner with checksums | Tested | Exercised by every integration test |
| Demonstration seed | Functional | 5 properties, all calculated |
| Background worker | Functional | Not covered by automated tests |
| Structured JSON logs | Functional | Worker; API uses pino |
| Health endpoint | Functional | |
| Docker Compose | **Designed, unverified** | Written but never run — no Docker daemon was available |
| CI workflow | Functional | Runs format, lint, typecheck, migrations, tests, build and the licence gate. Verified green on GitHub runners |
| Zero-cost posture | Tested | Audited in `docs/zero-cost-operation.md`; licence gate enforced in CI |
| Error monitoring | Not started | No provider wired |
| Deployment automation, rollback | Documented | Process described; not automated |

## 8. Testing

| Suite | Status | Count |
| --- | --- | --- |
| Engine regression fixtures | Tested | 12 fixtures, 125 assertions |
| Calendar and metrics unit tests | Tested | 27 |
| Import parsing | Tested | 30 |
| API authorization and isolation | Tested | 23 |
| Vertical slice, end to end | Tested | 13 |
| Property-based tests | Not started | |
| Browser end-to-end tests | Not started | |
| Automated accessibility tests | Not started | Built to WCAG 2.2 AA; not machine-verified |
| Performance tests | Not started | |
| Load tests | Not started | |

---

## The honest summary

**Solid.** The calculation engine and its regression library; the database
schema and migrations; authentication, authorization and organization isolation;
the deterministic import parser; the vertical slice from sign-in through to a
traced valuation.

**Works, not yet proven.** The web application in full, background jobs,
reports and exports, sensitivity and cloning, portfolio aggregation. No browser
tests exist, so a UI regression would not be caught automatically.

**Designed only.** Budgets and actuals, variance reporting, collaboration,
dashboard configuration, documents, portfolio reports, Excel import, PDF
rendering, MFA, malware scanning.

**Unverified.** Docker Compose, backup and restore. Both are written down; the
environment this was built in had no Docker daemon, and no restore drill has
been run. They should be exercised before anyone relies on them.

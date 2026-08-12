# Feature status

**Engine version 10.0.0 · Last verified 2026-08-12**

This matrix describes **what actually exists**. A feature is marked Tested only
when automated tests cover it; Functional means it works and is reachable in the
interface but is not yet covered by tests. Nothing here is marked complete on the
strength of a page existing.

Status values: `Not started` · `Designed` · `In development` · `Functional` ·
`Tested` · `Production ready` · `Deferred`

Nothing is yet marked **Production ready**, and this section says exactly why
rather than leaving it to be inferred.

The designation is reserved for features that have passed the
production-hardening pass in `docs/implementation-roadmap.md`. Three things
block it, and **two of them cannot be closed from a development container**:

1. **An audit with a real screen reader — outstanding, needs a person.**
   `axe-core` gates fifteen screens, and `e2e/screen-reader.spec.ts` now walks
   the accessibility tree of eleven screens for the things axe does not check:
   heading ladders with no skipped level, controls a rotor can tell apart,
   tables that announce their own name, landmarks to skip into. That found and
   fixed a real defect — `EmptyState` hard-coded an `h3` at a dozen different
   depths, so any screen whose empty state sat under the page title announced
   an `h1 → h3` skip. **None of that is the audit.** No automated check can
   report whether a valuation is *usable* with JAWS or VoiceOver; that needs
   somebody who uses one.

2. **The container images have never been built.** `docker compose config`
   validates, the Dockerfiles have had real defects fixed by review, and the
   daemon and registry API are both reachable — but the blob CDN
   `production.cloudfront.docker.com` is refused by this environment's egress
   policy, so layers cannot be fetched. A deployment artefact that has never
   been built is not production ready under any reading. One host to allow.

3. **The deploy sequence is documented, not scripted**, and cannot be exercised
   without the images from (2).

Load testing and the restore drill — the two criteria that *were* in reach —
both run in CI on every build, along with a concurrency test, a migration
rollback gate and a documentation-drift gate.

**What would make it production ready:** allow that one host and run
`docker compose build && docker compose up`; have somebody spend an hour with a
screen reader on the cash-flow grid, the rent roll and the assumptions editor;
script the deploy sequence in `docs/deployment-guide.md`. Everything else on
the hardening list is done and gated.

---

## Verification at the last check

```
Tests       1154 passed (251 engine regression, 31 engine unit, 16 fund,
                         13 version comparison, 25 variance, 51 import,
                         26 authorization, 13 budgets, 7 portfolios,
                         10 funds via the API, 17 optimistic locking,
                         5 recovery pools, 7 audit pagination,
                         7 version comparison via the API, 17 error monitoring,
                         5 reforecast, 10 comments, 12 tasks, 31 TOTP,
                         13 multi-factor, 5 route inventory, 9 property-based,
                         12 workbook reading, 5 workbook import,
                         10 portfolio reports, 13 vertical slice,
                         18 Excel Live Model framework,
                         85 Excel Live Model reconciliation,
                         5 Excel Live Model export, 40 grid behaviour,
                         8 batch lease writes, 9 batched assumptions,
                         29 record-editor specs,
                         22 health and drivers,
                         27 the assumption input contract,
                         14 assumption proposals via the API,
                         7 favourites, 5 tenant exposure,
                         89 the writable-target registry,
                         20 the cre-assumption-import parser,
                         20 the deterministic import analyzer,
                         4 the import write path,
                         24 PDF-assumption import via the API,
                         20 property-research schema, 10 research interfaces,
                         8 recommendation-to-proposal conversion,
                         1 application version, 13 entitlements,
                         7 entitlements via the API, 5 organization export,
                         4 debt funded pre-forecast/draw/origination fee,
                         8 waterfall sale truncation and zero-sum shares,
                         4 short-forecast metrics, 2 portfolio boundary cases,
                         3 cash trap through the sale date and multi-facility cure,
                         6 duplicate ids and dangling growth-curve reference,
                         11 zero/negative capitalization/discount rates,
                         3 lease-option branching, 2 recovery pool boundaries)
Browser     198 passed  (3 sign-in, 5 underwriting and the virtualised grid,
                         4 lease editor, search and sort,
                         11 rent-roll spreadsheet editing,
                         7 assumption spreadsheet editing,
                         11 record editors, 8 explainability,
                         11 health, drivers and timeline,
                         6 assumption provenance, 4 favourites,
                         5 tenant exposure, 5 IC summary, 6 permissions,
                         1 rent-roll import, 5 budgets, 6 palette and paste,
                         5 funds, 2 version comparison, 4 review comments,
                         4 tasks, 3 scenarios, 2 reports, 3 portfolio roll-up,
                         3 two-factor, 12 accessibility, 49 accessibility tree,
                         6 PDF-assumption import, 2 organization admin)
Typecheck   clean across all 7 packages and the browser suite
Lint        clean (eslint, --max-warnings=0)
Web build   succeeds (378 kB, 106 kB gzipped)
Migrations  15 applied against PostgreSQL 16
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
| Development and refinance fee bases | Tested | Development fee on capital expenditure as incurred; refinance fee on debt drawn after the first funding period. Fixture 20 |
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
| Comments | Tested | Anchored to a model, property or budget period; API and interface |
| Tasks | Tested | Asset-management work items against a property or model; API and interface |
| Documents, dashboards | Designed | Tables exist and are migrated; no API |

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
| Generated API surface | Tested | `docs/api-surface.md` is printed from the router's own table, so it cannot drift. Not an OpenAPI document: request and response schemas live inside handlers rather than on the route definitions, and a spec with empty schemas would look like a contract and describe nothing |
| PDF-assumption import: target dictionary, analyzer, apply | Tested | `GET /assumption-import/targets` serialises the same writable-target registry the assumption-proposal decision route consults; `POST /assumption-import/analyze` parses and compares a pasted `cre-assumption-import` document against the model with zero writes; `POST /assumption-import/apply` re-analyzes server-side and applies the selected targets atomically as already-accepted proposals, through the same write path a person's edit or a posted proposal uses. See `docs/claude-assumption-import.md` |

## 4. Web application

| Feature | Status | Notes |
| --- | --- | --- |
| Sign in, organization switching | Functional | |
| Dashboard | Functional | Metrics, type allocation, recent assets |
| Property list, search, filter, create | Functional | |
| Property workspace | Functional | Overview, spaces, models |
| Model workspace with tabs | Functional | Fifteen tabs |
| Cash-flow statement, monthly and annual | Tested | Frozen first column, tabular figures; browser test covers both granularities |
| Calculation inspector | Tested | Reads the stored trace; recomputes nothing. Opens from the cash flow and from the traced return metrics. Leads with what made the number up — the contributing tenants, read from the stored calculation — then the formula and its inputs, then links to the lease or record to change. Copies as text. 8 browser tests, including one that follows a link to a rent roll already filtered to the named lease |
| Rent roll: spreadsheet-grade grid | Tested | Multi-cell selection, keyboard navigation, type-to-edit, copy/paste against Excel, fill-down, undo/redo, column show-hide-reorder, frozen identifier columns, density. Edits are held in a pending layer and written through a batched, transactional endpoint. 12 browser tests, one of which changes a rent in a cell and requires NOI to move |
| Rent roll: lease editor | Tested | Still the only way to reach escalations, recoveries, rent steps and options — each is a record, not a value. Inline date-order validation asserted in the browser |
| Rent roll: search and sort | Tested | Searchable by lease, tenant or suite; sortable on six columns with `aria-sort` on the grid header. Area and rent sort numerically, pinned by a lease whose text order differs from its numeric order |
| Assumptions, six collections | Tested | Five of the six are spreadsheet grids sharing the rent roll's primitive and a batched transactional endpoint; growth curves stay a table because a per-year rate list is not a cell. Browser tests change the discount rate *and* an operating expense and require the model to move, so both are proved to reach the engine |
| Structured record editors | Tested | Operating expenses, market leasing and debt open a sectioned form instead of a JSON blob: only the fields the chosen method reads are shown, every CRE term carries an explanation where it is used, and a summary panel reads the record back — labelled as arithmetic, not a calculation. 29 spec tests, 11 browser tests, and the debt form is in the axe sweep. Capital, other revenue and growth curves have no spec yet and still use the raw record |
| Returns, valuation, debt schedule, waterfall | Functional | |
| Sensitivity grids and model cloning | Functional | |
| Validation panel and recovery workings | Functional | |
| Model health | Tested | Deterministic rules over the stored calculation — expiry concentration on a rolling 24-month window, tenant concentration across signed leases only, exit cap compression, covenant breaches, rollover-driven growth, below-market leases, area reconciliation, debt retirement. No overall score, deliberately: each finding states the threshold it crossed so a reader can disagree with the threshold rather than the tool. 22 engine tests, 8 browser tests, in the axe sweep |
| Lease timeline | Tested | Occupancy drawn from the calculation rather than from lease dates, so the engine's own rollover and speculative lease-up appear beside signed leases; a gap is modelled downtime and a faded bar is a probability-weighted branch at its weight. Horizon switches between 12 months and the full forecast |
| Key value drivers | Tested | Ranks assumptions by measured effect, re-running the **real engine** twice per driver rather than approximating — the relationships are not linear. Reports both directions, the range tested, and how many engine runs it took. A driver the model has nothing to move is left out rather than listed at zero |
| Investment committee summary | Tested | One printable page built from the same stored calculation the Returns and Health tabs read — nothing is recomputed, so the summary cannot disagree with the detail behind it. Leads with the Health tab's own warnings rather than a score, each carrying the threshold it crossed. Screen and print only; no PDF export or emailed digest yet. 5 browser tests, in the axe sweep |
| Assumption provenance and the external input contract | Tested | An outside system (`test1` / `test3`) posts what it believes about an assumption; nothing it says reaches the engine. Each proposal is shown beside the underwritten number with the difference, and applied only on an explicit acceptance that writes through the same validated path a typed edit uses. Rejection is recorded rather than deleted, because "we saw the market number and stayed at 3.00%" is the answer to the question a reviewer asks. A target this release cannot model is kept and shown with the Apply button disabled and the reason beside it. Lease terms are deliberately not applicable. 27 contract tests, 14 API tests, 6 browser tests, in the axe sweep. See `docs/assumption-contract.md` |
| PDF-assumption import (paste, review, apply) | Tested | A separate Claude Skill reads a document and outputs a `cre-assumption-import` document; this platform never parses a PDF, calls an AI provider, or does document interpretation of any kind. Paste → Analyze produces a deterministic, zero-write preview per assumption: new, changed, same, needs review, conflict, no matching record, unsupported or invalid, with duplicate evidence merged and a conflict never auto-resolved. Applying re-analyzes server-side, writes the selected targets atomically as already-decided proposals through the existing write path, groups them under one `import_sessions` row for provenance, and recalculates. Lease terms are recognized but never bulk-applied through this pipeline — a dedicated safety class, same as the assumption-proposal contract's. 89 target-registry tests, 20 parser tests, 20 analyzer tests, 4 write-path tests, 24 API tests, 6 browser tests, in the axe sweep. See `docs/claude-assumption-import.md` |
| Favourites and recently viewed | Tested | A star pins a property or model server-side, per person and organization, so it follows a reviewer to wherever they sign in; recently viewed is deliberately kept in the browser's own storage instead, since it is a trace of one device's activity rather than a decision, and is cleared on sign-out so a shared machine cannot leak it to the next person. Both surface on the dashboard and, unprompted, at the top of the command palette. A deleted property or model disappears from the pinned list on its own. 7 API tests, 4 browser tests, in the axe sweep |
| Reports with four output formats | Functional | |
| Rent-roll import wizard | Tested | Browser tests import a part-invalid CSV and a multi-sheet workbook, and check what reached the rent roll. The sheet is chosen in the wizard, not guessed for you |
| Versions and approval workflow | Tested | Comparison covered in the browser suite |
| Comments on a model, property or budget | Tested | Review tab on the model workspace; author-or-approver resolution, mentions restricted to organization members. Four browser tests across two roles |
| Tasks against a property or model | Tested | Board with assignee, due date and status; overdue decided from the reader's own calendar, not the server's. 12 API tests and 4 browser tests |
| Mention notifications, activity feed | Not started | A mention is recorded on the comment and shown in the thread; nobody is told out of band |
| Portfolio roll-up | Functional | |
| Tenant exposure across a portfolio | Tested | Rolls every property's leading model up by tenant identity rather than by name, so a tenant occupying space in several assets shows its true combined share instead of appearing separately on each one's own rent roll. A rollover branch the engine generated counts as that tenant only when it resolves to a real row in `tenants` — checked by matching against the table itself rather than trusting the branch's `scenario` label, which a nested round of speculative rollover can carry (`renewal`) while still describing no real tenant at all. Distinct from the "Tenant concentration" summary folded into every roll-up: that one is a top-20 glance keyed by name; this is the full breakdown, keyed by id, with every property occupied, lease count, credit profile and earliest expiration. 5 API tests, 5 browser tests, in the axe sweep |
| Jobs and audit history | Functional | |
| Light and dark themes | Functional | Follows the reader's preference |
| Keyboard shortcuts, unsaved-change warning | Tested | Ctrl/Cmd+Enter recalculates; Ctrl/Cmd+K opens the command palette |
| Command palette | Tested | Filters properties, models and screens; arrow keys, Enter, Escape; `aria-activedescendant` |
| Paste a rent roll from a spreadsheet | Tested | Clipboard TSV through the same import pipeline as CSV; preview before writing |
| Charts with data-table alternatives | Functional | Zero-anchored axes |
| Automated UI tests | Tested | 126 Playwright tests in Chromium on the built bundle, now including scenarios, reports and the portfolio roll-up |
| Accessibility, machine-checked | Tested | `axe-core` on eleven screens in the dedicated suite plus four more checked in place, WCAG 2.0/2.1 A and AA, any violation fails the build |
| Accessibility tree, audited beyond axe | Tested | Heading ladders, rotor-distinguishable controls, named tables and landmarks across eleven screens. Found and fixed an `h1 → h3` skip from a shared component. **Not** a substitute for a screen-reader audit, and the file says so |

**Still edited as raw JSON:** capital items, other property revenue and growth
curves, which have no `RecordSpec` yet, and a lease's own options and free-rent
periods. The raw view is also deliberately kept behind a control on the three
collections that *do* have a form, because a spec can only offer the fields
somebody thought to put in it, and removing the escape hatch would make the
product less capable than the thing it replaced.

**Not started in the interface:** named saved views (column layout and density
persist per model, but cannot yet be named, listed or shared), drag-to-reorder
columns and drag-fill handles (reordering is button-driven and keyboard-first),
bulk edit as an explicit "apply to N selected" dialog (fill-down and
paste-one-value cover the same ground today), configurable dashboard widgets,
notifications, geographic maps. (Comments, tasks and side-by-side version
comparison were on this list and have since shipped; the rows above are the
current state.)

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
| Excel (.xlsx) file import | Tested | Read into the same rows the CSV pipeline takes, so mapping, validation and duplicate detection are reached unchanged. Multi-sheet with the rent roll suggested; dates, formulas, rich text, error cells and blank columns each covered. `.xls` is not supported and says so |
| Server-side PDF rendering | Deferred | Print HTML works via the browser; needs a headless browser in the worker |
| Import rollback | Not started | Import is transactional; no undo after commit |
| Portfolio reports | Tested | Summary, concentration and lease-expiration definitions, plus an investor statement and capital account for funds. 10 tests |

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
| Multi-factor authentication | Tested | TOTP (RFC 6238) with no new dependency, checked against the RFC's own published vectors. Two-step enrolment, hashed single-use recovery codes, password required to disable. 44 tests plus 3 in the browser |
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
| Health endpoint | Tested | Also reports `appVersion` and `engineVersion`, so a support conversation can establish exactly what customer software produced a result. 1 test |
| Docker Compose | **Designed, never built** | `docker compose config` validates and Dockerfile defects found by reading are fixed. The daemon runs and the registry API answers; the blob CDN `production.cloudfront.docker.com` is blocked by egress policy (403), so layers cannot be fetched. One host to allow; see `docs/deployment-guide.md` |
| CI workflow | Functional | Runs format, lint, typecheck, migrations, tests, build and the licence gate. Verified green on GitHub runners |
| Zero-cost posture | Tested | Audited in `docs/zero-cost-operation.md`; licence gate enforced in CI |
| Error monitoring | Tested | Local: unhandled faults recorded and grouped by fingerprint, pruned at 90 days. No external provider is wired, and none is needed |
| Support-facing error reference | Tested | Every unexpected (500) response carries a short reference (`ERR-482910`) built from the same row `recordError` already writes — no second identifier, no stack trace or SQL ever reaches the client. `GET /operations/errors/reference/:reference` resolves one back for a support conversation, gated on `audit:read`. 7 new tests in `tests/error-monitoring.test.ts` (17 total) |
| Deployment rollback safety | Tested | `pnpm check:migrations` refuses a migration the previous release could not run against; gated in CI. The deploy sequence itself is documented but not scripted |

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
| Reforecast carry-forward | Tested | `buildReforecast` carries closed months forward from actuals and forecasts the rest; `closedThrough` is stated by the caller, never inferred. Unforecast and unposted accounts are reported rather than dropped. 5 tests |

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
| Property-based tests | Tested | Eight invariants over 200 seeded models, no dependency. The generator asserts its own coverage, after the first version silently produced 1,251 rows of zeros and passed everything |
| Documentation drift gate | Tested | `pnpm check:docs` enumerates every suite without running it and fails the build if a stated count is wrong; proved against four kinds of injected drift |
| Performance baseline | Tested | `pnpm benchmark`, 4 cases with budgets, runs in CI |
| Database load test | Tested | `pnpm load-test`, 5,000 properties / 200,000 leases, runs in CI at 1,000 |
| Error monitoring | Tested | Unhandled faults recorded and grouped; the store has no column for a body, query, header or session token, asserted against the schema |
| Cash-flow grid virtualisation | Tested | Columns near the viewport only; `aria-colcount` and `aria-colindex` report the true width. Measured with `pnpm profile:grid` |
| Grid render cost | Tested | Per-cell formatting cut the monthly switch from ~219 ms to ~108 ms, measured four times either side. Row virtualisation is deliberately not done, and the profiler says why |
| Migration rollback safety | Tested | `pnpm check:migrations` refuses a migration the previous release could not run against; gated in CI |
| Concurrency test | Tested | `pnpm concurrency-test`; 200 parallel clients, ~1,000 req/s, 0 failures |
| Optimistic locking, leases and models | Tested | `version` column, 409 on a stale write, true races asserted with `Promise.all` |
| Optimistic locking, assumption collections | Tested | Row-level `version` on all six collections; same-row writers collide, different-row writers do not. 17 locking tests in total |
| PDF-assumption import: target registry, parser, analyzer, write path, API, browser | Tested | 89 + 20 + 20 + 4 + 24 + 6 = 163 tests across `packages/domain-models`, `apps/api` and the browser suite. The target registry is checked against the real collection and model-level schemas in both directions, so a field renamed in one place and not the other fails a test rather than an import |

## 10. Property research (contracts only)

| Feature | Status | Notes |
| --- | --- | --- |
| `cre-property-research` v1 schema and parser | Tested | Observation / comparison / model estimate / recommendation kept as four structurally distinct schemas so a fact cannot masquerade as a recommendation. 20 tests |
| Universal research request, test1 and test3 contracts | Designed | Typed and tested for internal consistency; neither test1 nor test3 is a live endpoint from this repository, so nothing calls them. 10 tests |
| Conversion of a recommendation into an existing assumption proposal | Tested | The only integration point: reuses `assumption_proposals` and `sourceKind: 'recommended'` with no new write path. 8 tests |
| Comparable-selection / percentile engine | Not started | Deliberately deferred; does not require test1 to exist to build |
| Listing/property-URL Claude Skill, live test1/test3 integration, orchestration layer, "Research this property" UI | Not started | See `docs/property-research.md`'s status table for the full breakdown and why each is not yet built |

See `docs/property-research.md` for the full architecture, the boundaries
this area is built to respect (deterministic test2, no scraping, no access-
control bypass, zero-cost by default), and the four-kind separation
(observation / comparison / model estimate / recommendation) this contract
exists to enforce.

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
rendering, MFA, malware scanning, and the property-research contracts
(`cre-property-research`, the test1/test3 interfaces) — schemas and
conversion logic exist and are tested; no live source, comparable-selection
engine or UI is wired to them yet.

**Unverified.** The Docker images have never been built. The Compose file
validates and several defects found by reading the Dockerfiles are fixed, but
the base images cannot be pulled where this was developed — the network policy
blocks Docker Hub's blob CDN — specifically `production.cloudfront.docker.com`, which returns 403 while the registry API itself answers normally. A review is not a build.

Backup and restore is no longer in this category: `pnpm drill:restore` dumps,
restores and confirms a stored valuation reproduces from the restored data, and
runs on every CI build.

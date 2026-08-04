# Implementation roadmap

## Where the build reached

| Phase | Status |
| --- | --- |
| 0. Audit and preservation | **Complete.** Repository was empty; see `docs/repository-assessment.md`. |
| 1. Foundation | **Complete.** Monorepo, environment validation, PostgreSQL, migrations, authentication, organizations, permissions, design system, CI, tests, seed data. |
| 2. Property and lease domain | **Complete.** Properties, buildings, spaces, tenants, leases, rent steps, market leasing assumptions, validation. |
| 3. Calculation engine | **Complete.** Calendar, lease revenue, rent steps, vacancy, expenses, recoveries, NOI, capital, traces, 12 regression fixtures. |
| 4. Valuation and returns | **Complete.** DCF, direct capitalisation, terminal value, sale, IRR, XIRR, equity multiple, NPV, yield metrics. |
| 5. Debt and equity | **Complete.** Facilities, amortisation, floating rates, covenants, refinancing, equity flows, waterfalls. |
| 6. Analyst interface | **Substantially complete, untested.** Workspace, cash-flow grid, validation panel, calculation inspector, one keyboard workflow. Spreadsheet-grade editing is not built. |
| 7. Imports and reports | **Partial.** CSV import with a mapping wizard; Excel and CSV export; nine property reports; print HTML. Excel *import* and server-side PDF are not built. |
| 8. Scenarios and versions | **Partial.** Cloning, immutable versions, sensitivity grids, batch runs, approval workflow. Side-by-side version comparison is not built. |
| 9. Budgets and asset management | **Not started.** Tables are migrated; no API, no interface. |
| 10. Portfolio and funds | **Partial.** Dynamic and static portfolios, aggregation, concentration analysis. Fund-level cash flows and investor reporting are not built. |
| 11. Advanced asset classes | **Partial.** Development, retail percentage rent, multifamily unit modelling work through the common engine. Hotel departmental and data-centre capacity models are not built. |
| 12. Production hardening | **Not started.** No load test, no accessibility audit, no restore drill. |

## What to do next, in order

### 1. Test the web application (largest gap)

It typechecks, builds and has been exercised by hand, but a regression would not
be caught. Add Playwright against the seeded database covering: sign in →
property → model → calculate → inspect a traced figure; the lease editor's
validation; role-based control visibility; and the import wizard. Then add
`@axe-core/playwright` for accessibility.

*Why first: everything below this line risks breaking what already works.*

### 2. Verify what is written but unproven

Run Docker Compose. Run a backup and a restore. Both are documented and neither
has been executed — the environment had no Docker daemon. Until they are run,
treat both as untested.

### 3. Close the engine's honest gaps

- **Lease options.** Renewal, expansion, contraction and termination options are
  persisted but do not affect cash flow. Probability-weighted exercise is the
  single largest remaining piece of financial behaviour.
- **Multiple recovery pools per lease**, reconciliation timing and prior-year
  true-ups.
- **Development and refinance fee bases** in the waterfall.
- **Cash-management triggers** on covenant breach.

### 4. Budgets, actuals and variance (phase 9)

The tables exist. Needed: an actuals import, budget-versus-actual and
forecast-versus-forecast calculations, favourable/unfavourable designation,
commentary with approval, and a reforecast workflow.

### 5. Spreadsheet-grade editing (phase 6)

Copy and paste from Excel, multi-cell edit, fill-down, undo/redo, column
hiding, saved views, a command palette. This is what makes the interface fast for
someone who lives in it all day.

### 6. Collaboration (phase 32 of the brief)

Comments, mentions, tasks, review requests, notifications, activity feed. Tables
are migrated.

### 7. Portfolio reporting and funds (phase 10)

Portfolio `ReportDefinition`s, fund-level cash flows, commitments,
contributions, distributions, unfunded commitments, investor reporting.

### 8. Production hardening (phase 12)

Load test at the stated scale (thousands of properties, hundreds of thousands of
lease steps). Grid virtualisation and cursor pagination once profiling says
where. Accessibility audit with a real screen reader. Error monitoring. Backup
and restore drill. Deployment automation with a rollback path.

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

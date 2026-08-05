# Testing strategy

## The rule that matters

**No expected value in the regression library was produced by running the engine
and copying its output.** Every one is either derived by hand from the fixture's
assumptions, or recomputed in the test by a different method than the engine
uses — a closed-form geometric annuity against the engine's per-period loop, a
closed-form remaining-balance formula against its amortisation schedule.

A test built from the engine's own output agrees with the engine by
construction. It would pass on the day a formula silently breaks.

## What runs

```
pnpm test                      # everything below the browser
DATABASE_URL=... pnpm test     # everything, including database-backed suites
pnpm test:e2e                  # the browser suite, on the built bundle
```

| Suite | Location | Count | Needs a database |
| --- | --- | --- | --- |
| Calendar and date arithmetic | `packages/calculation-engine/src/calendar.test.ts` | 13 | No |
| Metrics and closed-form checks | `packages/calculation-engine/src/metrics.test.ts` | 18 | No |
| Fund investor economics | `packages/calculation-engine/src/fund.test.ts` | 16 | No |
| Version comparison | `packages/calculation-engine/src/compare.test.ts` | 13 | No |
| Regression fixtures and invariants | `packages/calculation-engine/src/regression.test.ts` | 229 | No |
| Budget variance and reforecast | `packages/calculation-engine/src/variance.test.ts` | 25 | No |
| Rent-roll import parsing | `packages/reporting/src/rent-roll-import.test.ts` | 30 | No |
| Trial-balance import parsing | `packages/reporting/src/actuals-import.test.ts` | 21 | No |
| Authorization and isolation | `tests/authorization.test.ts` | 23 | Yes |
| Budgets, actuals and variance | `tests/budgets.test.ts` | 13 | Yes |
| Portfolio aggregation | `tests/portfolios.test.ts` | 7 | Yes |
| Optimistic locking, leases, models and collections | `tests/lease-concurrency.test.ts` | 17 | Yes |
| Recovery pools through the API | `tests/recovery-pools.test.ts` | 5 | Yes |
| Funds through the API | `tests/funds.test.ts` | 10 | Yes |
| Audit keyset pagination | `tests/audit-pagination.test.ts` | 7 | Yes |
| Version comparison through the API | `tests/version-compare.test.ts` | 7 | Yes |
| Error monitoring and its redaction | `tests/error-monitoring.test.ts` | 10 | Yes |
| Reforecast carry-forward | `tests/reforecast.test.ts` | 5 | Yes |
| Comments and who may resolve them | `tests/collaboration.test.ts` | 10 | Yes |
| Tasks, their links and their completion date | `tests/tasks.test.ts` | 12 | Yes |
| Portfolio and fund reports | `tests/portfolio-reports.test.ts` | 10 | Yes |
| Vertical slice, end to end | `tests/vertical-slice.test.ts` | 13 | Yes |

**514 tests in total.**

Database suites skip cleanly when no `DATABASE_URL` is set, so the engine tests
run anywhere.

The browser suite is separate because it needs a browser, a running API and a
built bundle:

| Suite | Location | Count |
| --- | --- | --- |
| Sign-in, one per role | `e2e/auth.setup.ts` | 3 |
| Underwriting path, the inspector, and the virtualised grid | `e2e/underwriting.spec.ts` | 5 |
| Lease editor validation, rent-roll search and sort | `e2e/rent-roll.spec.ts` | 4 |
| Capability-driven control visibility | `e2e/permissions.spec.ts` | 6 |
| Rent-roll import wizard | `e2e/imports.spec.ts` | 1 |
| Accessibility, `axe-core` | `e2e/accessibility.spec.ts` | 11 |
| Fund positions | `e2e/funds.spec.ts` | 5 |
| Version comparison | `e2e/versions.spec.ts` | 2 |
| Review comments, across two roles | `e2e/review.spec.ts` | 4 |
| Budgets, variance and its accessibility | `e2e/budgets.spec.ts` | 5 |
| Command palette and spreadsheet paste | `e2e/productivity.spec.ts` | 6 |
| Asset-management tasks, across two roles | `e2e/tasks.spec.ts` | 4 |

**56 browser tests in total**, for 570 across the whole repository.

The browser table counts the three sign-in setups, which is what `pnpm test:e2e`
reports.

## The regression library

Twenty independently designed fictional properties:

1. Single-tenant industrial, triple net, 3% compounding escalations
2. Multi-tenant office with base-year recoveries and rollover
3. Grocery-anchored retail with percentage rent
4. Multifamily on a per-unit basis
5. Development project with draws and capitalised interest
6. Mixed use
7. Base-year recovery in isolation
8. Expense stop at a half-building share
9. Percentage rent on a natural breakpoint
10. Floating-rate debt with an index floor
11. Amortising loan replaced by a refinancing
12. LP/GP waterfall with preferred, catch-up and promote
13. Renewal option at 60%, extending a three-year term by two years
14. Termination option at 25%, ending a five-year term mid-2028
15. Contraction option at 50%, handing back 4,000 of 10,000 sqft
16. Two recovery pools on one lease, settling on different terms
17. Recoveries estimated on the prior year and reconciled three months in arrears
18. A lease covering part of a space, with recoveries
19. A covenant breach that traps cash, and the cure that releases it
20. Development and refinance fees, on bases that can be checked by hand

Each fixture stores its inputs (the fixture function), its expected outputs (the
assertions), the assumptions behind them (comments stating the arithmetic), a
tolerance (per assertion — exact string equality where decimal arithmetic is
exact, `toBeCloseTo` where a closed-form check in double precision is the
reference) and the engine version (asserted on every result).

### Worked examples the suite proves

- $6.00/sf on 100,000 sf escalating 3% each January gives exactly 600,000 /
  618,000 / 636,540 / 655,636.20 / 675,305.29.
- A base-year structure holds NOI **exactly flat at 500,000** against an expense
  growing 10% a year — the property of a base-year stop, and a sharp test of the
  recovery mathematics.
- An expense stop at $8.00/sf on a 50% share of a $10.00/sf pool recovers
  exactly 100,000, while the full-service tenant in the same building recovers
  nothing.
- A natural breakpoint of 6,000,000 against 8,000,000 of sales at 5% yields
  100,000 of overage, rising to 120,000 as sales grow while base rent is flat.
- A floating rate of index + 250bp binds against its 6.5% floor in years three
  and four, exactly as the index path predicts.
- A 30-year amortisation matches `B_k = P(1+r)^k − pmt((1+r)^k − 1)/r`.
- Two pools on one lease: operating costs capped at 5% a year reach 110,250 in
  the third year while the uncapped tax pool grows unhindered to 181,500. Merged
  into one capped entitlement the total would have been 275,625 instead of
  291,750 — the tax recovery would have been capped by a clause that says nothing
  about taxes.
- A fund contributing 1,000,000 and receiving 1,500,000 exactly 1,096 days later
  returns `1.5^(365/1096) − 1`, computed in the test from `Math.pow`, which
  shares no code with the engine's decimal bisection.
- The option fixtures are deliberately plain enough to check in one line:
  10,000 sqft at $24.00/sqft/yr is $240,000 a year and exactly $20,000 a month,
  so a 25% termination half way through 2028 gives
  `0.25 × 120,000 + 0.75 × 240,000 = 210,000`, and a 50% contraction to 6,000
  sqft gives `0.5 × 144,000 + 0.5 × 240,000 = 192,000`.

### Invariants asserted on every fixture

- Repeat runs are byte-identical.
- Effective gross revenue reconciles to its components.
- Scheduled base rent reconciles to potential rent less vacancy and free rent.
- Unlevered cash flow reconciles to NOI less capital.
- Occupied plus available area equals rentable area; occupancy stays in 0–100%.
- General vacancy never exceeds its target rate where modelled vacancy exists.
- No fixture raises a critical error.

## The vertical slice

Thirteen steps against a real database and the real HTTP routes: sign in →
create an organization → create a property and space → create a model → add a
tenant and a lease with a rent step → reject an inverted lease term → calculate
→ verify revenue and NOI → reopen and read the stored cash flow → verify the DCF
against a closed-form calculation → trace the rent → trace the terminal value
and present value → snapshot a version and recalculate it → approve and confirm
the model freezes → confirm the whole sequence is in the audit log.

Nothing is stubbed. If persistence, authorization or the engine were broken,
this fails.

## The browser suite

`pnpm test:e2e` drives Chromium against the **built** bundle served by `vite
preview`, not the development server, so what the browser exercises is the
artefact that would be deployed. It talks to a real Fastify API and a real
PostgreSQL database through the same-origin `/api` proxy the production
deployment uses, so the session cookie behaves identically.

Every run starts from a known state. `e2e/prepare-database.ts` creates the
`cre_platform_e2e` database if it is absent, drops and rebuilds its schema from
the migrations, and re-seeds it. It refuses to run against a database whose name
does not contain `e2e`. Nothing is reused between runs — not the database, not
the saved sessions — so a failure is a regression rather than yesterday's
leftover row.

Authentication happens once per role in a setup project and the session is
reused. The login route is rate limited, correctly, and a suite that signed in
for every test would exhaust that budget and fail for the wrong reason.

### What it asserts

- **The underwriting path.** Property → model → calculate → open a figure in the
  calculation inspector and require the engine's own trace for it: a named
  formula, a decimal result, and the sources it read. A number appearing on
  screen is not enough; a cash flow that cannot be explained is not an answer.
- **Lease validation.** An inverted term is refused at the point of entry, the
  field is marked `aria-invalid`, saving is blocked, and correcting the date
  clears the objection without a reload.
- **Capability-driven visibility, in both directions.** A reviewer loses the
  controls that write and keeps `model:calculate`, which their role genuinely
  carries. Asserting only the absences would pass equally well for a screen that
  showed a reviewer nothing at all. An analyst is refused `/audit` by the server,
  which proves the check is not merely a hidden link.
- **The import wizard**, on a file that is deliberately half wrong: the sound row
  reaches the rent roll, the broken row is named, refused and counted.

### Accessibility

`@axe-core/playwright` runs against ten screens under `wcag2a`, `wcag2aa`,
`wcag21a` and `wcag21aa`, and **any** violation fails the build. There is no
allow-list of known failures — one would become permanent within a month.

These are the mechanical failures only. An audit with a real screen reader has
still not been done, and remains on the roadmap.

An intermittent failure in the cash-flow test turned out to be a defect the axe
rules do not cover: two live regions were on screen at once — the model's result
banner and a panel still loading beneath it — and neither had a name. Nothing
could tell them apart, which is a problem for a screen-reader user before it is
a problem for a test, because the announcement gives no clue which region spoke.
Every `role="status"` region now carries an `aria-label`, and the tests address
them by name.

## The performance baseline

```
pnpm benchmark
```

Four synthetic models of increasing size, timed with a warm-up pass discarded,
each against a budget. Exceeding a budget fails the process, so a regression
breaks the build rather than sitting unread in a log. The budgets are loose on
purpose: they catch an order-of-magnitude change, not the few percent of noise a
shared runner produces.

The number that matters is not any single timing but the **work per
lease-month** across the range. Flat means the cost is linear in the model,
which is what makes scale a question of hardware and queueing. Rising sharply
would mean something is superlinear in the lease count, and no amount of
hardware fixes that.

Absolute timings are not portable between machines and the script says so in its
own output.

## The database load test

```
pnpm load-test                      # 1,000 properties
LOAD_PROPERTIES=5000 pnpm load-test
```

Builds a scratch organization — properties, models, leases, stored calculations
and audit rows — times the queries the interface actually issues, then drops the
database again. It refuses to run against a database whose name does not mark it
as disposable, exactly as the restore drill does.

The engine benchmark and this measure different failure modes. An engine that is
linear in the model tells you nothing about a list query that scans a table, or
a loop that issues one round trip per property. Both are needed.

It found the second of those: portfolio aggregation was issuing two queries per
property in a sequential loop. See `docs/architecture.md`.

## The concurrency test

```
pnpm concurrency-test
CONCURRENCY=200 ROUNDS=5 pnpm concurrency-test
```

Drives the real Fastify server, with its real connection pool, through a mix of
reads weighted the way a working day is. It fails on any request error, on a
failed concurrent write, or on a p95 outside budget. It runs in CI at fifty
clients — fewer than a local run, because a shared runner has less CPU and the
point in CI is to catch failures and deadlocks rather than to chase a throughput
number that would not be portable anyway.

It reports percentiles, not an average. An average hides the request that took
four seconds behind the ninety-nine that took ten milliseconds, and the slow one
is the one someone notices.

It corrected an assumption: the connection pool is not the constraint. See
`docs/architecture.md`.

## Test isolation

Each database suite creates its own PostgreSQL **schema**, migrates into it, and
drops it afterwards. Real constraints, real transactions, real SQL. Testing
organization isolation against a mock would prove nothing.

## Bugs these tests actually caught

Recording these because they are the argument for the approach:

1. **Interest never accrued in a loan's funding month.** Interest was computed
   on the pre-draw balance, so a loan funded on day one earned nothing in month
   one. Caught by asserting `6,000,000 × 7.5% ÷ 12 = 37,500`.
2. **Vacant space never leased up.** A suite with no lease sat empty for the
   entire 120-month forecast — occupancy flat, value understated by roughly 40%.
   Caught by inspecting seeded output, and fixed with speculative lease-up.
3. **`12,500` parsed as 12.5.** Separator disambiguation treated a lone comma as
   a decimal point. Caught by the import tests.
4. **Rows with errors still imported.** A lease expiring before it commenced was
   reported *and* imported. Caught by asserting the importable set was empty.
5. **Every framework client error reported as a 500.** A malformed request
   looked like a server fault. Caught by the vertical slice.
6. **Concurrent migrations raced on `CREATE EXTENSION`.** Two suites preparing
   their own schemas in the same database both ran `CREATE EXTENSION IF NOT
   EXISTS pgcrypto`; the check and the catalogue insert are not atomic, so the
   loser died on a duplicate key. The same race would hit two API instances
   restarting together. Fixed with an advisory lock around the whole run.
7. **Every form control in the platform was unlabelled.** The shared `Field`
   component rendered a `<label>` as a sibling of its input with no `htmlFor`,
   so a screen reader announced an unnamed text box on every form, and the hint
   text — often the part saying what format a rate has to be in — was never read
   at all. Caught on the first line of the first browser test.
8. **Scrollable tables were unreachable by keyboard.** Containers that scroll
   but cannot be focused leave their content visible and inaccessible. Caught by
   the axe checks on the returns tab.
9. **Rows were written to the rent roll with no confirmation.** The import
   wizard's commit button worked and said nothing, leaving the analyst to guess
   whether it had. Caught while writing the import test.
10. **The seed never froze a model version**, so the demonstration data had an
    empty Versions tab and the restore drill had no stored valuation to
    reproduce. Caught by the drill on its first run.
11. **A lease holding part of a space reported the space fully occupied.**
    Physical occupancy came from how much of the *period* an occurrence covered,
    ignoring how much of the *area* it held. Caught by the contraction fixture,
    which expected 80% occupancy and got 100%. This one changed existing model
    numbers, so it took the engine to 2.0.0.
12. **Optimistic locking on models did not lock.** The version check and the
    update ran as two separate statements, each committing on its own pooled
    connection, so the row lock was released before the write and two
    simultaneous writers both passed. The sequential test passed; the test that
    fires both through `Promise.all` failed. Written that way on purpose.
13. **A single-tenant model took 2.4 seconds to calculate**, almost all of it
    independent of the number of leases. `discountFactor` and `xirr` each took a
    *fractional* power — decimal.js's most expensive operation, routed through a
    logarithm and an exponential at 34 digits — once per period, on each of 200
    bisection steps. Caught by the first run of `pnpm benchmark`; 18× faster
    after, with no calculated figure changed.

## Gaps, stated plainly

**Not started:** property-based tests, performance and load tests, worker tests,
mutation testing, an audit with a real screen reader.

The browser suite covers the paths listed above. It does not cover the
assumptions editor, the scenario grid, versions, reports or the portfolio
builder, and it runs in Chromium only. Cross-browser and the remaining screens
are the next increment, not a claim already made.

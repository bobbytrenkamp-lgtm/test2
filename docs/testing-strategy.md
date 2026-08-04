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
pnpm test                      # everything
DATABASE_URL=... pnpm test     # everything, including database-backed suites
```

| Suite | Location | Count | Needs a database |
| --- | --- | --- | --- |
| Calendar and date arithmetic | `packages/calculation-engine/src/calendar.test.ts` | 13 | No |
| Metrics and closed-form checks | `packages/calculation-engine/src/metrics.test.ts` | 14 | No |
| Regression fixtures and invariants | `packages/calculation-engine/src/regression.test.ts` | 125 | No |
| Import parsing and normalisation | `packages/reporting/src/rent-roll-import.test.ts` | 30 | No |
| Authorization and isolation | `tests/authorization.test.ts` | 23 | Yes |
| Vertical slice, end to end | `tests/vertical-slice.test.ts` | 13 | Yes |

**218 tests in total.**

Database suites skip cleanly when no `DATABASE_URL` is set, so the engine tests
run anywhere.

## The regression library

Twelve independently designed fictional properties:

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

## Gaps, stated plainly

**Not started:** property-based tests, browser end-to-end tests, automated
accessibility tests, performance and load tests, worker tests, mutation testing.

The web application has **no automated tests at all**. It typechecks and builds,
and it has been exercised by hand against the seeded database, but a UI
regression would not be caught automatically. That is the largest gap in the
suite and the first thing the roadmap addresses.

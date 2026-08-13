# Calculation specification

Engine version **13.0.0** — `packages/calculation-engine`.

This document states what the engine computes and how. It is the reference a
reviewer should be able to check a number against by hand. Every formula here
is derived from generally accepted commercial real estate finance and
accounting practice; none of it is taken from, or intended to reproduce, any
particular vendor's proprietary behaviour. Where a convention is a judgement
call, the choice and its reasoning are stated rather than left implicit.

## Contents

1. [Principles](#1-principles)
2. [Arithmetic and rounding](#2-arithmetic-and-rounding)
3. [The forecast calendar](#3-the-forecast-calendar)
4. [Growth curves](#4-growth-curves)
5. [Lease revenue](#5-lease-revenue)
6. [Rollover and market leasing](#6-rollover-and-market-leasing)
6a. [Lease options](#6a-lease-options)
7. [Percentage rent](#7-percentage-rent)
8. [Operating expenses](#8-operating-expenses)
9. [Expense recoveries](#9-expense-recoveries)
10. [Vacancy and credit loss](#10-vacancy-and-credit-loss)
11. [The cash-flow line stack](#11-the-cash-flow-line-stack)
12. [Capital](#12-capital)
13. [Debt](#13-debt)
14. [Valuation](#14-valuation)
15. [Return metrics](#15-return-metrics)
16. [Equity waterfall](#16-equity-waterfall)
17. [Portfolio aggregation](#17-portfolio-aggregation)
18. [Diagnostics](#18-diagnostics)
19. [Calculation traces](#19-calculation-traces)
19a. [Underwriting health and driver ranking](#19a-underwriting-health-and-driver-ranking)
20. [Versioning](#20-versioning)
21. [Budget, actuals and variance](#21-budget-actuals-and-variance)

---

## 1. Principles

**Determinism.** `calculate(input)` is a pure function of its input and the
engine version. It reads no clock, no database, no environment. The only
non-deterministic field in the output is `calculatedAt`, which callers may
inject. The regression suite asserts that running any fixture twice produces
byte-identical monthly series, valuations and returns.

**No silent zeros.** A missing critical input produces a diagnostic and, where
the figure cannot be computed, `null` — never `0`. A model with no purchase
price reports an unavailable going-in yield rather than a 0% one.

**Explainability.** Any material output can be traced to the assumption and
formula that produced it (§19).

**Isolation.** The engine imports nothing but `decimal.js` and the shared type
package. It cannot reach the network or the filesystem.

---

## 2. Arithmetic and rounding

All arithmetic uses `decimal.js` configured once, in `decimal.ts`:

| Setting | Value | Why |
| --- | --- | --- |
| `precision` | 34 significant digits | Covers portfolio-scale amounts with room for the division that discounting and pro-rata allocation require |
| `rounding` | `ROUND_HALF_EVEN` | Banker's rounding; a long additive chain does not drift upward |
| `toExpNeg` / `toExpPos` | −30 / 30 | Keeps values in plain notation across the range that occurs in practice |

Intermediate results are **never** rounded. Rounding happens once, at the
boundary of the engine:

- currency → 2 decimal places, half-even
- rates and ratios → 8 decimal places
- areas → 4 decimal places

Values leave the engine as **decimal strings**, not JavaScript numbers, and are
stored in PostgreSQL `numeric` columns read back as strings. A money figure
never passes through binary floating point between the engine and the screen.

`allocate(total, weights)` distributes an amount across weights and pushes any
rounding residual onto the largest share, so the parts always sum exactly back
to the total.

---

## 3. The forecast calendar

A forecast is *n* consecutive monthly periods beginning on the first day of the
month containing `forecast.startDate`. A start date of 15 March 2026 produces a
first period of 1–31 March 2026.

Dates are `{year, month, day}` triples with pure integer arithmetic. The
JavaScript `Date` object is not used for calendar work, so a forecast produces
identical periods regardless of the server's timezone. Leap years follow the
Gregorian rule and are handled in day counts and in February proration.

### Fiscal years

`fiscalYearStartMonth` (1–12) groups periods into fiscal years. A fiscal year
not starting in January is **labelled by the calendar year in which it ends**,
matching how property accounting teams refer to one: FY2027 = July 2026–June
2027.

### Proration conventions

For a partial period, the billed fraction is:

| Convention | Fraction |
| --- | --- |
| `actual_days` (default) | days covered ÷ actual days in that month |
| `thirty_360` | (min(end,30) − min(start,30) + 1) ÷ 30 |
| `full_month` | 1 whenever the interval touches the month at all |

Annual rents are divided by **12**, not by days in year, because leases bill a
twelfth of annual rent each month; proration for partial months is applied
separately, on top.

---

## 4. Growth curves

A curve is a named set of annual rates with a default and optional per-year
overrides. Years are offsets from the forecast start (year 1 = first twelve
forecast months), so a curve is reusable across valuation dates.

The cumulative factor applied to period *i* (0-based) is

```
forecastYear(i) = floor(i / 12) + 1
factor(i)       = Π (1 + rate(y))  for y = 2 … forecastYear(i)
```

Year one therefore carries a factor of exactly 1.0 and growth compounds from
year two. This means an amount entered on a curve is the **year-one** amount,
not a pre-growth base — the most common source of confusion in inflation
modelling, so it is stated here and repeated in the interface.

---

## 5. Lease revenue

### Rate in effect

The contractual rate on a date is found by:

1. **Anchor.** The latest rent step with `startDate ≤ date`, or the lease's
   `baseRent` at `rentStartDate` if no step applies yet.
2. **Escalation** applied from the anchor forward.

> **Precedence rule.** An explicit rent step states the contractual rate
> outright, so it *resets the escalation clock*. Escalation then compounds from
> the step in force. Without this rule a stepped-and-escalating lease would have
> both mechanisms applied to the same period, overstating rent.

Escalation events occur at `firstEscalationDate` (default: `rentStart +
frequencyMonths`) and every `frequencyMonths` thereafter. With *n* events since
the anchor:

| Type | Rate after escalation |
| --- | --- |
| `fixed_percent`, compounding | `anchor × (1 + r)ⁿ` |
| `fixed_percent`, simple | `anchor × (1 + n·r)` |
| `fixed_amount` | `anchor + n·a` |
| `index` | anchor multiplied successively by `(1 + rᵧ)` for each event, `rᵧ` read from the index curve at that event's forecast year |
| `market_reset` | rate replaced by market rent at the most recent event |

`floorRate` and `capRate` clamp each event's rate before it is applied.

### Basis conversion

| Basis | Full-month amount |
| --- | --- |
| `per_area_per_year` | `rate × area ÷ 12` |
| `per_area_per_month` | `rate × area` |
| `annual_amount` | `rate ÷ 12` |
| `monthly_amount` | `rate` |
| `per_unit_per_month` | `rate × units` |

### Segmented billing

A period is split at every rate-change date inside it (steps and escalations).
Rent for the period is `Σ (full-month rate × coverage)` over segments, so a step
effective on the 15th is billed correctly rather than rounded to a month
boundary. Each segment appears in the trace.

### Free rent

A free-rent record is a start date and a number of months, resolved to an
inclusive date range (fractional months become whole days of the month they land
in). The abatement for a period is

```
abatement = billedRent × (freeRentCoverage ÷ leaseCoverage) × abatementShare
```

so a partial month of abatement inside a partial month of occupancy is handled.
Abatement is reported as a **negative** `freeRent` line, and
`scheduledBaseRent = contractualBaseRent + freeRent`.

---

## 6. Rollover and market leasing

### Profile resolution

Precedence, highest first: **lease assignment → space assignment → model
default**, with each profile's own `precedence` value breaking ties within a
level. The winning profile and the candidates considered are recorded in the
trace under `marketLeasing.resolveProfile`.

### Probability weighting

When a lease expires inside the forecast, two branches are generated:

| Branch | Weight | Commences |
| --- | --- | --- |
| Renewal | `p` | day after expiry |
| New lease | `1 − p` | day after expiry **+ downtime months** |

where `p` is the profile's renewal probability. Each branch carries the
profile's own term, free rent, TI and commission for that outcome, and all its
cash flows and occupied area are scaled by its weight.

> **Why weighting rather than branching.** Committing the forecast to a single
> guessed outcome makes the value discontinuous in the renewal probability — a
> 49% assumption and a 51% assumption produce very different answers. Weighting
> makes value move smoothly with the assumption, which is what an assumption
> that is genuinely a probability should do.

Branches chain forward: a renewal that itself expires inside the forecast rolls
again. Chaining stops at 40 generations or when a branch's weight falls below
0.0001, whichever comes first, so the branch count stays bounded.

### Speculative lease-up

Space that **no lease touches anywhere in the forecast** is absorbed
speculatively: it lets after the profile's downtime, on the profile's new-lease
terms, and then rolls over normally.

Space carrying a future or pending lease is left alone — it is pre-let, and
layering a speculative lease on top would double-count it.

> Without this, a vacant suite would sit empty for the entire forecast, holding
> occupancy flat and understating value. It is a modelling gap that is easy to
> miss precisely because nothing errors.

### Vacant-space market rent

For each revenue-producing space and period, vacant area is `area × (1 −
occupiedFraction)`. Market rent on that area at the space's profile is added to
`potentialBaseRent`, and the same amount is deducted as
`absorptionAndTurnoverVacancy`. The two net to the contract rent actually
billed, which is what makes the vacancy visible as a line rather than as an
absence.

---

## 6a. Lease options

An option is a right the tenant holds and may or may not use. The forecast does
not guess which way it goes: the lease expands into **paths**, one per
combination of outcomes, each carrying the product of its probabilities. This is
the same treatment rollover gets, for the same reason — committing the forecast
to one branch produces a number nobody can defend when the other branch happens.

A path is a sequence of occurrences sharing one weight. Its **last** occurrence
is what rollover chains forward from; the earlier ones have already been
superseded within the path. Rolling over from an earlier occurrence as well
would let the same space twice over the same months.

Options are applied in `exerciseDate` order. That ordering is what makes
mutually exclusive options behave without special-casing them: once a
termination has ended the lease in March, a renewal option dated the following
year is unreachable on that path and is skipped there, while remaining live on
every path where the termination lapsed.

Branches below `0.0001` are pruned, matching rollover.

### Renewal

| | |
| --- | --- |
| Exercised, weight `w × p` | The contract term runs to its contractual expiry, then an extension commences the **day after** it for `termMonths`. |
| Lapsed, weight `w × (1 − p)` | The lease is untouched and rolls over normally on expiry. |

`exerciseDate` is the decision point, used to test reachability. It is **not**
the start of the new term: an exercised renewal still runs the lease to its
contractual expiry first. `noticeDate` is recorded and traced but does not
affect the arithmetic.

The option states the rent outright, so contractual steps and escalations from
the original term do not carry into the extension. Rent is set by `rentMethod`:

| `rentMethod` | Rent |
| --- | --- |
| `fixed` | `rentAmount` on `rentBasis`. |
| `market` | The market leasing profile's rent at the date the extension starts, so an option priced at market moves with the market rather than freezing at today's figure. |
| `percent_of_market` | Market at that date × `rentAmount` (a fraction, e.g. `0.95`). |
| `prior_rent` | The rent in force at the end of the preceding term. |

### Termination

The term ends on `exerciseDate` instead of its contractual expiry. Rent steps
falling outside the shortened term stop applying. The space then rolls over from
that date, so it is not lost from the forecast.

### Contraction

The tenant hands back `areaChange` and keeps the rest to the original expiry on
the original terms. The surrendered area becomes **vacant**. Re-letting it would
require assumptions the option does not carry, and leaving it vacant is the
conservative reading. If `areaChange` is not less than the area held, the option
is treated as a termination on that date and a warning is raised.

### Cost convention

`cost` is a **landlord** cost, paid on the date the outcome takes effect. A
termination fee *received* from the tenant is therefore entered as a negative
cost. One sign convention across all option types is easier to reason about than
a per-type rule, but it does mean the sign has to be read deliberately.

### What is not modelled

| Type | Why |
| --- | --- |
| `expansion` | The option records how much area is taken but not **which space** it comes from. Honouring it would either double-count area against whatever already occupies that space, or create rentable area the property does not have. The schema needs a space reference first. |
| `purchase`, `rofr`, `rofo` | These bear on whether and when the asset is sold, not on operating cash flow. Model the disposition through the sale assumptions. |

Each raises `LEASE_OPTION_NOT_MODELLED` at warning severity, naming the type and
the reason, so an option that will not reach the cash flow is never silently
dropped.

---

## 7. Percentage rent

Settled per fiscal year, on annualised figures:

```
sales      = baseSales × salesGrowthFactor(year) − exclusions
baseRent   = (base rent billed in the year) × 12 ÷ occupiedMonths
breakpoint = natural     → baseRent ÷ overagePercent
             artificial  → breakpointAmount
             none        → 0
overage    = max(0, sales − breakpoint) × overagePercent
```

The annual overage is then spread across the months the tenant occupied, in
proportion to occupancy.

A **natural breakpoint is derived from the tenant's own annualised base rent for
that year**, so a rent step or escalation moves the breakpoint with it — which
is what a natural-breakpoint clause describes.

*Convention:* overage is spread across the year rather than posted at year end.
This keeps monthly cash flow smooth. A model needing year-end settlement should
use a custom schedule; that is noted in `docs/feature-status.md` as a known
limitation.

### Straight-line rent

A standalone calculator, not part of `calculate()`'s own output: given a net
rent series (billed rent, already net of free-rent abatement), the constant
monthly amount ASC 842 recognises across the term, and the deferred rent
balance that results.

```
straightLineMonthlyRent = round(sum(actualRent) ÷ n)
recognized[i]            = straightLineMonthlyRent, for every period but the last
recognized[n-1]           = sum(actualRent) − sum(recognized[0..n-2])
deferredBalance[i]        = deferredBalance[i-1] + recognized[i] − actualRent[i]
```

The last period absorbs whatever cent of rounding residual is left, so
`recognized` sums back to exactly the same total as `actualRent` — which is
also why `deferredBalance` always ends at exactly zero: everything recognised
over the term equals everything actually billed, by construction, not as an
assumption the caller has to verify.

The caller supplies the series and decides its span — ordinarily one signed
lease's own net billed rent (`baseRent` plus the already-negative `freeRent`)
over the periods it is in effect inside the forecast. See `debt-sizing.ts`'s
`sizeLoan` for the same design choice made for the same reason: which NOI, or
which lease term, is the caller's judgment call, not this function's.
Reachable at `GET /models/:id/leases/:leaseId/straight-line-rent`, restricted
to a lease's own signed row — a rollover branch is a probability-weighted
possibility, not a signed obligation, and has nothing to straight-line.

---

## 8. Operating expenses

| Method | Monthly amount before adjustment |
| --- | --- |
| `fixed_annual` | `amount ÷ 12 × growth` |
| `per_area_per_year` | `amount × rentableArea ÷ 12 × growth` |
| `per_unit_per_year` | `amount × units ÷ 12 × growth` |
| `percent_of_effective_gross_revenue` | `amount × EGR(period)` |
| `percent_of_base_rent` | `amount × scheduledBaseRent(period)` |
| `custom_monthly_schedule` | `schedule[i] × growth` |

The occupancy-variable portion scales with physical occupancy:

```
charged = base × (fixedShare + variableShare × occupancy)
```

Percentage-of-revenue expenses are not occupancy-adjusted, because the revenue
they are charged on already is.

### The revenue/expense fixed point

A management fee charged as a percentage of effective gross revenue *and*
recoverable from tenants is genuinely circular: the fee raises recoveries, which
raise revenue, which raise the fee. The engine solves this with a damped
fixed-point iteration — up to 12 passes, converging when every period moves by
less than 0.005 currency units. Non-convergence raises
`SOLVER_DID_NOT_CONVERGE` rather than silently reporting the last pass.

---

## 9. Expense recoveries

Recoveries settle on a **fiscal-year** cycle. Partial fiscal years at either end
of the forecast are annualised for the entitlement comparison and re-prorated
afterwards, so a forecast starting in July does not understate a base-year stop.

### Pools

A lease settles one or more **pools**, each a reimbursement structure over its
own set of expense categories, with its own base year, cap history and
reconciliation. Pools do not interact; their results are summed.

A lease with no explicit pools is treated as one implicit pool on the lease-level
terms, reported under the code `default`. That is what every model written before
pools existed means, and why they are unaffected.

The distinction matters because a single pool cannot express an ordinary office
lease: operating costs on a base year with a 5% cap alongside taxes and
insurance net and uncapped forces a choice between capping the taxes and
uncapping the operating costs. Both are wrong. Fixture 16 asserts the two settle
independently, and asserts explicitly that the tax pool carries no cap
adjustment.

### Pool

```
pool_fixed        = Σ recoverable fixed expense over the year
pool_variableFull = Σ recoverable occupancy-variable expense at 100% occupancy
annualiser        = 12 ÷ monthsInFiscalYear

poolActual   = (pool_fixed + pool_variableFull × actualOccupancy)  × annualiser
poolGrossedUp = (pool_fixed + pool_variableFull × grossUpTarget)   × annualiser
```

Included categories are the lease's `includedCategories` if given, otherwise
every category with a non-zero recoverable share; `excludedCategories` always
wins; capitalised expenses are never recoverable.

The variable pool is retained **at full occupancy** rather than at actual, so
grossing up is a multiplication rather than a division — it works at any
occupancy including zero.

### Entitlement by structure

Let `s` be the pro-rata share (`tenantArea ÷ revenueProducingArea`, or an
explicit override).

| Structure | Entitlement |
| --- | --- |
| `triple_net` | `s × poolGrossedUp` |
| `base_year` | `max(0, s × poolGrossedUp − s × basePoolGrossedUp)` |
| `expense_stop` | `max(0, s × poolGrossedUp − stopPerArea × tenantArea)` |
| `fixed_amount` | `fixedAmount × (1 + escalation)^(yearOrdinal − 1)` |
| `full_service_gross`, `none` | 0 |

A base year outside the forecast raises `BASE_YEAR_OUTSIDE_FORECAST` and falls
back to the first forecast year. A zero denominator raises
`RECOVERY_DENOMINATOR_ZERO` and recovers nothing rather than dividing by zero.

### Fees and caps

```
adminFee      = entitlement × adminFeePercent
beforeCaps    = entitlement + adminFee
cumulative    → ceiling = firstYearRecovery × (1 + cap)^(yearOrdinal − 1)
non-cumulative→ ceiling = priorYearRecovery × (1 + cap)
final         = clamp(beforeCaps, floor, ceiling)
```

The admin fee is inside the capped amount, which is the more common drafting.

### Reconciliation

A settled year is not necessarily the year's cash. A tenant pays an estimate
monthly and the difference is billed or credited after the year closes, which
moves cash between years and therefore moves the return.

```
estimated  = actual            → the settled amount (nothing to reconcile)
           | prior_year_actual → the previous billed year's settled amount
           | fixed_estimate    → estimatePerArea × tenantArea

trueUp     = settled − estimated
```

The estimate is spread across the months the tenant occupied, exactly as the
settled amount was before. The true-up is a **single amount in a single month**,
`reconciliationLagMonths` after the last period of the fiscal year — measured
from the period the forecast actually modelled, not a nominal year end, so a
forecast that stops mid-year reconciles from where it stopped.

`prior_year_actual` has no prior year in the first billed year and falls back to
that year's own settled amount. The alternative — estimating zero — would defer
an entire year of recovery into one reconciliation month, which is not what any
lease says.

A true-up whose month falls beyond the forecast raises
`RECONCILIATION_OUTSIDE_FORECAST` and is **excluded** from the cash flow. It is
a real receivable the forecast does not extend far enough to collect, and the
diagnostic names the amount so the omission is visible rather than inferred from
a total that does not tie.

The default is `actual` with a zero lag, which settles in the year itself and
reproduces the behaviour that predates this section.

### Transparency

Every settled year emits a `RecoveryDetailRow` carrying the pool code and name,
included categories, tenant area, denominator, pro-rata share, pool before and
after gross-up, base year amount, stop, amount before caps, cap adjustment,
admin fee, final recovery, the estimated amount, the true-up and the period the
true-up lands in (null when it fell outside the forecast). The Validation tab
renders these directly.

---

## 10. Vacancy and credit loss

Absorption and turnover vacancy is already deducted lease by lease. Applying a
general allowance on top would deduct the same vacancy twice, so by default:

```
base            = Σ components listed in vacancy.appliesTo
target          = base × generalVacancyRate
alreadyModelled = |absorptionAndTurnoverVacancy|
generalVacancy  = max(0, target − alreadyModelled)     [netting on, default]
                  target                               [netting off]

creditLoss      = base × creditLossRate
```

The regression suite asserts that when netting is on, the general allowance
never exceeds the target rate on any period of any fixture.

---

## 11. The cash-flow line stack

Revenue is positive; every deduction is negative, so a column sums naturally.

```
   Potential base rent
 + Absorption and turnover vacancy        (negative)
 = Contractual base rent
 + Free rent and abatements               (negative)
 = Scheduled base rent
 + Percentage rent
 + Expense recoveries
 + Other lease revenue
 + Other property revenue
 = Gross potential revenue
 + General vacancy                        (negative)
 + Credit loss                            (negative)
 = Effective gross revenue
 + Operating expenses                     (negative)
 = Net operating income
 + Tenant improvements                    (negative)
 + Leasing commissions                    (negative)
 + Capital expenditures                   (negative)
 = Unlevered cash flow
 + Debt proceeds
 + Interest expense                       (negative)
 + Principal amortization                 (negative)
 + Financing fees                         (negative)
 + Net sale proceeds
 + Debt payoff                            (negative)
 = Levered cash flow
```

Every one of these reconciliations is asserted for every fixture, at both
monthly and annual granularity.

---

## 12. Capital

Methods mirror the expense methods, plus `one_time`, which lands entirely in the
period containing its start date. Items with `startDate` / `endDate` are charged
only inside that window. Capitalised operating expenses are added to capital
expenditure rather than to operating expenses, so they sit below NOI.

---

## 13. Debt

Per facility, per period:

```
beginning  = prior ending balance
balance    = beginning + draws                      (draws fund on day one)
rate       = fixed → fixedRate
             floating → clamp(index(year) + spread, floor, cap)
accrued    = balance × rate ÷ 12
```

Interest accrues on the balance **after** the period's draws, because a draw
funds on the first day of the period and carries a full month of interest.

`capitalizeInterest` adds accrued interest to principal instead of paying it in
cash. After the interest-only period, the level payment is

```
pmt = P·r / (1 − (1 + r)^−n)        (P/n when r = 0)
```

recomputed each period on the current balance and remaining amortization term.
For a fixed rate this reproduces the standard schedule exactly; for a floating
rate it re-amortises as the rate moves, which is how a floating loan behaves.

Fees: origination on the commitment at funding; unused fee on undrawn
commitment monthly; exit fee on the balance at payoff. Payoff occurs at maturity
or at the modelled sale when `repayOnSale` is set.

Covenants are tested each period on trailing-twelve-month NOI against annualised
debt service (DSCR), balance (debt yield), concluded value (LTV) and total cost
(LTC). Breaches are reported, and — when the facility carries `cashTrap` — spring
a cash-management trigger that withholds the surplus from equity until the
covenant has been met for the required consecutive periods; see below.

### Cash-management triggers on covenant breach

Where `cashTrap.enabled` is set, a covenant breach is not just reported — the
period's surplus cash (levered cash flow less any debt proceeds, which are
funding, not performance) is withheld from equity rather than distributed, and
held until the trigger's covenant has been met for `cureConsecutivePeriods`
consecutive periods, at which point the full held balance releases in one period.
The property's own NOI and unlevered cash flow are unaffected either way — this
is a financing outcome, not an operating one. **Cash sweep (applying trapped
cash to principal) is deliberately not modelled**: that would make the
amortisation schedule depend on the cash flow it also produces, a fixed point
the engine does not solve. See `waterfall.ts`'s `applyCashTrap`.

### Loan sizing

A standalone calculation, not part of the period-by-period schedule above:
given a set of target covenants, what loan amount does each one alone allow, and
which is the binding (smallest) constraint?

```
DSCR:        maxAnnualDebtService = sizingNoi ÷ targetDscr
             amortizing → invert the level-payment formula for principal:
                           P = pmt × (1 − (1 + r)^−n) ÷ r
             interest-only (n = 0) → P = maxAnnualDebtService ÷ annualRate
LTV:         P = propertyValue × targetLtv
LTC:         P = totalCost × targetLtc
Debt yield:  P = sizingNoi ÷ targetDebtYield

sizedAmount = min of every constraint the caller supplied
```

Deliberately not folded into the period loop above: that loop's own DSCR test
is circular by construction, computed from the debt service a facility's
*already-modelled* amount produces. Sizing answers the question asked before a
facility exists at all — the caller reads the result and types it into a new
facility's `commitment`, the same way an appraised value is read and typed into
`acquisitionPrice`. `sizingNoi` (which year's NOI to size against — Year 1, a
stabilized year, trailing twelve months) is the caller's judgment call, the same
way `directCapRate`'s NOI basis already is. See `debt-sizing.ts`'s `sizeLoan`,
reachable at `POST /models/:id/debt/size`.

---

## 14. Valuation

### Discount factors

```
end-of-period: (1 + r)^(−i/12)
mid-period:    (1 + r)^(−(i − 0.5)/12)
```

`r` is an **annual effective** rate, raised to a monthly exponent rather than
divided by 12, so it is consistent with how the exit capitalisation rate and the
IRR are quoted.

### Terminal value

```
terminalNOI = forward 12 months after the sale, or trailing 12 ending at it
grossPrice  = terminalNOI ÷ exitCapRate        (or a stated override)
sellingCost = grossPrice × saleCostPercent
netProceeds = grossPrice − sellingCost
```

A forward NOI needs twelve forecast months **after** the sale. When the forecast
is too short, the engine falls back to trailing twelve months and raises
`FORWARD_NOI_UNAVAILABLE` — it never capitalises a partial year silently.

### Discounted cash flow

```
value = Σ_{i=1}^{saleMonth} UCF_i × DF(i)  +  netProceeds × DF(saleMonth)
```

The reversion is discounted on the same convention as the operating flows.

> For a development model, unlevered cash flow includes construction spend, so
> this figure is the project's **net present value**, not a stabilised asset
> value. The two coincide only for a stabilised asset bought at time zero.

### Direct capitalisation

`value = selectedNOI ÷ capRate + adjustments`, where the NOI is year one
(annualised if the first year is partial), the trailing twelve months, or the
stabilised year — the first full year whose NOI grows less than 2% into the
next, else the last full year.

---

## 15. Return metrics

| Metric | Definition |
| --- | --- |
| Unlevered IRR | Rate where `−(price + costs) + Σ UCF_i·(1+r)^(−i/12) + netProceeds·DF = 0` |
| Levered IRR | Same on equity flows, initial equity net of debt funded at closing |
| XIRR | Same, on actual dates, `(1+r)^(−days/365)` |
| Equity multiple | Σ distributions ÷ Σ contributions |
| NPV | `npvMonthly(unlevered flows, discountRate)` |
| Going-in cap rate | Year-1 NOI ÷ acquisition price |
| Stabilised cap rate | Year-2 NOI ÷ acquisition price |
| Yield on cost | Year-1 NOI ÷ (price + costs + capital) |
| DSCR | Trailing-12 NOI ÷ annualised debt service |
| Debt yield | Year-1 NOI ÷ debt balance at month 12 |
| LTV / LTC | Debt at closing ÷ concluded value / total cost |
| Breakeven occupancy | (operating expenses + debt service) ÷ gross potential revenue |
| Value per area / unit | Concluded value ÷ rentable area / units |

**IRR is solved by bisection**, not Newton's method, over `[−0.9999, 100]` with
a fixed 200 iterations. Bisection cannot diverge, and a fixed iteration count
makes the answer reproducible across platforms. When the flows never change
sign, the result is `null` — there is no rate to find, and reporting one would
be fiction.

**Debt funded in the first forecast month is treated as funding at closing:** it
reduces the initial equity outflow rather than appearing as a month-one
distribution.

---

## 16. Equity waterfall

Tiers are evaluated in order on each distribution.

Preferred-return and IRR-hurdle tiers are both implemented as **accrual
accounts**: capital carries a balance accruing at the hurdle rate, and the tier
is satisfied when that balance is paid to zero.

```
monthlyRate = (1 + hurdle)^(1/12) − 1
compounding     → accrued += (unreturnedCapital + accrued) × monthlyRate
non-compounding → accrued += unreturnedCapital × monthlyRate
```

> For a compounding accrual this produces the same outcome as an IRR lookback,
> while remaining closed-form and order-independent — so the result is
> deterministic and auditable. A true lookback would require solving an IRR
> inside every distribution period.

| Tier | Behaviour |
| --- | --- |
| `preferred_return`, `irr_hurdle` | Pay accrued balances pro rata to what each partner is owed |
| `return_of_capital` | Pay down unreturned capital pro rata |
| `catch_up` | Bring the sponsor to `catchUpTargetShare` of profit distributed: `needed = otherProfit × t/(1−t) − sponsorProfit` |
| `residual_split` | Split the remainder on the tier's shares |

Cash remaining after the last tier is allocated on contribution shares and
raises `WATERFALL_RESIDUAL_UNALLOCATED`, so cash is never lost.

Sponsor fees are charged before distributions: acquisition on the basis at time
zero, asset management on effective gross revenue monthly, disposition on gross
sale price. Development and refinance fee bases are **not implemented** and
raise `FEE_TYPE_NOT_MODELLED` rather than being charged at zero.

---

## 17. Portfolio aggregation

Two rules govern everything:

1. **A rate is never averaged as if it were an amount.** A portfolio
   capitalisation rate is rebuilt as portfolio NOI ÷ portfolio value; occupancy
   as portfolio occupied area ÷ portfolio rentable area. Discount and exit cap
   rates, which have no natural portfolio numerator, are value-weighted, and
   that is stated where they are shown.
2. **Portfolio IRR is solved from combined cash flows,** never averaged from
   property returns. Averaging is wrong whenever assets differ in size or
   timing, which they always do.

Members contribute at ownership share. Cash flows are padded to the longest
horizon so a shorter hold does not shift a longer one's timing. A property with
no calculated model is **excluded and reported**, not counted as zero.

---

## 18. Diagnostics

| Severity | Meaning |
| --- | --- |
| `error` | The model is wrong. Cannot be acknowledged; blocks approval. |
| `warning` | The model calculates but something needs a human decision. |
| `informational` | The engine made a documented inference. |
| `accepted_exception` | A warning a reviewer has acknowledged with justification. |

Errors include: lease dates out of order, negative area, duplicate or unknown
space, space let to more than one tenant, occupancy outside 0–100%, zero
recovery denominator, no rentable area with leases present, invalid debt term,
draws exceeding commitment, missing exit assumption, zero exit cap rate, sale
month outside the forecast.

Warnings include: forward NOI unavailable, base year outside forecast, no market
leasing profile, area mismatch between property and space list, rent step
outside term, debt maturing before the sale, solver non-convergence, unallocated
waterfall residual, zero discount rate, lease missing area.

Diagnostics are deduplicated on (code, subject, field) so a per-period loop
cannot flood the panel.

---

## 19. Calculation traces

A trace entry records:

```
target         stable identifier, e.g. "occurrence:L-1:baseRent:24"
formula        e.g. "lease.baseRent", "recovery.base_year", "valuation.dcf"
formulaVersion version of that formula
description    plain-language explanation
inputs         every value that fed the calculation
result         the value produced
sources        record ids it depends on, e.g. ["lease:L-1"]
periodIndex    where applicable
rounding       rounding treatment applied
```

Tracing is opt-in per run — a 240-month model with hundreds of leases would
otherwise emit millions of entries — and can be filtered by target prefix. A
`maxEntries` ceiling emits `TRACE_TRUNCATED` rather than exhausting memory.

Traces are stored separately from results (`calculation_traces`), so an ordinary
cash-flow request does not drag them along. The web client's calculation
inspector reads them directly; it recomputes nothing.

---

## 19a. Underwriting health and driver ranking

Two analyses that sit **beside** the engine rather than inside it, in
`health.ts` and `drivers.ts`. Both are pure functions and neither is part of a
calculation.

### Health

Deterministic rules over `ModelInput` and the `ModelResult` the engine already
produced. No rule recalculates anything: a panel that derived its own NOI could
disagree with the cash-flow statement beside it, and a reader would have no way
to tell which was wrong.

There is deliberately **no overall score**. A model reduced to a number out of
a hundred invites an argument about the number and hides the findings, and any
weighting would be an opinion presented as a measurement. Each finding states
the fact, the threshold it crossed, and where to act.

| Rule | Threshold | Measured on |
| --- | --- | --- |
| Expiry concentration | 20% of rentable area | The worst **rolling** 24 months — a roll is a cliff wherever it lands, and a per-year view reports two unremarkable years |
| Tenant concentration | 25% of year-one base rent | **Signed leases only**; speculative lease-up is space nobody has contracted for, and counting it would name a fictional tenant as the largest exposure |
| Exit cap compression | 25 bps below going-in | The most effective way to make a deal work on paper |
| Covenant breaches | Any | Reported by the engine's own debt schedules |
| Minimum DSCR | 1.25x | Stated even when no covenant is set, so the absence is a choice |
| Rollover-driven growth | 40% of final-year base rent | Contractual escalation is signed; rollover rent is a market forecast |
| Below-market leases | 15% below the profile's market rent | Only where the lease and the profile quote on the same basis |
| Area reconciliation | 0.5% of rentable area | The space list is the denominator of every pro-rata recovery share |
| Debt retirement | Balance under 1 at the horizon | A facility outliving the forecast means the equity was never returned |

### Drivers

Each candidate assumption is moved up and down by a stated amount and the
**whole engine is re-run**. A closed-form sensitivity would be a second model:
the relationships are not linear and several are not monotonic — raising renewal
probability cuts downtime and leasing costs but also stops a below-market lease
rolling to market, and which effect wins depends on the rent roll.

The cost is two engine passes per driver, so it is an explicit action and the
response reports how many runs it performed.

| Driver | Range |
| --- | --- |
| Exit capitalisation rate | ± 50 bps |
| Discount rate | ± 50 bps |
| Market rent | ± 10% |
| Renewal probability | ± 15 points, clamped to [0, 1] |
| Downtime between leases | ± 3 months, floored at 0 |
| Tenant improvement allowance | ± 25% |
| Operating expenses | ± 10% |
| Debt interest rate | ± 100 bps |
| General vacancy allowance | ± 2 points |

The ranking is by **sensitivity, not uncertainty**. An exit cap rate usually
tops the list because the terminal value is NOI divided by it, not because
anybody is unsure what it should be. A driver the model has nothing to move — a
debt rate with no debt — is omitted rather than reported at zero, which would
say the opposite of the truth.

---

## 20. Versioning

`ENGINE_VERSION` is semantic:

- **Patch** — a fix that leaves every existing model's numbers unchanged.
- **Minor** — additive behaviour reachable only through new inputs, or new
  fields on the result where nothing already reported changes.
- **Major** — any change that would alter an existing model's output.

Every stored result and every model version records the engine version that
produced it. `POST /models/:id/versions/:versionId/recalculate` runs a frozen
input under the current engine **without writing the result back**, which is how
an engine upgrade is assessed against approved work before it is adopted.

That is why a purely additive field still moves the minor version: the recorded
version is what tells a consumer which fields a stored result will have.

### 13.0.0

**A tenth audit pass.** Major because its portfolio-aggregation finding
changes `weightedGoingInCapRate` and `loanToValue` for an existing portfolio
with an unvalued member.

- **Portfolio `weightedGoingInCapRate` and `loanToValue` no longer weight
  income and debt from every member against a value basis only some of them
  contributed to.** `grossAssetValue` sums `dcfValue`, which is ZERO for a
  member with neither a `dcf` nor a `direct_capitalization` result — reachable
  by an ordinary, fully-calculable member that simply has no `terminalCapRate`
  and no `directCapRate` configured. That member's own NOI and debt were still
  pulled into both ratios' numerators unconditionally, while its zero
  contribution to `grossAssetValue` silently inflated both ratios by however
  much of the portfolio it represented — the same class of bug 6.0.0 fixed for
  `weightedExitCapRate`, recurring in the two ratios that fix did not touch.
  The plain `year1NetOperatingIncome` and `totalDebt` totals are unaffected
  and still sum every member.
- **The background job reaper now respects `max_attempts`** (`packages/database`,
  not governed by this version number). `reapStalledJobs` unconditionally
  requeued a job whose worker died mid-run; a job whose handler reliably
  crashes the worker process itself could be reaped back to `queued` forever.
  A stalled job that has already reached its attempt limit is now left
  `failed` instead.
- **Rent-roll import now flags every row past the first when a lease
  reference repeats three or more times** (`packages/reporting`, not governed
  by this version number). Only the second occurrence was ever flagged; a
  third or later row silently imported and overwrote an earlier row on write,
  with no error naming what it clobbered.
- **A fourth finding was investigated and left unfixed**: scenario-batch
  numeric overrides accept a non-numeric string, producing `NaN` that defeats
  range guards and eventually throws a cryptic error deep in `computeDcf`.
  Sized for a dedicated round — it needs validation at the API boundary, not
  a one-line engine change.

None of the ~300 regression fixtures at the time exercised a portfolio member
with a calculated result but no valuation at all, which is why it survived
nine prior audit passes despite 6.0.0 fixing the identical bug class in a
sibling ratio.

### 12.0.0

**A ninth audit pass.** Major because its one confirmed engine-level finding
changes covenant-breach reporting — and, wherever a `cashTrap` is wired to the
covenant it fires on, the levered cash flow itself — for an existing
floating-rate facility.

- **A facility's DSCR covenant is now tested against the trailing twelve
  months of debt service it actually paid**, not one month's debt service
  multiplied by twelve. The NOI side of the same ratio already summed a
  trailing window; the debt-service side extrapolated a single period. Level
  debt service (fixed-rate, interest-only, steady-state amortizing) made the
  two identical, which is why every prior covenant fixture passed regardless.
  A floating rate steps at every twelve-month anniversary, which is the
  ordinary shape of a floating facility — at the step, the bug read a breach
  that was not really there, or missed one that was.
- **The Excel Live Model's "Going-in cap rate"** (`packages/reporting`, not
  governed by this version number) **now annualises year 1 NOI on a forecast
  shorter than twelve months**, matching the sibling "Terminal NOI" cell and
  the engine's own `goingInCapRate`, which has annualised since 4.0.0 — a fix
  never carried into this formula.
- **A third lead was investigated and found not reachable**: duplicate ids
  among `FundInvestor` records would double-count contributions in
  `computeFund`, the same class of bug 11.0.0 fixed in the waterfall — but
  unlike a waterfall partner id (free text in a JSON-editable model field),
  `FundInvestor.id` is always a database-generated primary key, which
  Postgres itself refuses to duplicate. No fix was made.

None of the ~300 regression fixtures at the time exercised a floating-rate
facility's covenant across a rate step, or a Live Model export of a short
forecast with a nonzero acquisition price — which is why both survived eight
prior audit passes.

### 11.0.0

**An eighth audit pass.** Major because two findings change numbers an
existing model can already be producing today, silently.

- **Two partner objects sharing the same `id` no longer manufacture cash in
  the waterfall.** Every internal bookkeeping map in `waterfall.ts` was keyed
  on the user-facing partner id, so two partners sharing an id shared one
  map entry, and a tier's split allocation was credited in full to each of
  them independently — paying out more than the tier actually held.
  Partners now carry an internal array-index key for bookkeeping, and a
  split's allocation is divided across however many partner objects match
  its id (ordinarily exactly one) instead of being credited to each in full.
  The existing `DUPLICATE_PARTNER` diagnostic still fires alongside the fix.
- **A revenue- or rent-basis expense's recoverable split no longer has
  occupancy applied twice.** The expense's own reported amount already
  correctly skips occupancy scaling for `percent_of_effective_gross_revenue`
  and `percent_of_base_rent` methods, since their basis is already real,
  occupancy-embedded revenue or rent. The recoverable split made no such
  exception and was later rescaled by occupancy again during recovery
  settlement, understating recovery revenue, EGR, NOI and value for any
  model recovering a management fee or similar charge this way.
- **Two additive diagnostics close the last gaps in 10.0.0's sweeps**:
  `DUPLICATE_MARKET_LEASING_PROFILE` for the one entity type the duplicate-id
  sweep had not yet reached, and `DUPLICATE_GROWTH_CURVE_YEAR` for a second
  rate override on the same year within one growth curve. The dangling-curve
  check now also covers a market leasing profile's own growth-curve and
  escalation-index references.
- Capital items (development/refinance fee bases, cash-management triggers,
  waterfall catch-up and IRR-hurdle tiers) were audited this round with no
  defect found.

None of the ~300 regression fixtures at the time configured two partners
sharing an id, a recoverable revenue-basis expense with a nonzero variable
share, a duplicate market leasing profile id, a duplicate `byYear` entry, or
a dangling curve reference from a market leasing profile — which is why all
of these survived seven prior audit passes.

### 10.0.0

**A seventh audit pass**, following up on one unresolved lead from the sixth
round and covering ground no prior round had targeted (growth curves, and
the version-comparison report). Major because one fix changes a number an
existing comparison would report; the rest are additive diagnostics.

- **Six entity types now refuse a duplicate id with an error**: leases, debt
  facilities, waterfall tiers, partners and growth curves (alongside the
  existing space check). Each is looked up elsewhere by its own id via a
  `Map`, and a duplicate silently shadows one entity's figures with
  another's rather than merging or summing them.
- **A `growthCurveId` that names a curve the model does not have now reports
  `GROWTH_CURVE_NOT_FOUND`** instead of silently resolving to flat 0%
  growth. Unset remains unaffected.
- **`compareResults`'s `percentChange` now reads the direction a reader
  expects on a cost line.** A cost that grew more negative previously
  reported a negative percentage — reading as a decrease when it actually
  increased.
- **The Excel Live Model's Debt sheet** (`packages/reporting`, not governed
  by this version number) **resolves the sale date and a facility's real
  maturity the same way the engine already does**, instead of hardcoding
  the sale as the axis's last period and clamping maturity to it.

None of the ~300 regression fixtures at the time exercised any of these
cases, which is why they survived six prior audit passes.

### 9.0.0

**One further correctness fix, found by a sixth audit pass targeted at
multi-entity interaction** — what happens when more than one instance of the
same kind of thing (here, more than one debt facility) is present, since
every fix through 8.0.0 was a single-entity edge case.

- **A cash trap sprung by one facility no longer waits on a cure requirement
  borrowed from a second, unrelated facility that never itself breaches.**
  The release threshold was the maximum `cureConsecutivePeriods` across
  every cash-trap-enabled facility on the deal, regardless of whether that
  facility ever actually breached. The threshold is now recomputed per trap
  episode from only the facilities actually part of it.

None of the ~300 regression fixtures at the time configured more than one
cash-trap-enabled facility on the same deal, which is why this survived five
prior audit passes.

### 8.0.0

**Three further correctness fixes, found by a fifth audit pass — a general
sweep for the one defect pattern that produced every bug found in the four
rounds before it: a guard added on one code path but not an equally-reachable
sibling** — every one silently produced a wrong figure rather than an error,
which is why this is a major version rather than three patches.

- **A negative discount rate now reports `NEGATIVE_DISCOUNT_RATE`** instead
  of silently inflating present value. `discountFactors` raises `1 + rate`
  to a negative fractional power, so a rate below zero makes each factor
  larger than the last instead of smaller — the DCF value and the
  property-level net present value both grow with distance into the future
  instead of discounting it. Both are now `null` for a negative rate, the
  same treatment `computeSale`/`computeDirectCapitalization` already give a
  negative capitalisation rate.
- **A debt facility's staged draw dated outside the forecast is now refused
  per-draw with `DEBT_DRAW_OUTSIDE_FORECAST`**, the same mechanism
  `DEBT_FUNDED_BEFORE_FORECAST` already applies to the funding date on the
  same facility. One out-of-range draw does not disqualify the rest of the
  facility.
- **An origination fee is now charged at closing regardless of whether a
  draw lands in the same period.** The fee was gated on a draw happening in
  the funding month, so a staged-draw facility that closes with
  `initialFunding: 0` and draws only once work begins — the ordinary shape
  of a construction loan — silently never charged its origination fee.

None of the ~290 regression fixtures at the time exercised a negative
discount rate, a debt draw dated outside the forecast, or a staged-draw
facility with a delayed first draw and an origination fee, which is why all
three survived four prior audit passes.

### 7.0.0

**Four further correctness fixes, found by a fourth audit pass targeted at
lease-option branching and recovery-pool boundary cases** — as with the three
prior audit rounds, every one silently produced a wrong figure rather than an
error, which is why this is a major version rather than four patches.

- **A renewal option no longer drops the exercised branch's weight when the
  current term already runs through (or past) the forecast horizon.** An
  ordinary configuration — any lease whose term happens to span the whole
  hold period — silently understated the lease's own already-elapsed term,
  and at 100% renewal probability erased the lease from the model entirely.
- **A termination option's exercise cost now reaches the cash flow.** The
  fee was recorded in the trace but never applied to `tenantImprovements`;
  every termination fee configured on any model was silently worth $0.
- **A base-year or expense-stop recovery pool's cap or floor no longer pins
  the recovery at zero forever once the first billed year settles at exactly
  zero.** A multiplicative ceiling anchored at a zero baseline capped every
  later year at zero regardless of how much expenses actually grew.
- **Two recovery pools on the same lease that both claim the same expense
  category now warn**, instead of silently doubling the tenant's bill for
  the overlapping category.

None of the ~280 regression fixtures at the time exercised a lease-option
fixture at all, a base-year recovery pool combined with a cap, or two
explicit recovery pools with overlapping categories, which is why all four
survived three prior audit passes.

### 6.0.0

**Three further correctness fixes, found by a third audit pass targeted at
boundary and extreme-value cases the first two passes did not reach** — as
with 4.0.0 and 5.0.0, every one silently produced a wrong figure rather than
an error, which is why this is a major version rather than three patches.

- **A negative exit or direct capitalisation rate now reports a diagnostic**
  (`NEGATIVE_EXIT_CAP_RATE`, `NEGATIVE_DIRECT_CAP_RATE`) instead of silently
  producing a negative valuation. Neither `computeSale` nor
  `computeDirectCapitalization` guarded a negative rate, only an exactly-zero
  one, and the schema places no floor under `terminalCapRate`/`directCapRate`.
  A fat-fingered negative rate divided NOI by a negative number and produced
  a large, plausible-looking negative value with no diagnostic anywhere in
  the chain.
- **The waterfall's residual-unallocated fallback no longer drops cash when
  contribution shares sum to zero.** 5.0.0 fixed the capital-call side of
  this; the distribution-side fallback — reached whenever a period's cash
  flow has no tier left to absorb it — still multiplied by each partner's
  raw, zero contribution share instead of splitting evenly the same way.
- **Portfolio `weightedExitCapRate` no longer weights a member's rate
  against a value basis that excludes that member.** The rate's numerator
  was accumulated whenever a member's exit cap rate was set — copied from
  the input assumption unconditionally — while the denominator was only
  accumulated when a `dcf` valuation existed. A member whose sale month
  falls outside its own forecast still had its rate pulled into the
  numerator with no matching value in the denominator.

None of the ~270 regression fixtures at the time exercised a negative
capitalisation rate, a zero-share waterfall with no residual-split tier, or
a portfolio member whose sale month falls outside its own forecast, which is
why all three survived the first two audit passes.

### 5.0.0

**Four further correctness fixes, found by the same audit's second pass over
boundary and extreme-value cases** — as with 4.0.0, every one silently
produced a wrong figure rather than an error, which is why this is a major
version rather than four patches.

- **A cash trap no longer treats a facility's own funding-period draw as
  trappable surplus.** The trap swept every positive levered cash flow while a
  covenant was breached, and levered cash flow includes debt proceeds. A
  covenant that breaches in the funding month — an annualised one-month NOI
  stub tripping a DSCR threshold a full year would clear is an ordinary way
  for that to happen — could sweep the entire loan proceeds meant to fund the
  acquisition, over-calling equity by that amount. Debt proceeds are now
  excluded from what counts as trappable surplus.
- **A cash trap open when its facility is repaid now releases the held cash
  at the sale date, not at the last index of the stated forecast.** Combined
  with 4.0.0's sale-date truncation of equity cash flow, a trap still open at
  sale lost the held cash outright whenever the forecast ran past the sale
  month, which a `forward_12` terminal NOI basis deliberately does.
- **Partner contribution shares that sum to zero no longer lose the capital
  call.** Every partner entered at a 0% contribution share — plausible while
  a deal's ownership is still being drafted — made the normalising sum zero;
  dividing by it silently zeroed every partner's allocation. Shares summing
  to zero are now split evenly across partners, with a
  `PARTNER_SHARES_SUM_TO_ZERO` error naming the cause.
- **A direct capitalisation rate of exactly zero now reports
  `ZERO_DIRECT_CAP_RATE`** instead of silently producing no valuation, the
  same way the exit cap rate already names `ZERO_EXIT_CAP_RATE`. Behaviour is
  unchanged when `directCapRate` is simply not configured.

None of the ~260 regression fixtures at the time exercised a cash trap still
open at a facility's own funding month, a cash trap still open past the sale
date, contribution shares summing to zero, or an explicit zero direct-cap
rate, which is why all four survived 4.0.0's audit.

### 4.0.0

**Six correctness fixes, found by one repository-wide audit, each changing
existing numbers on the models they affect** — every one silently produced a
wrong figure rather than an error, which is why this is a major version
rather than six patches.

- **Equity distributions stop at the sale date.** `leveredIrr`/
  `equityMultiple` already truncated at the sale month; the equity cash flow
  fed to the waterfall, and `cashOnCashByYear`, did not. A forecast stated
  past its sale month — the ordinary case for a `forward_12` terminal NOI
  basis, which needs NOI *after* the sale — showed partners paid
  distributions for months after the property was sold.
- **A debt facility funded before the forecast start is refused with a
  `DEBT_FUNDED_BEFORE_FORECAST` diagnostic**, not silently run at a zero
  balance. Modelling an existing loan's balance as of the forecast start
  needs its amortisation run from the real funding date, which this engine
  does not do.
- **Direct capitalisation's `trailing_12` and `stabilized` bases are now
  annualised on a forecast shorter than 12 months**, the same way `year_1`
  already was.
- **`goingInCapRate`, `yieldOnCost` and `debtYieldYear1` are now annualised**
  on a forecast shorter than 12 months, for the same reason.
- **`stabilizedCapRate` reports `null`, not a false `"0"`,** when its 13-24
  month window does not exist yet.
- **Portfolio `year1NetOperatingIncome` and `weightedGoingInCapRate` now
  annualise a member's partial first fiscal-year bucket** — a forecast that
  does not start on its own fiscal year's first month.

None of the ~250 regression fixtures exercised a forecast shorter than 12
months, a debt facility funded before the forecast start, a sale month
earlier than the forecast's last month, or a portfolio member starting mid
fiscal year, which is why all six survived as long as they did.

### 3.3.1

**A recovery settlement is now dated to its fiscal year.** The trace entry for a
recovery carried no period at all, because the settlement is annual. That made
it unreachable from anything asking "how was this figure derived?" — the
calculation inspector found nothing and reported, truthfully and uselessly, that
a recovery total had no derivation.

It is now stamped with the first month of the fiscal year it settles. No
calculated value changes: a trace entry is a record of work, and this records
which year's work it is.

### 3.3.0

**Per-partner cash flows, and the partner return on both bases.**

`WaterfallDistribution` described a partner only by totals — contributions,
distributions, profit, a rate of return. A partnership cannot be audited from
those. An investor statement has to say *when* capital was called and when it
came back, and anything discounting a partner's position needs the dated series
rather than a pair of sums. The engine already tracked the series in order to
solve each partner's IRR and simply never reported it.

| Field | Meaning |
| --- | --- |
| `initialFlow` | The partner's share of the equity funded at closing, negative |
| `flows` | One entry per forecast period; negative is a capital call, positive a distribution |
| `xirr` | Annual effective rate on actual/365 day counts |

Contributions and distributions never share a period: a period needing cash is
funded before any tier is paid, so the sign of a flow says unambiguously which
it was. The positive entries sum to `distributions`, the negative entries
including `initialFlow` sum to `-contributions`, and the whole row sums to
`profit`.

`xirr` exists because partners previously reported only `irr`, solved on uniform
monthly periods, while the property beside them reported both that and a
day-count `leveredXirr`. Comparing a partner's return to the deal's therefore
crossed conventions unless the reader knew to pick `leveredIrr`. Both bases are
now reported for both, dated identically — closing on the first period's start,
every later flow on its period end. They differ by a fraction of a basis point
on a monthly series, which is small enough to be invisible and large enough to
matter to anyone reconciling to a spreadsheet.

Additive: no existing figure changes and every pre-existing regression assertion
passes unaltered.

### 3.2.0

**Development and refinance fee bases.** Both types have been in the equity
schema since it was written and neither had a basis, so a model configuring one
charged nothing and said so only in an informational diagnostic — silently
understating what the sponsor takes.

| Fee | Basis |
| --- | --- |
| `development` | Capital expenditure as it is incurred, excluding TI and LC |
| `refinance` | Debt proceeds drawn after the first funding period |

Incurred rather than budgeted, because a fee on a budget is earned by writing
the budget. TI and LC are excluded because a leasing commission already
compensates that work. The initial funding is excluded from the refinance basis
because the acquisition fee already covers putting the deal together, and
charging both would pay twice for one financing.

Where a fee falls while the deal is cash-negative it is funded by the partners
rather than deducted from a distribution — a fee charged against a deficit is a
larger capital call, not a smaller distribution. Fixture 20 asserts both halves
separately.

Additive: a model with no development or refinance fee is unchanged.

### 3.1.0

**Cash-management triggers on covenant breach.** A breach the engine only
reported was a breach with no consequence: the model showed the covenant
failing and distributed the cash anyway, overstating the levered return in
precisely the years a lender is most worried about.

Where a facility carries `cashTrap`, the surplus is withheld from equity while
the breach persists and released once the covenant has been met for
`cureConsecutivePeriods` consecutive periods. Anything still held at the end of
the forecast is released — the facility is repaid on sale, and cash the lender
no longer secures belongs to equity.

Only a surplus can be trapped. A deficit is money the owner has to fund, and a
lender does not collect it by refusing a distribution.

The `restrictedCash` line carries the movement: negative when trapped, positive
when released, netting to zero over any span that does both. NOI and unlevered
cash flow are identical with the trigger on and off, which is what makes this a
financing outcome rather than an operating one.

**Cash sweep is deliberately not modelled.** Applying trapped cash to principal
makes the amortisation schedule depend on the cash flow that depends on the
schedule — a fixed point the engine would have to solve. Approximating it would
misstate the balance, and a misstated balance misstates every covenant tested
against it thereafter.

Additive: the trigger defaults to off, so `restrictedCash` is zero on every
model written before it existed and every regression assertion passes unaltered.

### 3.0.0

**A correction to existing numbers.** A lease covering only part of a space
under-recovered its expenses by exactly its share of that space, and the same
error reached annual other-revenue items.

2.0.0 scaled each occurrence's occupancy series by its share of the area it sits
on. That is right for reporting how full a floor is and wrong as the multiplier
for spreading an annual entitlement across months: the entitlement already
carries the tenant's area through its pro-rata share, so applying the area again
billed a tenant holding 40% of a floor 40% of what it owed.

There are now two series. `occupancyFraction` is area-weighted and reports
occupancy; `timeFraction` is time and probability only, and spreads annual
figures over the months a tenant was present.

No pre-existing fixture moved — every one of them lets whole spaces, which is
how this survived two versions. Fixture 18 covers the case and reproduces the
old figure when the fix is reverted. **Any model where a lease covers part of a
space and recovers expenses will show higher recoveries**, and higher NOI and
value with them.

Additive in the same release: **multiple recovery pools per lease** and
**reconciliation timing**, both described in section 9. Each defaults to the
previous behaviour, and all 164 pre-existing regression assertions pass
unaltered — those two alone would have been a minor bump. Three new fixtures
cover the new paths, with expected values derived by hand from the assumptions
rather than from engine output.

### 2.1.0

Performance only. `discountFactors` and `xirr` each took a **fractional** power
— decimal.js's most expensive operation, routed through a logarithm and an
exponential at 34 digits — once per period, on each of 200 bisection steps.
Both now take it once and derive the rest by multiplication. A single-tenant
ten-year model went from 2,386 ms to 128 ms.

Every reported figure is unchanged: money to the cent, and all regression
fixtures, which assert exact strings, pass unaltered. The version moves because
repeated multiplication is not bit-identical to a direct power at full
precision, and that reaches fields the result serialises untruncated, such as a
loan-to-value ratio. **A valuation stored under 2.0.0 will not compare
byte-for-byte against a 2.1.0 recalculation.** `pnpm drill:restore` reports that
rather than hiding it: it skips stored results from a different engine version
and says how many it skipped.

### 2.0.0

Lease options reach the cash flow (section 6a). On its own that is additive: a
model with no options is unchanged.

What makes it major is the occupancy correction it required. Physical occupancy
of a space was derived from how much of the **period** an occurrence covered,
ignoring how much of the space's **area** it held, so a lease taking 6,000 of a
10,000 sqft suite reported the suite fully occupied. Occupancy is now scaled by
the occurrence's share of the area it sits on.

Any model where a lease covers only part of a space will therefore report
different physical occupancy, and different general vacancy and credit loss with
it, since those are applied to occupancy. None of the twelve pre-existing
regression fixtures moved — they all let whole spaces — but real rent rolls do
not, which is why this is a major bump and not a minor one.


---

## 21. Budget, actuals and variance

### The sign convention decides everything else

Every amount follows the cash-flow statement's convention: **money in positive,
money out negative.** An expense budget of 50,000 is stored as `-50000`.

Under it, a favourable variance is simply a positive one — for every account,
with no reference to whether the line is revenue or cost:

| | Base | Comparison | Variance | Reading |
| --- | --- | --- | --- | --- |
| Revenue | 100 | 120 | +20 | more income — favourable |
| Revenue | 100 | 80 | −20 | less income — unfavourable |
| Expense | −50 | −60 | −10 | spent more — unfavourable |
| Expense | −50 | −40 | +10 | spent less — favourable |

The alternative — costs positive, with the comparison flipped for cost accounts
— needs a correct category on every row to produce a correct answer, and
silently reports the opposite of the truth when one is wrong. Here a
miscategorised row lands in the wrong subtotal, which someone notices, rather
than reversing its own variance, which nobody would.

The account category is therefore used for **grouping and subtotals only**.

It also makes a total a plain sum. Net operating income is
`revenue + expenses`, not a category-aware subtraction.

### The comparison

`variance = comparison − base`, both sides named explicitly. Nothing assumes the
base is "the" budget: measuring a reforecast against the original budget and
against the approved budget are different questions with different answers, and
a report that quietly picks one is worse than no report.

Amounts are summed per account over the requested months, so a row is one
account across the window rather than one account-month.

`variancePercent = variance / |base|`. The absolute base keeps the percentage's
sign aligned with the variance even for cost accounts, so "worse" always reads
negative. A percentage against a zero base is **null**, not infinite: an amount
against nothing budgeted is a new line, not a large overspend.

### Materiality

`materialityAmount` and `materialityPercent` are applied together — a variance
must clear both to be called favourable or unfavourable. Anything else is
**neutral**. Calling a rounding difference "favourable" trains people to ignore
the column.

An exactly zero variance is neutral regardless of thresholds.

### Accounts on one side only

Reported in `unmatchedAccounts`. An account nobody budgeted is more often a
mapping mistake in the import than a genuine new line, and it would otherwise
appear as a 100% favourable variance with nothing to compare against.

### Forecast as a comparison side

`forecastToBudgetLines` maps a model's monthly cash flow onto the same account
codes, so a forecast can be compared against a budget without a second data
entry pass. Lines with no account mapping are left out rather than guessed at.

### Import

`docs/import-specification.md` covers the trial-balance reader: wide (a column
per month) and long (a row per account per month) layouts, month parsing, and
the `expenseSign` conversion that brings a ledger's positive costs into the
convention above.

---

## Verification

`packages/calculation-engine/src/regression.test.ts` holds fifteen independently
designed fictional fixtures. Expected values are derived by hand from the
fixture assumptions, or recomputed in the test by a different method than the
engine uses — a closed-form geometric annuity rather than a per-period loop, for
example. **No expected value was produced by running the engine and copying its
output.** Doing so would make the tests agree with the engine by construction
and prove nothing.

Independently verified worked examples include: a triple-net lease escalating 3%
compounding over five years; a base-year structure holding NOI exactly flat
against a 10%-growing expense; an expense stop at a half-building pro-rata
share; a natural breakpoint moving with base rent; a floating rate binding
against its floor in years three and four; a 30-year amortisation schedule
checked against the closed-form remaining-balance formula; an LP/GP waterfall
reconciling contributions, distributions and promote; and the three option
fixtures, whose figures are one line of arithmetic each — 10,000 sqft at
$24.00/sqft/yr is $240,000 a year and exactly $20,000 a month, so a 25%
termination half way through 2028 is `0.25 x 120,000 + 0.75 x 240,000 =
210,000`.

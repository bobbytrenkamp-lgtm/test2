# Calculation specification

Engine version **1.0.0** — `packages/calculation-engine`.

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
20. [Versioning](#20-versioning)

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

### Transparency

Every settled year emits a `RecoveryDetailRow` carrying included categories,
tenant area, denominator, pro-rata share, pool before and after gross-up, base
year amount, stop, amount before caps, cap adjustment, admin fee and final
recovery. The Validation tab renders these directly.

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
(LTC). Breaches are reported; they do not alter the cash flow, because modelling
a cash trap requires terms the facility record does not yet carry.

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

## 20. Versioning

`ENGINE_VERSION` is semantic:

- **Patch** — a fix that leaves every existing model's numbers unchanged.
- **Minor** — additive behaviour reachable only through new inputs.
- **Major** — any change that would alter an existing model's output.

Every stored result and every model version records the engine version that
produced it. `POST /models/:id/versions/:versionId/recalculate` runs a frozen
input under the current engine **without writing the result back**, which is how
an engine upgrade is assessed against approved work before it is adopted.

---

## Verification

`packages/calculation-engine/src/regression.test.ts` holds twelve independently
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
checked against the closed-form remaining-balance formula; and an LP/GP
waterfall reconciling contributions, distributions and promote.

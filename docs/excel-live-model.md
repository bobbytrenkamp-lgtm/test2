# Excel Live Model

A formula-driven workbook export: assumptions as editable cells, and
calculations as Excel formulas that reference them — so changing an exit cap
rate in Excel moves the sale price, the sale proceeds, the levered cash flow and
the levered IRR, without asking the platform to recalculate anything.

That is different from the existing workbook export
(`GET /models/:id/export/workbook`), which writes the engine's numbers as
values. Both are wanted. This document is about the formula-driven one.

## Status, stated plainly

**All five phases are built, reconciled and exposed.**
`GET /api/v1/models/:id/export/live-model`, and an **Excel — Live Model** button
beside the existing values-only export.

Measured formula coverage:

| Fixture | Coverage | Notes |
| --- | --- | --- |
| `refinanceScenario` (with debt) | **84.0%** | Debt, Expenses, Returns, Summary all 100% |
| `sponsorFeeBases` (waterfall) | **78.4%** | Debt 100%; partner flows imported |
| `lpGpWaterfall` | **69.7%** | Waterfall sheet 11.7% — the flow rows |
| `groceryAnchoredRetail` | **64.3%** | Per-lease rent and billing dominate the gap |
| `multiTenantOffice` (no debt) | **61.3%** | Same, with more leases |

Coverage has *fallen* three times as the workbook got more complete: 72.5% on
the office fixture when the Rent Roll landed, again when Recoveries did, and
72.6% → 69.7% on `lpGpWaterfall` when the partner cash-flow rows arrived. Each
time the new cells were honestly-labelled imports. That is the metric working —
it is a measure of how much is genuinely live, not a score to maximise.

The response carries `x-formula-coverage`, `x-formula-cells` and
`x-calculated-cells`, so the claim is checkable from outside.

| Phase | Scope | Status |
| --- | --- | --- |
| 1 | Workbook abstraction, cell registry, references, styles, named ranges, renderer, coverage metric | **Built, 18 tests** |
| 2 | Assumptions, Revenue, Expenses, Cash Flow, Returns | **Built, 29 tests, reconciled to the engine** |
| 3 | Rent Roll and lease-level detail | **Built** — Revenue sums it |
| 4 | Debt schedule | **Built, reconciles exactly on all five debt fixtures** |
| 5 | Summary, checks, export route, UI | **Built** |
| 5b | Recoveries as their own schedule, the partnership waterfall | **Built** — recovery settlement and partner IRRs are formulas |

### Formula coverage by feature

A row says **yes** only where a test evaluates the emitted formula and
reconciles it to the engine.

| Feature | Excel formula support |
| --- | --- |
| Growth curves (annual rate → monthly compounding factor) | **Yes** |
| Operating expenses, all six methods | **Yes** |
| Occupancy-sensitive expense adjustment | **Yes** |
| Contractual / scheduled base rent | **Yes** |
| Gross potential revenue | **Yes** |
| General vacancy, credit loss | **Yes** |
| Effective gross revenue, NOI, unlevered cash flow | **Yes** |
| Exit value, selling costs, net sale proceeds | **Yes** |
| Going-in cap rate | **Yes** |
| XIRR, XNPV, equity multiple | **Yes** (native Excel; not covered by the evaluator) |
| Levered cash flow | **Yes** |
| Debt: balance roll-forward, interest, level payment, principal, fees, payoff | **Yes** — reconciles to the cent |
| Contractual base rent as a sum of the Rent Roll | **Yes** |
| Potential base rent | **Yes** |
| Summary links and model checks | **Yes** |
| Per-lease base rent, free rent, percentage rent, recoveries | **No** — engine values, counted as gaps |
| TI, LC, capital expenditure | **No** — engine values |
| Floating-rate index resolution | **Yes** — `MIN(MAX(index + spread, floor), cap)` |
| Covenant tests, cash traps, refinancing | **No** — engine values reach Cash Flow |
| Recovery settlement: share, entitlement, admin fee, before caps, final, true-up | **Yes** |
| Monthly recovery total feeding Revenue | **Yes** |
| Rent growth sensitivity → revenue → NOI → value | **Yes** (a lever; see below) |
| Recovery method `fixed_amount` | **No** — no fixture exercises it |
| Waterfall: distributions, profit, equity multiple | **Yes** |
| Partner IRR | **Yes** — native `XIRR` over the partner's own dated flow row |
| Waterfall tier amounts, per-period partner flows | **No** — imported; see below |

## Architecture

The risk this feature carries is ending up with two calculation engines that
drift apart — the platform's, and a second one written in Excel formulas. The
defence is that the exporter never restates a business rule. It maps the
engine's relationships onto cells, and where a rule cannot be expressed as a
formula it says so through the coverage metric rather than quietly pasting a
number.

```
ModelInput + ModelResult  →  WorkbookModel  →  ExcelJS  →  .xlsx
   (engine is authoritative)   (cells, keys, formulas)   (one file talks to the library)
```

### Cells are addressed by meaning

A workbook assembled with `sheet.getCell('F17').value = …` cannot be changed
and cannot be audited: nothing records that F17 *is* net operating income for
period 12, so every formula referring to it hard-codes the coordinate and any
inserted row breaks something silently.

Here a cell is registered under a business key, and formulas ask for it:

```ts
seriesRow(sheet, axis, { label: 'Net operating income', key: 'cashFlow.noi' }, (period) => ({
  kind: 'formula',
  formula: (refs) => `${refs.ref('revenue.egr', period)}-${refs.ref('expenses.total', period)}`,
}));
```

No formula anywhere contains a literal coordinate. Layout can move; formulas do
not care. A key that was never registered throws at build time rather than
producing a workbook that opens with `#REF!`.

### Formulas resolve in a second pass

A formula is supplied as a *function* of a resolver, not as text. That lets the
Summary sheet reference the Returns sheet even though Returns is built
afterwards. Resolving eagerly would force the sheets into dependency order
rather than the order a reader wants them in.

### Cells declare what they are

`input`, `formula`, `staticDerived`, `label`, `header`, `metadata`. This drives
both the styling and the coverage metric, and it is what makes it possible to
fail a test when a calculated cell degrades into a pasted number.

Coverage counts only *derived* cells — `formula` + `staticDerived`. Labels,
tenant names and editable assumptions are excluded, because a formula in any of
those would be wrong rather than better. The denominator is "cells that ought to
be calculated", not "cells".

## What can and cannot be a formula

This was settled by reading the engine, not by assumption.

**Exactly reproducible in Excel.** The growth-curve rule is a closed form: the
first twelve forecast months carry a factor of 1.0 and growth compounds on each
forecast-year boundary (`CurveSet.factors`). Expenses are
`base × (fixedShare + variableShare × occupancy)` where `base` follows the
expense method (`computeExpenseSeries`). Vacancy and credit loss are rates
against gross potential revenue. Debt amortises monthly from a rate, an
interest-only period and an amortisation term. Exit value is forward NOI over a
cap rate. IRR is a function of the cash flows already in the workbook. All of
these become real formulas driven by editable inputs.

**Not reproducible without duplicating the engine.** Lease rollover, downtime,
absorption and market leasing profiles are a per-occurrence simulation, not a
closed form. Reimplementing them in Excel formulas would be exactly the second
engine this design exists to avoid. The plan is to carry lease-level results as
engine-supplied values on the Rent Roll — the way a rent roll you typed in would
be — and make everything downstream of them formulas. Those cells will be
counted as `staticDerived`, so the coverage metric reports them as the gap they
are rather than hiding them.

That distinction is the honest core of this feature, and it is why the coverage
metric exists.

## Formatting convention

The one financial models have used for decades, because an analyst opening the
file already knows how to read it: **blue means you may type here**, black means
calculated on this sheet, green means calculated from another sheet. Amber marks
a derived cell exported as a value rather than a formula.

Colour is chosen from the formula text rather than from a flag a builder has to
remember to set, so it cannot disagree with the formula.

## Recalculation

The workbook sets `fullCalcOnLoad`, so Excel recalculates when it opens. Cached
values are written next to every formula — they are what Excel shows before it
recalculates, and what reconciliation tests read — but the formula is always
authoritative and is never replaced by its cached result.

This is asserted against the XML the writer produces, not against a reopened
workbook: ExcelJS writes `calcPr` correctly but its reader does not populate
`calcProperties` on load, so a round-trip assertion fails on a correct file.

## Dependencies

ExcelJS 4.4.0, already a dependency of `@cre/reporting`, MIT licensed. Nothing
new was added. The exporter runs locally and the workbook has no external data
connections, no add-ins and no macros.

## How reconciliation is checked

Two layers, because the first alone proved insufficient.

**Identity tests** assert that the engine's own series satisfy the
relationships the formulas encode. These caught a real misreading: the engine's
output series negate every deduction (`operatingExpenses.map(v => v.negated())`),
so each subtotal is an addition, not a subtraction. Four formulas were wrong.

**They were still not enough.** Reintroducing a sign error deliberately —
subtracting free rent where the engine adds it — left all 23 identity tests
passing, because they assert about the engine rather than about the emitted
formula text.

So a second layer **evaluates the formulas the exporter emits**
(`evaluate.ts`), following the same references Excel would, and compares the
result to the engine cell by cell and period by period across three fixtures.
Both deliberate breakages now fail loudly, naming the cell and both values:

```
revenue.scheduledBaseRent#9: workbook 203666.67 vs engine 118666.67
expenses.total#0:            workbook -59799.22 vs engine -56361.72
```

`evaluate.ts` is a test instrument, not a second engine: it knows arithmetic,
references and five functions, and encodes no business rule. `XIRR`, `XNPV` and
`SUMIF` are outside its subset and return `NaN`; those cells are skipped rather
than counted as checked. **Opening the workbook in Excel remains a manual step
that has not been performed.**

Tolerances are stated rather than tuned: five cents on a sum of engine lines
(each rounded to cents), and a relative 1e-5 on the exit valuation, where twelve
rounded NOI figures are divided by a cap rate and the rounding is divided too.

## A consequence of where the boundary falls

Because recoveries are engine-supplied, effective gross revenue in the workbook
does not depend on expenses, so the dependency graph is **acyclic** where the
engine's is circular. A management fee on EGR is therefore a plain formula and
Excel needs no iterative calculation. The trade is that editing a recoverable
expense in Excel will not move recoveries. That is a real limitation, not an
oversight.

## Tests

- `excel-model.test.ts` — 18 framework tests.
- `live-model.test.ts` — 29 tests: build, structure, formula presence,
  cross-sheet linkage, assumption dependency, identities, and formula-level
  reconciliation across three fixtures.

## Rent growth: a lever, not a reproduction

Contractual rent, escalations, rollover and market leasing come from a
per-occurrence simulation with no closed form. Rebuilding that in Excel would
be the second engine this design exists to prevent — but a workbook where
changing rent growth does nothing is not a model.

So the Rent Roll carries an incremental growth factor driven by
`RentGrowthSensitivity`, compounding each forecast year on top of the engine's
own rent:

```
total contractual rent = rent as modelled x (1 + RentGrowthSensitivity)^(forecast year - 1)
```

**It defaults to zero**, so every factor is 1.00 and the export reconciles to
the platform exactly; a test asserts both. Anything non-zero is the reader's
own sensitivity and the row label says so. This is deliberately not presented
as the platform's market-rent growth assumption, which drives rollover inside
the engine and is not reproduced here.

## The debt schedule

The sheet the feature is judged on, and it reconciles **exactly** — zero
difference on balance, interest, principal and payoff across all five debt
fixtures, including one that capitalises interest, one that floats, and one
with a covenant cash trap.

The trick is separating structure from amount. Which months amortise, and how
many amortisation months remain in each, depends only on the funding date, the
interest-only window and the term — never on the rate. So the structure is
resolved at export and the amounts are formulas. Raising the rate raises
interest and lowers principal within a level payment, exactly as the engine
does, without reshaping the schedule.

The level payment uses the closed form rather than Excel's `PMT`, so the
reconciliation harness can evaluate it:

```
payment = balance x r / (1 - (1 + r)^-n)      r > 0
payment = balance / n                          r = 0
```

## The partnership waterfall

Each partner gets a dated cash-flow row — their share of the equity funded at
closing, then one column per forecast month — and their IRR is an `XIRR` over
that row, exactly as the property's levered return is an `XIRR` over the Cash
Flow sheet. An IRR that does not move when the cash flows move is a caption, not
a result.

The flows themselves are imported: contributions and distributions never share a
month (a period needing cash is funded before any tier is paid), but the split
of a distribution across tiers is a sequential draw-down and not a closed form.
So the sheet is honest in two directions at once — the IRR is genuinely
calculated by Excel, and the row it reads is genuinely imported.

What makes that trustworthy is the tie-out. The row total is a `SUM`, and it
must equal the partner's profit, which is a formula over the tier amounts less
their contribution. Those are two independent routes to the same number, so a
dropped period or a flipped sign shows up as `CHECK` on the Summary sheet rather
than as a well-formed and quietly wrong IRR. A test drops a flow on purpose and
confirms the check trips by exactly the amount dropped.

The engine gained three fields to make this possible — `initialFlow`, `flows`
and `xirr` on `WaterfallDistribution` (engine 3.3.0). That was not a change made
for the exporter's convenience: a partnership reported only as totals cannot be
audited or discounted by anything, and the partner IRR had been solved on a
different day-count convention from the property's `leveredXirr` sitting beside
it. Both were reporting limitations in their own right.

`XIRR` is outside the reconciliation evaluator's subset, so the IRR cells are
skipped rather than checked. What is checked is the chain beneath them: the
formula references the right range, and editing a flow moves the total.

## Floating rates

`MIN(MAX(index + spread, floor), cap)` is a closed form, so the applied rate is
a formula rather than an import. The index rate is the same editable cell the
growth curves already use on the Assumptions sheet, and the spread, floor and
cap sit beside the facility's other terms. Moving the index curve therefore
moves interest, debt service and the levered return — the lever a floating deal
is actually underwritten on, and one that did nothing while the rate was an
imported per-period number.

Three details of the engine's resolution are matched rather than assumed:

- The forecast year is `floor(period / 12) + 1` — twelve-month blocks from the
  forecast start, not calendar years.
- Year 1 *is* included. Growth curves skip it, because a factor of 1.0 in the
  first year is what "no growth yet" means. An index rate carries no such
  convention and applies from the first month.
- A facility naming no curve resolves the index to nil, so the rate is the
  spread alone, floored and capped as usual.

A floor or cap the facility does not have is written as a dash, not left blank:
a blank cell inside `MAX` is zero, which would floor a negative index at nil.

`floatingRateDebt` is built so the floor is live for part of the term and dead
for the rest — the index path falls from 5% to 3% against a 2.5% spread and a
6.5% floor — so both branches are exercised. No fixture sets a cap, so the `MIN`
branch is tested against a capped facility run back through the engine, and
reconciled to that rather than to a figure worked out by hand.

## Remaining gaps, in priority order

1. **Per-period tier amounts and partner flows.** The split across a preferred
   return, return of capital, a catch-up and a residual promote is a sequential
   draw-down against running accrual balances, period by period — not a closed
   form. Both the tier totals and each partner's monthly flow are therefore
   imported and counted against coverage.

   Making them *look* live would be easy and is deliberately refused: scaling
   each partner's flow by the period's equity cash flow while holding their
   share fixed produces a row that moves in the right direction by the wrong
   amount, because the tiers are non-linear. A plainly labelled imported cell is
   worth more than a formula that is quietly approximate.

2. **TI, LC and capital** as formulas driven by leasing assumptions.
3. **Covenant tests, cash traps and refinancing** in the workbook.
4. **Sensitivity tables and scenarios.**

## The four movements, tested

| Change | Effect | Test |
| --- | --- | --- |
| Rent growth sensitivity | revenue, NOI and sale price all rise | ✅ |
| Expense growth rate | NOI and sale price fall | ✅ |
| Interest rate | levered cash flow falls, **NOI unchanged** | ✅ |
| Exit cap rate | sale price falls, **NOI unchanged** | ✅ |

The two "unchanged" assertions matter as much as the others: debt is not an
operating cost and the exit yield is not an operating input, so a workbook
where either moved NOI would be wrong.

## Not verified

**The workbook has never been opened in Microsoft Excel.** Everything above is
proved by evaluating the emitted formulas in a harness that implements a subset
of Excel's semantics. That is a strong check — it catches sign errors, broken
links and wrong operators — but it is not Excel, and `XIRR`, `XNPV` and `SUMIF`
are outside the subset and are skipped rather than counted as checked.

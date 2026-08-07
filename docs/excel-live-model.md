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
| `groceryAnchoredRetail` | **64.3%** | Per-lease rent and billing dominate the gap |
| `multiTenantOffice` (no debt) | **61.3%** | Same, with more leases |

Coverage on the office fixture *fell* from 72.5% when the Rent Roll was added,
because lease-level rent is engine-supplied and now counted. That is the metric
working: it got less flattering as the workbook got more complete.

The response carries `x-formula-coverage`, `x-formula-cells` and
`x-calculated-cells`, so the claim is checkable from outside.

| Phase | Scope | Status |
| --- | --- | --- |
| 1 | Workbook abstraction, cell registry, references, styles, named ranges, renderer, coverage metric | **Built, 18 tests** |
| 2 | Assumptions, Revenue, Expenses, Cash Flow, Returns | **Built, 29 tests, reconciled to the engine** |
| 3 | Rent Roll and lease-level detail | **Built** — Revenue sums it |
| 4 | Debt schedule | **Built, reconciles exactly on all five debt fixtures** |
| 5 | Summary, checks, export route, UI | **Built** |
| 5b | Recoveries as their own schedule, waterfalls | Not started — see below |

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
| Floating-rate index resolution | **No** — the applied rate is an editable per-period input |
| Covenant tests, cash traps, refinancing | **No** — engine values reach Cash Flow |
| Recovery settlement: share, entitlement, admin fee, before caps, final, true-up | **Yes** |
| Monthly recovery total feeding Revenue | **Yes** |
| Rent growth sensitivity → revenue → NOI → value | **Yes** (a lever; see below) |
| Recovery method `fixed_amount` | **No** — no fixture exercises it |
| Waterfall | Not started |

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

## Remaining gaps, in priority order

1. **Waterfall sheet.** LP/GP tiers, preferred return, catch-up, promote,
   per-partner IRR and equity multiple. The engine computes all of it
   (`ModelResult.waterfall`); none of it is exported.
3. **Floating-rate index resolution.** The applied rate is editable per period
   but is not rebuilt from the index curve, spread, floor and cap.
4. **TI, LC and capital** as formulas driven by leasing assumptions.
5. **Covenant tests, cash traps and refinancing** in the workbook.
6. **Sensitivity tables and scenarios.**

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

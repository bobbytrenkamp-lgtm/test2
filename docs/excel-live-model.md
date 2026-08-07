# Excel Live Model

A formula-driven workbook export: assumptions as editable cells, and
calculations as Excel formulas that reference them — so changing an exit cap
rate in Excel moves the sale price, the sale proceeds, the levered cash flow and
the levered IRR, without asking the platform to recalculate anything.

That is different from the existing workbook export
(`GET /models/:id/export/workbook`), which writes the engine's numbers as
values. Both are wanted. This document is about the formula-driven one.

## Status, stated plainly

**Phase 1 — the framework — is built and tested. Nothing is exported yet.**

There is no export route, no UI entry point and no complete workbook. The
coverage table below is a plan, not a claim: every row of it says *planned*,
because no sheet is finished. When a row says *yes*, it will mean there is a
test asserting the cell holds a formula.

| Phase | Scope | Status |
| --- | --- | --- |
| 1 | Workbook abstraction, cell registry, references, styles, named ranges, renderer, coverage metric | **Built, 18 tests** |
| 2 | Assumptions, Revenue, Expenses, Cash Flow, Returns | Assumptions sheet drafted; not wired up |
| 3 | Rent Roll and lease-level detail | Not started |
| 4 | Debt schedule | Not started |
| 5 | Recoveries, floating-rate debt, refinance, capital schedules, waterfalls | Not started |

### Formula coverage by feature

| Feature | Excel formula support |
| --- | --- |
| Everything below | Planned — no sheet is complete |
| Growth curves (annual rate → monthly compounding factor) | Designed and drafted; verified against `CurveSet.factors` |
| Operating expenses | Designed; reproducible exactly (see below) |
| General vacancy, credit loss | Designed; reproducible exactly |
| Debt amortisation | Designed; reproducible exactly |
| Exit value, selling costs, debt payoff | Designed; reproducible exactly |
| IRR / XIRR / equity multiple | Designed; native Excel over workbook cash flows |
| Lease-level rollover, downtime, absorption | **Not reproducible as formulas** — see below |
| Recoveries | Undecided; likely engine-supplied in the first release |
| Waterfall | Deferred to a later phase |

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

## Tests

`packages/reporting/src/excel-model/excel-model.test.ts` — 18 tests covering
column arithmetic at the base-26 boundaries, sheet and defined-name quoting,
registry resolution and its refusals, forward references, the coverage metric,
and a real .xlsx round trip proving formulas, cached results and defined names
survive.

## Next

Phase 2, in order: wire the Assumptions sheet into a build orchestrator, then
Revenue, Expenses, Cash Flow and Returns, with reconciliation tests against the
engine for NOI, debt balance, sale value and both IRRs before anything is
exposed through the API.

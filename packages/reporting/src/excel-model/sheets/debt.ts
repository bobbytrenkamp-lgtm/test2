import type { DebtFacility, ModelInput, ModelResult } from '@cre/domain-models';
import type { WorkbookModel } from '../model.js';
import { scheduleColumnWidths, seriesRow } from '../layout.js';
import type { TimeAxis } from '../layout.js';

/**
 * The debt schedule, amortised in Excel rather than imported.
 *
 * This is the sheet the whole feature is judged on: changing the interest rate
 * must move interest, debt service, levered cash flow and the levered return.
 * So the balance rolls forward period by period in formulas —
 *
 *   ending = beginning + draw + capitalised interest - principal - payoff
 *
 * — and interest is the rate applied to the balance the engine applies it to.
 *
 * ## The structure is precomputed; the amounts are not
 *
 * Which months amortise, and how many amortisation months remain in each, is a
 * function of the funding date, the interest-only period and the term. None of
 * it depends on the rate, so it is worked out here and emitted as constants.
 * Every *amount* — interest, level payment, principal, fees — is a formula of
 * the rate and the balance.
 *
 * That split is what makes the schedule both live and stable: raising the rate
 * raises interest and lowers principal within a level payment, exactly as the
 * engine does, without silently reshaping the amortisation.
 *
 * ## Level payment
 *
 * `levelPayment` in the engine is the standard annuity, and the workbook uses
 * the closed form rather than Excel's `PMT` so the reconciliation harness can
 * evaluate it:
 *
 *   payment = balance x r / (1 - (1 + r)^-n)      (r > 0)
 *   payment = balance / n                          (r = 0)
 *
 * ## Floating rates
 *
 * Rebuilt, not imported. `MIN(MAX(index + spread, floor), cap)` is a closed
 * form, so the applied rate is a formula over the index curve's own editable
 * rate cell on the Assumptions sheet and the facility's spread, floor and cap
 * beside it. Moving the index curve moves interest, debt service and the
 * levered return — which is the lever a floating deal is underwritten on, and
 * it did nothing while the rate was an imported per-period input. Fixed-rate
 * facilities reference a single named rate. See `floatingRate` below.
 *
 * ## What is not reproduced
 *
 * Covenant testing, cash traps and refinancing are not modelled here; the
 * engine's own figures for those still reach Cash Flow. See
 * `docs/excel-live-model.md`.
 */
export function buildDebt(
  workbook: WorkbookModel,
  input: ModelInput,
  result: ModelResult,
  axis: TimeAxis,
): void {
  const sheet = workbook.sheet('Debt', {
    freezeRows: 4,
    freezeColumns: 2,
    columnWidths: scheduleColumnWidths(axis),
  });

  sheet.at(sheet.claimRow(), 1, { kind: 'header', value: 'Debt schedule', format: 'text' });

  const facilities = input.debt;

  for (const facility of facilities) {
    const schedule = result.debtSchedules.find((entry) => entry.facilityId === facility.id);
    buildFacility(sheet, workbook, input, facility, schedule, axis);
  }

  /* ------------------------------------------------------------------ */
  /* Totals, which are what Cash Flow reads                              */
  /* ------------------------------------------------------------------ */
  sheet.skipRows(1);
  sheet.section('All facilities');

  const total = (
    label: string,
    key: string,
    per: string,
    line: keyof ModelResult['monthly'],
    negate: boolean,
  ): void => {
    seriesRow(sheet, axis, { label, key, bold: true }, (period) => ({
      kind: 'formula',
      formula: (refs) =>
        facilities.length === 0
          ? '0'
          : (negate ? '-(' : '') +
            facilities.map((facility) => refs.ref(`${per}.${facility.id}`, period)).join('+') +
            (negate ? ')' : ''),
      cachedValue: Number(result.monthly[line][period] ?? '0'),
    }));
  };

  total('Debt proceeds', 'debt.proceeds', 'debt.draw', 'debtProceeds', false);
  // Interest, principal, fees and payoff are all reported negative by the
  // engine, so each total negates the sum of its positive per-facility rows.
  total('Interest expense', 'debt.interest', 'debt.cashInterest', 'interestExpense', true);
  total(
    'Principal amortisation',
    'debt.principal',
    'debt.principal',
    'principalAmortization',
    true,
  );
  total('Financing fees', 'debt.fees', 'debt.fees', 'financingFees', true);
  total('Debt payoff', 'debt.payoffSigned', 'debt.payoff', 'debtPayoff', true);

  /*
   * Capitalised interest has no cash-flow line of its own — it never leaves the
   * property, it joins the loan balance. It is totalled here because the
   * balance roll-forward does not reconcile without it: a development facility
   * grows by capitalised interest with no matching draw, which is exactly what
   * the Summary check missed on its first attempt.
   */
  seriesRow(
    sheet,
    axis,
    { label: 'Capitalised interest', key: 'debt.capitalisedTotal', bold: true },
    (period) => ({
      kind: 'formula',
      formula: (refs) =>
        facilities.length === 0
          ? '0'
          : facilities
              .map((facility) => refs.ref(`debt.capitalised.${facility.id}`, period))
              .join('+'),
    }),
  );

  seriesRow(
    sheet,
    axis,
    { label: 'Ending balance', key: 'debt.endingBalance', bold: true, total: false },
    (period) => ({
      kind: 'formula',
      formula: (refs) =>
        facilities.length === 0
          ? '0'
          : facilities.map((facility) => refs.ref(`debt.ending.${facility.id}`, period)).join('+'),
      cachedValue: facilities.reduce((sum, facility) => {
        const schedule = result.debtSchedules.find((entry) => entry.facilityId === facility.id);
        return sum + Number(schedule?.rows[period]?.endingBalance ?? '0');
      }, 0),
    }),
  );
}

function buildFacility(
  sheet: ReturnType<WorkbookModel['sheet']>,
  workbook: WorkbookModel,
  input: ModelInput,
  facility: DebtFacility,
  schedule: { rows: Array<{ appliedRate: string; endingBalance: string }> } | undefined,
  axis: TimeAxis,
): void {
  sheet.skipRows(1);
  sheet.section(facility.name);

  const rawFundingIndex = axis.periods.findIndex(
    (period) => period.endDate >= facility.fundingDate,
  );
  // A facility whose funding date falls after every modelled period's end
  // date never becomes active within this axis at all — the engine's own
  // fundingIndex (calculation-engine/src/debt.ts, an unclamped month offset
  // from the forecast start) works out the same way: monthsSinceFunding
  // stays negative for every period the engine loops over, so `active` is
  // false throughout and the schedule is all zeros. Treating a not-found
  // search (`-1`) as period 0 — as this used to — did the opposite: it
  // exported formulas that mark the facility active, draw its funding, and
  // charge interest from period 0 onward, disagreeing with the engine's
  // correctly-all-zero cachedValue as soon as Excel recalculates. `funded`
  // set beyond the last axis index keeps every use below (the draw at
  // `period === funded`, `active`, `amortises`) false for every real period,
  // the same way `maturityIndex`'s own clamping below already handles the
  // opposite case (a facility that outlives the axis).
  const funded = rawFundingIndex < 0 ? axis.count : rawFundingIndex;
  // The engine's own `maturityIndex` is never clamped to the modelled axis —
  // a facility whose term simply outlives the forecast horizon stays active
  // (and its balance stays outstanding) through the last modelled period,
  // with no payoff or exit fee charged at all, because the engine's loop
  // never reaches an index that far out. Clamping here is fine for `active`/
  // `amortises` below (`period` itself never exceeds `axis.count - 1`
  // either way), but using the clamped value to decide *where the payoff
  // formula fires* silently forced a payoff, and an exit fee, into the
  // sheet's last period whenever the loan's real maturity fell beyond the
  // axis — a nonzero engine balance zeroed out in Excel with a fee the
  // engine never charges.
  const rawMaturityIndex = funded + facility.termMonths - 1;
  const maturityIndex = Math.min(rawMaturityIndex, axis.count - 1);
  const maturityWithinAxis = rawMaturityIndex <= axis.count - 1;

  /*
   * Amortisation months remaining, per period.
   *
   * The engine decrements a counter each time it amortises, and amortising
   * periods are consecutive from the end of the interest-only window, so the
   * remaining count is a closed form: it does not depend on the rate and can be
   * settled here.
   */
  const amortStart = funded + facility.interestOnlyMonths;
  const remainingAt = (period: number): number => {
    if (facility.amortizationMonths <= 0) return 0;
    if (period < amortStart) return facility.amortizationMonths;
    return Math.max(facility.amortizationMonths - (period - amortStart), 0);
  };
  const amortises = (period: number): boolean =>
    period >= amortStart && period <= maturityIndex && remainingAt(period) > 0;
  const active = (period: number): boolean => period >= funded && period <= maturityIndex;

  /* Draws: a dated schedule, so an input. */
  const drawAt = (period: number): number => {
    let amount = 0;
    if (period === funded) amount += Number(facility.initialFunding);
    for (const draw of facility.draws) {
      const index = axis.periods.findIndex((entry) => entry.endDate >= draw.date);
      if (index === period) amount += Number(draw.amount);
    }
    return amount;
  };

  seriesRow(
    sheet,
    axis,
    { label: 'Draw', key: `debt.draw.${facility.id}`, indent: 1 },
    (period) => ({ kind: 'input', value: drawAt(period) }),
  );

  /* The rate. Fixed facilities get one editable number; floating gets a row. */
  const isFloating = facility.rateType === 'floating';
  seriesRow(
    sheet,
    axis,
    {
      label: 'Applied rate',
      key: `debt.rate.${facility.id}`,
      format: 'percent2',
      indent: 1,
      total: false,
      note: isFloating
        ? 'Floating: MIN(MAX(index + spread, floor), cap), over the index curve and the ' +
          'spread, floor and cap on the Assumptions sheet. Zero outside the facility term, ' +
          'where the balance is zero and no rate applies.'
        : undefined,
    },
    (period) => ({
      kind: 'formula',
      formula: (refs) => {
        if (!active(period)) return '0';
        if (!isFloating) return refs.absRef(`debt.${facility.id}.fixedRate`);
        return floatingRate(refs, facility, period);
      },
      format: 'percent2',
      // The engine's own applied rate, so the global cached-value check
      // compares this formula against it on every period of every fixture.
      cachedValue: Number(schedule?.rows[period]?.appliedRate ?? '0'),
    }),
  );

  seriesRow(
    sheet,
    axis,
    { label: 'Beginning balance', key: `debt.beginning.${facility.id}`, indent: 1, total: false },
    (period) => ({
      kind: 'formula',
      formula: (refs) => (period === 0 ? '0' : refs.ref(`debt.ending.${facility.id}`, period - 1)),
    }),
  );

  // The engine accrues on the balance *after* the draw, so a facility funded
  // this month carries a full month of interest.
  seriesRow(
    sheet,
    axis,
    { label: 'Balance after draw', key: `debt.drawn.${facility.id}`, indent: 2, total: false },
    (period) => ({
      kind: 'formula',
      formula: (refs) =>
        `${refs.ref(`debt.beginning.${facility.id}`, period)}+` +
        `${refs.ref(`debt.draw.${facility.id}`, period)}`,
    }),
  );

  seriesRow(
    sheet,
    axis,
    { label: 'Interest accrued', key: `debt.accrued.${facility.id}`, indent: 2 },
    (period) => ({
      kind: 'formula',
      formula: (refs) =>
        active(period)
          ? `${refs.ref(`debt.drawn.${facility.id}`, period)}*` +
            `${refs.ref(`debt.rate.${facility.id}`, period)}/12`
          : '0',
    }),
  );

  const capitalises = facility.capitalizeInterest;

  seriesRow(
    sheet,
    axis,
    { label: 'Cash interest', key: `debt.cashInterest.${facility.id}`, indent: 1 },
    (period) => ({
      kind: 'formula',
      formula: (refs) => (capitalises ? '0' : refs.ref(`debt.accrued.${facility.id}`, period)),
    }),
  );

  seriesRow(
    sheet,
    axis,
    { label: 'Capitalised interest', key: `debt.capitalised.${facility.id}`, indent: 1 },
    (period) => ({
      kind: 'formula',
      formula: (refs) => (capitalises ? refs.ref(`debt.accrued.${facility.id}`, period) : '0'),
    }),
  );

  /** Balance interest amortises against: after the draw, plus capitalised interest. */
  seriesRow(
    sheet,
    axis,
    {
      label: 'Balance before principal',
      key: `debt.preAmort.${facility.id}`,
      indent: 2,
      total: false,
    },
    (period) => ({
      kind: 'formula',
      formula: (refs) =>
        `${refs.ref(`debt.drawn.${facility.id}`, period)}+` +
        `${refs.ref(`debt.capitalised.${facility.id}`, period)}`,
    }),
  );

  seriesRow(
    sheet,
    axis,
    { label: 'Level payment', key: `debt.payment.${facility.id}`, indent: 2, total: false },
    (period) => {
      const remaining = remainingAt(period);
      if (!amortises(period) || remaining <= 0) {
        return { kind: 'formula', formula: () => '0' };
      }
      return {
        kind: 'formula',
        // The annuity, guarded for a zero rate where the closed form divides
        // by zero and the payment is simply the balance over the term.
        formula: (refs) => {
          const balance = refs.ref(`debt.preAmort.${facility.id}`, period);
          const rate = `${refs.ref(`debt.rate.${facility.id}`, period)}/12`;
          return (
            `IF(${rate}=0,${balance}/${remaining},` +
            `${balance}*(${rate})/(1-(1+${rate})^-${remaining}))`
          );
        },
      };
    },
  );

  seriesRow(
    sheet,
    axis,
    { label: 'Principal', key: `debt.principal.${facility.id}`, indent: 1 },
    (period) => {
      if (!amortises(period)) return { kind: 'formula', formula: () => '0' };
      return {
        kind: 'formula',
        // Principal is the payment less the interest accrued, floored at zero
        // and capped at the balance — exactly the engine's min/max pair.
        formula: (refs) =>
          `MAX(MIN(${refs.ref(`debt.payment.${facility.id}`, period)}-` +
          `${refs.ref(`debt.accrued.${facility.id}`, period)},` +
          `${refs.ref(`debt.preAmort.${facility.id}`, period)}),0)`,
      };
    },
  );

  /* Payoff at maturity or at sale. */
  // Resolved exactly as `returns.ts` resolves it, not hardcoded to the last
  // modelled period: the axis is deliberately extended past the sale date
  // whenever `terminalNoiBasis: 'forward_12'` needs NOI after it (an
  // ordinary configuration, not a rare one — see the engine's own 5.0.0
  // changelog), so "last period" and "sale period" are different periods on
  // exactly the models this sheet most needs to get right.
  const last = axis.count - 1;
  const saleMonth = input.valuation.saleMonth ?? axis.count;
  const saleIndex = Math.min(Math.max(saleMonth - 1, 0), last);
  const payoffPeriod = facility.repayOnSale
    ? Math.min(maturityIndex, saleIndex)
    : maturityWithinAxis
      ? maturityIndex
      : -1;

  seriesRow(
    sheet,
    axis,
    { label: 'Payoff', key: `debt.payoff.${facility.id}`, indent: 1 },
    (period) => ({
      kind: 'formula',
      formula: (refs) =>
        period === payoffPeriod
          ? `MAX(${refs.ref(`debt.preAmort.${facility.id}`, period)}-` +
            `${refs.ref(`debt.principal.${facility.id}`, period)},0)`
          : '0',
    }),
  );

  seriesRow(
    sheet,
    axis,
    { label: 'Fees', key: `debt.fees.${facility.id}`, indent: 1 },
    (period) => {
      const parts: Array<(refs: import('../model.js').RefResolver) => string> = [];
      if (period === funded && Number(facility.originationFeePercent) > 0) {
        parts.push(
          (refs) =>
            `${refs.absRef(`debt.${facility.id}.commitment`)}*` +
            `${refs.absRef(`debt.${facility.id}.originationFee`)}`,
        );
      }
      if (period === payoffPeriod && Number(facility.exitFeePercent) > 0) {
        parts.push(
          (refs) =>
            `${refs.ref(`debt.payoff.${facility.id}`, period)}*` +
            `${refs.absRef(`debt.${facility.id}.exitFee`)}`,
        );
      }
      if (parts.length === 0) return { kind: 'formula', formula: () => '0' };
      return { kind: 'formula', formula: (refs) => parts.map((part) => part(refs)).join('+') };
    },
  );

  seriesRow(
    sheet,
    axis,
    { label: 'Ending balance', key: `debt.ending.${facility.id}`, bold: true, total: false },
    (period) => ({
      kind: 'formula',
      formula: (refs) =>
        `${refs.ref(`debt.preAmort.${facility.id}`, period)}-` +
        `${refs.ref(`debt.principal.${facility.id}`, period)}-` +
        `${refs.ref(`debt.payoff.${facility.id}`, period)}`,
      cachedValue: Number(schedule?.rows[period]?.endingBalance ?? '0'),
    }),
  );
}

/* -------------------------------------------------------------------------- */

/**
 * A floating facility's applied rate, resolved the way the engine resolves it:
 *
 *   MIN(MAX(index[forecast year] + spread, floor), cap)
 *
 * A closed form, so it is a formula rather than an import. The index rate is
 * the same editable cell the growth curves use on the Assumptions sheet, which
 * means moving the curve moves interest, debt service and the levered return —
 * the lever a floating-rate deal is actually underwritten on.
 *
 * Three things the engine does that a naive reading misses, all matched here:
 *
 * - The forecast year is `floor(period / 12) + 1`: blocks of twelve months from
 *   the forecast start, not calendar years.
 * - Year 1 *is* included. Growth curves skip it, because a factor of 1.0 in the
 *   first year is what "no growth yet" means; an index rate carries no such
 *   convention and applies from the first month.
 * - A facility naming no curve, or one absent from the model, resolves the
 *   index to nil rather than failing, so the rate is the spread alone — floored
 *   and capped as usual.
 */
function floatingRate(
  refs: import('../model.js').RefResolver,
  facility: DebtFacility,
  period: number,
): string {
  const year = Math.floor(period / 12) + 1;
  const curveKey = `curve.${facility.indexCurveId ?? ''}.rate`;
  const index =
    facility.indexCurveId && refs.has(curveKey, year) ? refs.absRef(curveKey, year) : '0';

  let rate = `${index}+${refs.absRef(`debt.${facility.id}.spread`)}`;
  if (facility.rateFloor !== null && facility.rateFloor !== undefined) {
    rate = `MAX(${rate},${refs.absRef(`debt.${facility.id}.rateFloor`)})`;
  }
  if (facility.rateCap !== null && facility.rateCap !== undefined) {
    rate = `MIN(${rate},${refs.absRef(`debt.${facility.id}.rateCap`)})`;
  }
  return rate;
}

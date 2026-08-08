import type { ModelInput, ModelResult } from '@cre/domain-models';
import type { CellSpec, WorkbookModel } from '../model.js';
import { LABEL_COL, TOTAL_COL } from '../layout.js';
import type { TimeAxis } from '../layout.js';

/**
 * The investment summary, and a set of checks that must all read OK.
 *
 * Every calculated figure here **links** to the sheet that worked it out. None
 * is computed a second time: a summary that recalculates is a summary that can
 * disagree with the model it summarises, and the disagreement is always found
 * by the reader rather than the author.
 *
 * ## The checks
 *
 * Professional models carry a check block because a model that looks right is
 * not evidence. Each row states an identity that must hold and shows `OK` or
 * `CHECK`, so a broken workbook announces itself instead of being believed.
 *
 * They are written as differences against a tolerance rather than as exact
 * equality: every engine line is rounded to cents, so a sum of several can
 * legitimately differ in the last place.
 */
export function buildSummary(
  workbook: WorkbookModel,
  input: ModelInput,
  result: ModelResult,
  axis: TimeAxis,
  hasDebt: boolean,
  hasWaterfall: boolean,
): void {
  const sheet = workbook.sheet('Summary', {
    freezeRows: 1,
    columnWidths: [
      { column: LABEL_COL, width: 44 },
      { column: TOTAL_COL, width: 22 },
      { column: TOTAL_COL + 1, width: 10 },
    ],
  });

  sheet.at(sheet.claimRow(), LABEL_COL, {
    kind: 'header',
    value: `${input.property.name} — investment summary`,
    format: 'text',
  });
  sheet.skipRows(1);

  const last = axis.count - 1;

  /* ------------------------------------------------------------------ */
  sheet.section('Property');
  text(sheet, 'Property', input.property.name);
  text(sheet, 'Type', input.property.propertyType);
  text(sheet, 'Market', input.property.market ?? '—');
  link(sheet, 'Rentable area', 'assumptions.rentableArea', 'area', 'summary.area');
  text(sheet, 'Forecast', `${input.forecast.startDate}, ${axis.count} months`);

  /* ------------------------------------------------------------------ */
  sheet.section('Acquisition');
  link(sheet, 'Purchase price', 'assumptions.purchasePrice', 'currency0', 'summary.price');
  link(sheet, 'Total cost', 'returns.totalCost', 'currency0', 'summary.totalCost');
  link(sheet, 'Going-in cap rate', 'returns.goingInCapRate', 'percent2', 'summary.goingIn');

  /* ------------------------------------------------------------------ */
  sheet.section('Operations');
  formula(
    sheet,
    'Year 1 NOI',
    (refs) => `SUM(${refs.range('cashFlow.netOperatingIncome', 0, Math.min(11, last))})`,
    'currency0',
    'summary.year1Noi',
  );
  link(sheet, 'Terminal NOI', 'returns.terminalNoi', 'currency0', 'summary.terminalNoi');

  /* ------------------------------------------------------------------ */
  sheet.section('Exit');
  link(sheet, 'Exit cap rate', 'assumptions.exitCapRate', 'percent2', 'summary.exitCap');
  link(sheet, 'Gross sale price', 'returns.grossSalePrice', 'currency0', 'summary.salePrice');
  link(sheet, 'Selling costs', 'returns.sellingCosts', 'currency0', 'summary.sellingCosts');
  link(
    sheet,
    'Net sale proceeds before debt',
    'returns.netSaleProceeds',
    'currency0',
    'summary.netProceeds',
  );

  /* ------------------------------------------------------------------ */
  if (hasDebt) {
    sheet.section('Debt');
    formula(
      sheet,
      'Peak debt balance',
      (refs) => `MAX(${refs.range('debt.endingBalance', 0, last)})`,
      'currency0',
      'summary.peakDebt',
    );
    formula(
      sheet,
      'Loan to value at acquisition',
      (refs) =>
        `IF(${refs.ref('returns.totalCost')}=0,0,` +
        `${refs.ref('debt.endingBalance', 0)}/${refs.ref('returns.totalCost')})`,
      'percent2',
      'summary.ltv',
    );
    formula(
      sheet,
      'Total interest paid',
      (refs) => `SUM(${refs.range('debt.interest', 0, last)})`,
      'currency0',
      'summary.totalInterest',
    );
  }

  /* ------------------------------------------------------------------ */
  sheet.section('Returns');
  link(sheet, 'Unlevered XIRR', 'returns.unleveredXirr', 'percent2', 'summary.unleveredIrr');
  link(sheet, 'Levered XIRR', 'returns.leveredXirr', 'percent2', 'summary.leveredIrr');
  link(sheet, 'Equity multiple', 'returns.equityMultiple', 'multiple', 'summary.multiple');
  link(sheet, 'Net present value', 'returns.npv', 'currency0', 'summary.npv');
  link(sheet, 'Profit', 'returns.profit', 'currency0', 'summary.profit');

  /* ------------------------------------------------------------------ */
  /* Checks                                                              */
  /* ------------------------------------------------------------------ */
  sheet.skipRows(1);
  sheet.section('Checks');

  const check = (
    label: string,
    difference: (refs: import('../model.js').RefResolver) => string,
    key: string,
    tolerance = '0.05',
  ): void => {
    const row = sheet.claimRow();
    sheet.label(row, LABEL_COL, label, { indent: 1 });
    sheet.at(
      row,
      TOTAL_COL,
      { kind: 'formula', formula: difference, format: 'currency' },
      `${key}.difference`,
    );
    sheet.at(
      row,
      TOTAL_COL + 1,
      {
        kind: 'formula',
        formula: (refs) => `IF(ABS(${refs.ref(`${key}.difference`)})<=${tolerance},"OK","CHECK")`,
        format: 'text',
      },
      key,
    );
  };

  check(
    'Revenue rolls into cash flow',
    (refs) =>
      `SUM(${refs.range('revenue.effectiveGrossRevenue', 0, last)})-` +
      `SUM(${refs.range('cashFlow.effectiveGrossRevenue', 0, last)})`,
    'check.revenueRolls',
  );

  check(
    'Expenses roll into cash flow',
    (refs) =>
      `SUM(${refs.range('expenses.total', 0, last)})-` +
      `SUM(${refs.range('cashFlow.operatingExpenses', 0, last)})`,
    'check.expensesRoll',
  );

  check(
    'Rent roll totals to contractual base rent',
    (refs) =>
      `SUM(${refs.range('rentRoll.totalBaseRent', 0, last)})-` +
      `SUM(${refs.range('revenue.contractualBaseRent', 0, last)})`,
    'check.rentRollRolls',
  );

  check(
    'NOI equals revenue less expenses',
    (refs) =>
      `SUM(${refs.range('cashFlow.netOperatingIncome', 0, last)})-` +
      `SUM(${refs.range('cashFlow.effectiveGrossRevenue', 0, last)})-` +
      `SUM(${refs.range('cashFlow.operatingExpenses', 0, last)})`,
    'check.noi',
  );

  if (hasDebt) {
    check(
      'Debt fully repaid by the end of the forecast',
      (refs) => refs.ref('debt.endingBalance', last),
      'check.debtRepaid',
      '1',
    );
    /*
     * Draws in, principal and payoff out, and capitalised interest added along
     * the way, must net to the balance left standing — which is zero once the
     * loan is retired.
     *
     * The first version of this check omitted capitalised interest and was off
     * by exactly that amount on the development fixture: a facility that
     * capitalises grows without a matching draw. The check was wrong, not the
     * model, and `check.debtRepaid` passing is what said so.
     */
    check(
      'Draws, principal, payoff and capitalised interest balance',
      (refs) =>
        `SUM(${refs.range('debt.proceeds', 0, last)})+` +
        `SUM(${refs.range('debt.capitalisedTotal', 0, last)})+` +
        `SUM(${refs.range('debt.principal', 0, last)})+` +
        `SUM(${refs.range('debt.payoffSigned', 0, last)})`,
      'check.debtBalances',
      '1',
    );
  }

  if (hasWaterfall) {
    /*
     * Every dollar the partnership distributes must have come through a tier.
     * The tiers are imported and the distribution total is a formula over
     * them, so this catches a tier the exporter failed to carry across.
     */
    check(
      'Partner distributions equal the sum of their tiers',
      (refs) =>
        `${refs.ref('waterfall.total.distributions')}-` +
        `${refs.ref('waterfall.total.contributions')}-` +
        `${refs.ref('waterfall.total.profit')}`,
      'check.waterfallBalances',
      '1',
    );
    /*
     * The dated partner cash-flow rows and the tier table are two independent
     * routes to the same number: the flows come across period by period, while
     * profit is a formula over the tiers less contributions. They must agree,
     * and they only agree if every period was carried and signed correctly.
     *
     * This is the check that makes the partner IRRs trustworthy — an XIRR over
     * a row missing a month is perfectly well-formed and simply wrong.
     */
    check(
      'Partner cash flows tie to partner profit',
      (refs) => `${refs.ref('waterfall.total.flowTotal')}-${refs.ref('waterfall.total.profit')}`,
      'check.waterfallFlows',
      '1',
    );
  }

  check(
    'Sale lands in exactly one period',
    (refs) =>
      `SUM(${refs.range('cashFlow.grossSaleProceeds', 0, last)})-${refs.ref(
        'returns.grossSalePrice',
      )}`,
    'check.saleOnce',
    '1',
  );
}

/* -------------------------------------------------------------------------- */

function text(sheet: ReturnType<WorkbookModel['sheet']>, label: string, value: string): void {
  const row = sheet.claimRow();
  sheet.label(row, LABEL_COL, label, { indent: 1 });
  sheet.at(row, TOTAL_COL, { kind: 'metadata', value, format: 'text' });
}

/** A figure taken from the sheet that calculated it. */
function link(
  sheet: ReturnType<WorkbookModel['sheet']>,
  label: string,
  sourceKey: string,
  format: CellSpec['format'],
  key: string,
): void {
  const row = sheet.claimRow();
  sheet.label(row, LABEL_COL, label, { indent: 1 });
  sheet.at(
    row,
    TOTAL_COL,
    { kind: 'formula', formula: (refs) => refs.ref(sourceKey), ...(format ? { format } : {}) },
    key,
  );
}

function formula(
  sheet: ReturnType<WorkbookModel['sheet']>,
  label: string,
  build: (refs: import('../model.js').RefResolver) => string,
  format: CellSpec['format'],
  key: string,
): void {
  const row = sheet.claimRow();
  sheet.label(row, LABEL_COL, label, { indent: 1 });
  sheet.at(row, TOTAL_COL, { kind: 'formula', formula: build, ...(format ? { format } : {}) }, key);
}

import type { CashFlowLine, ModelResult } from '@cre/domain-models';
import type { WorkbookModel } from '../model.js';
import { scheduleColumnWidths, seriesRow } from '../layout.js';
import type { TimeAxis } from '../layout.js';

/**
 * The property cash-flow statement, assembled from the supporting schedules.
 *
 * Nothing is recalculated here. Revenue comes from Revenue, expenses from
 * Expenses, and every subtotal is a formula over the lines above it — so
 * clicking any figure in Excel walks back to where it was worked out rather
 * than into a formula that restates the whole model.
 *
 * Sign conventions follow the engine exactly, and they are not uniform:
 * absorption, selling costs and debt payoff are stored negative, while
 * operating expenses, vacancy, capital, interest and principal are stored
 * positive and subtracted. Getting one backwards produces a workbook that is
 * plausible and wrong, which is why the reconciliation test checks each
 * subtotal rather than only the last line.
 */
export function buildCashFlow(
  workbook: WorkbookModel,
  result: ModelResult,
  axis: TimeAxis,
  hasDebt: boolean,
): void {
  const sheet = workbook.sheet('Cash Flow', {
    freezeRows: 4,
    freezeColumns: 2,
    columnWidths: scheduleColumnWidths(axis),
  });

  sheet.at(sheet.claimRow(), 1, { kind: 'header', value: 'Property cash flow', format: 'text' });

  const engineValue = (line: CashFlowLine, period: number): number =>
    Number(result.monthly[line][period] ?? '0');

  const linked = (label: string, key: string, sourceKey: string, line: CashFlowLine): void => {
    seriesRow(sheet, axis, { label, key, indent: 1 }, (period) => ({
      kind: 'formula',
      formula: (refs) => refs.ref(sourceKey, period),
      cachedValue: engineValue(line, period),
    }));
  };

  linked(
    'Effective gross revenue',
    'cashFlow.effectiveGrossRevenue',
    'revenue.effectiveGrossRevenue',
    'effectiveGrossRevenue',
  );
  linked('Operating expenses', 'cashFlow.operatingExpenses', 'expenses.total', 'operatingExpenses');

  seriesRow(
    sheet,
    axis,
    { label: 'Net operating income', key: 'cashFlow.netOperatingIncome', bold: true },
    (period) => ({
      kind: 'formula',
      formula: (refs) =>
        `${refs.ref('cashFlow.effectiveGrossRevenue', period)}+` +
        `${refs.ref('cashFlow.operatingExpenses', period)}`,
      cachedValue: engineValue('netOperatingIncome', period),
    }),
  );

  /* Capital costs sit below NOI. */
  const fromEngine = (line: CashFlowLine, label: string): void => {
    seriesRow(sheet, axis, { label, key: `cashFlow.${line}`, indent: 1 }, (period) => ({
      kind: 'staticDerived',
      value: engineValue(line, period),
    }));
  };

  fromEngine('tenantImprovements', 'Tenant improvements');
  fromEngine('leasingCommissions', 'Leasing commissions');

  /*
   * Carried across whole rather than split.
   *
   * The engine's capital expenditure is the capital plan plus any capitalised
   * operating expenses, and `ModelResult` reports only the sum. Reconstructing
   * the split would mean recomputing one half here in TypeScript — a second
   * implementation of the expense rule, which is the thing this design exists
   * to avoid. So the total is taken as given, and the capitalised expense rows
   * on the Expenses sheet are shown for audit but deliberately do not feed this
   * line; adding them would double-count.
   */
  fromEngine('capitalExpenditures', 'Capital expenditure');

  seriesRow(
    sheet,
    axis,
    { label: 'Unlevered cash flow', key: 'cashFlow.unleveredCashFlow', bold: true },
    (period) => ({
      kind: 'formula',
      formula: (refs) =>
        `${refs.ref('cashFlow.netOperatingIncome', period)}+` +
        `${refs.ref('cashFlow.tenantImprovements', period)}+` +
        `${refs.ref('cashFlow.leasingCommissions', period)}+` +
        `${refs.ref('cashFlow.capitalExpenditures', period)}`,
      cachedValue: engineValue('unleveredCashFlow', period),
    }),
  );

  /* ------------------------------------------------------------------ */
  /* Disposition                                                         */
  /* ------------------------------------------------------------------ */
  sheet.skipRows(1);
  sheet.section('Disposition');

  seriesRow(
    sheet,
    axis,
    { label: 'Gross sale proceeds', key: 'cashFlow.grossSaleProceeds', indent: 1 },
    (period) => ({
      kind: 'formula',
      formula: (refs) =>
        `IF(${period + 1}=${refs.name('SaleMonth')},${refs.ref('returns.grossSalePrice')},0)`,
      cachedValue: engineValue('grossSaleProceeds', period),
    }),
  );

  seriesRow(
    sheet,
    axis,
    { label: 'Selling costs', key: 'cashFlow.sellingCosts', indent: 1 },
    (period) => ({
      kind: 'formula',
      // Stored negative by the engine, so the workbook negates it too.
      formula: (refs) =>
        `-${refs.ref('cashFlow.grossSaleProceeds', period)}*${refs.name('SellingCosts')}`,
      cachedValue: engineValue('sellingCosts', period),
    }),
  );

  if (hasDebt) {
    linked('Debt proceeds', 'cashFlow.debtProceeds', 'debt.proceeds', 'debtProceeds');
    linked('Interest expense', 'cashFlow.interestExpense', 'debt.interest', 'interestExpense');
    linked(
      'Principal amortisation',
      'cashFlow.principalAmortization',
      'debt.principal',
      'principalAmortization',
    );
    linked('Financing fees', 'cashFlow.financingFees', 'debt.fees', 'financingFees');
    linked('Debt payoff', 'cashFlow.debtPayoff', 'debt.payoffSigned', 'debtPayoff');
  } else {
    for (const line of [
      'debtProceeds',
      'interestExpense',
      'principalAmortization',
      'financingFees',
      'debtPayoff',
    ] as const) {
      seriesRow(sheet, axis, { label: labelFor(line), key: `cashFlow.${line}`, indent: 1 }, () => ({
        kind: 'formula',
        formula: () => '0',
        cachedValue: 0,
      }));
    }
  }

  fromEngine('restrictedCash', 'Restricted cash movement');

  seriesRow(
    sheet,
    axis,
    { label: 'Levered cash flow', key: 'cashFlow.leveredCashFlow', bold: true },
    (period) => ({
      kind: 'formula',
      formula: (refs) =>
        `${refs.ref('cashFlow.unleveredCashFlow', period)}` +
        `+${refs.ref('cashFlow.grossSaleProceeds', period)}` +
        `+${refs.ref('cashFlow.sellingCosts', period)}` +
        `+${refs.ref('cashFlow.debtProceeds', period)}` +
        `+${refs.ref('cashFlow.interestExpense', period)}` +
        `+${refs.ref('cashFlow.principalAmortization', period)}` +
        `+${refs.ref('cashFlow.financingFees', period)}` +
        `+${refs.ref('cashFlow.debtPayoff', period)}` +
        `+${refs.ref('cashFlow.restrictedCash', period)}`,
      cachedValue: engineValue('leveredCashFlow', period),
    }),
  );
}

function labelFor(line: string): string {
  const labels: Record<string, string> = {
    debtProceeds: 'Debt proceeds',
    interestExpense: 'Interest expense',
    principalAmortization: 'Principal amortisation',
    financingFees: 'Financing fees',
    debtPayoff: 'Debt payoff',
  };
  return labels[line] ?? line;
}

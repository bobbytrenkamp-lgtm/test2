import type { ModelInput, ModelResult, OperatingExpense } from '@cre/domain-models';
import type { RefResolver, WorkbookModel } from '../model.js';
import { scheduleColumnWidths, seriesRow } from '../layout.js';
import type { TimeAxis } from '../layout.js';

/**
 * The operating expense schedule, calculated rather than copied.
 *
 * This sheet is fully formula-driven, because the engine's expense rule is a
 * closed form and can be reproduced exactly (`computeExpenseSeries`):
 *
 *   base              = per the expense method
 *   occupancyAdjusted = base x (fixedShare + variableShare x occupancy)
 *
 * with the occupancy adjustment skipped for the two percentage methods, which
 * already scale with the revenue they are a percentage of.
 *
 * ## Why the percentage methods are not circular here
 *
 * In the engine a management fee on effective gross revenue *is* circular: the
 * fee changes NOI, and where the fee is recoverable it changes recoveries,
 * which are revenue. The engine resolves that with a damped fixed-point
 * iteration.
 *
 * In this workbook recoveries are engine-supplied values, so effective gross
 * revenue does not depend on expenses and the dependency graph is acyclic. The
 * fee is a plain formula and Excel needs no iterative calculation. That is a
 * real consequence of where the formula boundary was drawn, and it is why
 * editing a recoverable expense in Excel will not move recoveries: see
 * `docs/excel-live-model.md`.
 */
export function buildExpenses(
  workbook: WorkbookModel,
  input: ModelInput,
  result: ModelResult,
  axis: TimeAxis,
): void {
  const sheet = workbook.sheet('Expenses', {
    freezeRows: 4,
    freezeColumns: 2,
    columnWidths: scheduleColumnWidths(axis),
  });

  sheet.at(sheet.claimRow(), 1, {
    kind: 'header',
    value: 'Operating expenses',
    format: 'text',
  });

  const operating = input.expenses.filter((expense) => !expense.isCapitalized);
  const capitalized = input.expenses.filter((expense) => expense.isCapitalized);

  for (const expense of operating) {
    expenseRow(sheet, axis, expense);
  }

  seriesRow(
    sheet,
    axis,
    { label: 'Total operating expenses', key: 'expenses.total', bold: true },
    (period) => ({
      kind: 'formula',
      formula: (refs) =>
        operating.length === 0
          ? '0'
          : operating.map((expense) => refs.ref(`expenses.${expense.id}`, period)).join('+'),
      cachedValue: Number(result.monthly.operatingExpenses[period] ?? '0'),
    }),
  );

  if (capitalized.length > 0) {
    sheet.skipRows(1);
    sheet.section('Capitalised expenses (below NOI)');
    for (const expense of capitalized) {
      expenseRow(sheet, axis, expense);
    }
    seriesRow(
      sheet,
      axis,
      { label: 'Total capitalised expenses', key: 'expenses.capitalisedTotal', bold: true },
      (period) => ({
        kind: 'formula',
        formula: (refs) =>
          capitalized.map((expense) => refs.ref(`expenses.${expense.id}`, period)).join('+'),
      }),
    );
  } else {
    // Registered even when empty so the Cash Flow sheet can reference it
    // unconditionally rather than branching on the shape of the model.
    seriesRow(
      sheet,
      axis,
      { label: 'Total capitalised expenses', key: 'expenses.capitalisedTotal', bold: true },
      () => ({ kind: 'formula', formula: () => '0', cachedValue: 0 }),
    );
  }
}

function expenseRow(
  sheet: ReturnType<WorkbookModel['sheet']>,
  axis: TimeAxis,
  expense: OperatingExpense,
): void {
  seriesRow(
    sheet,
    axis,
    { label: expense.name, key: `expenses.${expense.id}`, indent: 1 },
    (period) => ({
      kind: 'formula',
      formula: (refs) => expenseFormula(refs, expense, period),
    }),
  );
}

/** One period of one expense, mirroring `computeExpenseSeries`. */
function expenseFormula(refs: RefResolver, expense: OperatingExpense, period: number): string {
  const amount = refs.absRef(`expense.${expense.id}.amount`);
  const growth = refs.has(`curve.${expense.growthCurveId ?? ''}.factor`, period)
    ? `*${refs.ref(`curve.${expense.growthCurveId ?? ''}.factor`, period)}`
    : '';

  let base: string;
  switch (expense.method) {
    case 'fixed_annual':
      base = `${amount}/12${growth}`;
      break;
    case 'per_area_per_year':
      base = `${amount}*${refs.name('RentableArea')}/12${growth}`;
      break;
    case 'per_unit_per_year':
      base = `${amount}*${refs.name('UnitCount')}/12${growth}`;
      break;
    case 'percent_of_effective_gross_revenue':
      // No growth factor and no occupancy adjustment: both are already in the
      // revenue this is a percentage of.
      return `-${amount}*${refs.ref('revenue.effectiveGrossRevenue', period)}`;
    case 'percent_of_base_rent':
      return `-${amount}*${refs.ref('revenue.scheduledBaseRent', period)}`;
    case 'custom_monthly_schedule':
      base = `${expense.monthlySchedule[period] ?? '0'}${growth}`;
      break;
    default:
      base = '0';
  }

  const variable = refs.absRef(`expense.${expense.id}.variableShare`);
  const occupancy = refs.ref('assumptions.occupancy', period);
  // Negated: the engine reports deductions negative on `ModelResult.monthly`,
  // and the workbook follows that convention throughout so every subtotal is
  // an addition and no reader has to remember which lines flip.
  return `-(${base})*((1-${variable})+${variable}*${occupancy})`;
}

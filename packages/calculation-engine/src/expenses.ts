import type { OperatingExpense } from '@cre/domain-models';
import { Decimal, ONE, TWELVE, ZERO, d, zeros } from './decimal.js';
import type { ForecastCalendar } from './calendar.js';
import type { CurveSet } from './curves.js';
import { TraceRecorder, traceInputs } from './trace.js';

export interface ExpenseSeries {
  expense: OperatingExpense;
  /** Total expense in each period, as a positive amount. */
  amount: Decimal[];
  /** Portion of `amount` that is recoverable from tenants. */
  recoverable: Decimal[];
  /**
   * The recoverable pool restated as if the building were at the gross-up
   * occupancy. Computed per lease at recovery time, so this holds the split
   * between fixed and variable that grossing up needs.
   */
  recoverableFixed: Decimal[];
  /**
   * The occupancy-variable recoverable portion stated at 100% occupancy.
   * Keeping it un-adjusted is what makes grossing up possible at any occupancy,
   * including zero, without dividing by the occupancy rate.
   */
  recoverableVariableFull: Decimal[];
}

export interface ExpenseContext {
  calendar: ForecastCalendar;
  curves: CurveSet;
  trace: TraceRecorder;
  rentableArea: Decimal;
  unitCount: number;
  /** Physical occupancy in each period, 0..1. */
  occupancy: Decimal[];
  /** Effective gross revenue from the previous solver pass. */
  effectiveGrossRevenue: Decimal[];
  /** Scheduled base rent from the previous solver pass. */
  baseRent: Decimal[];
}

/**
 * Expenses that reference revenue (a management fee on effective gross revenue,
 * for example) are circular: the fee changes NOI, NOI does not feed revenue,
 * but the fee is often recoverable, and recoveries are revenue. The engine
 * resolves this with a damped fixed-point iteration in `engine.ts`; this
 * function is one pass of it and takes last pass's revenue as an input.
 */
export function computeExpenseSeries(
  expenses: OperatingExpense[],
  ctx: ExpenseContext,
  recordTrace: boolean,
): ExpenseSeries[] {
  const n = ctx.calendar.periods.length;

  return expenses.map((expense) => {
    const factors = ctx.curves.factors(expense.growthCurveId);
    const amount = zeros(n);
    const recoverable = zeros(n);
    const recoverableFixed = zeros(n);
    const recoverableVariableFull = zeros(n);

    const recoverableShare = d(expense.recoverableShare).clamp(0, 1);
    const variableShare = d(expense.variableShare).clamp(0, 1);
    const fixedShare = ONE.minus(variableShare);

    for (let i = 0; i < n; i += 1) {
      const growth = factors[i] ?? ONE;
      let base: Decimal;

      switch (expense.method) {
        case 'fixed_annual':
          base = d(expense.amount).dividedBy(TWELVE).times(growth);
          break;
        case 'per_area_per_year':
          base = d(expense.amount).times(ctx.rentableArea).dividedBy(TWELVE).times(growth);
          break;
        case 'per_unit_per_year':
          base = d(expense.amount).times(ctx.unitCount).dividedBy(TWELVE).times(growth);
          break;
        case 'percent_of_effective_gross_revenue':
          base = d(expense.amount).times(ctx.effectiveGrossRevenue[i] ?? ZERO);
          break;
        case 'percent_of_base_rent':
          base = d(expense.amount).times(ctx.baseRent[i] ?? ZERO);
          break;
        case 'custom_monthly_schedule':
          base = d(expense.monthlySchedule[i] ?? '0').times(growth);
          break;
        default:
          base = ZERO;
      }

      // The variable portion scales with occupancy; the fixed portion does not.
      const occupancy = (ctx.occupancy[i] ?? ONE).clamp(0, 1);
      const occupancyAdjusted =
        expense.method === 'percent_of_effective_gross_revenue' ||
        expense.method === 'percent_of_base_rent'
          ? base
          : base.times(fixedShare.plus(variableShare.times(occupancy)));

      amount[i] = occupancyAdjusted;
      recoverable[i] = occupancyAdjusted.times(recoverableShare);
      recoverableFixed[i] = base.times(fixedShare).times(recoverableShare);
      recoverableVariableFull[i] = base.times(variableShare).times(recoverableShare);
    }

    if (recordTrace) {
      ctx.trace.record({
        target: `expense:${expense.id}:series`,
        formula: `expense.${expense.method}`,
        description: `${expense.name} forecast by ${expense.method.replace(/_/g, ' ')}, ${variableShare.times(100).toFixed(0)}% occupancy-variable, ${recoverableShare.times(100).toFixed(0)}% recoverable.`,
        inputs: traceInputs({
          amount: expense.amount,
          rentableArea: ctx.rentableArea,
          unitCount: ctx.unitCount,
          growthCurve: expense.growthCurveId ?? 'none',
          variableShare,
          recoverableShare,
        }),
        result: amount.reduce((acc, v) => acc.plus(v), ZERO).toString(),
        sources: [`expense:${expense.id}`],
      });
    }

    return { expense, amount, recoverable, recoverableFixed, recoverableVariableFull };
  });
}

/** Sums an expense series into one total per period. */
export function totalExpenses(
  series: ExpenseSeries[],
  periods: number,
  includeCapitalized: boolean,
): Decimal[] {
  const total = zeros(periods);
  for (const item of series) {
    if (!includeCapitalized && item.expense.isCapitalized) continue;
    if (includeCapitalized && !item.expense.isCapitalized) continue;
    for (let i = 0; i < periods; i += 1) {
      total[i] = (total[i] as Decimal).plus(item.amount[i] ?? ZERO);
    }
  }
  return total;
}

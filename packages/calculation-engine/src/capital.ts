import type { CapitalItem } from '@cre/domain-models';
import { Decimal, ONE, TWELVE, ZERO, d, zeros } from './decimal.js';
import { type CalendarDate, type ForecastCalendar, compareDates, parseDate } from './calendar.js';
import type { CurveSet } from './curves.js';
import { TraceRecorder, traceInputs } from './trace.js';

export interface CapitalContext {
  calendar: ForecastCalendar;
  curves: CurveSet;
  rentableArea: Decimal;
  unitCount: number;
  trace: TraceRecorder;
}

/**
 * Capital expenditure forecasting. Every item produces a monthly series; items
 * with explicit start and end dates are only charged inside that window, which
 * is what lets a construction draw schedule and a recurring reserve coexist in
 * the same model.
 */
export function computeCapital(
  items: CapitalItem[],
  ctx: CapitalContext,
  recordTrace: boolean,
): { total: Decimal[]; byItem: Map<string, Decimal[]> } {
  const n = ctx.calendar.periods.length;
  const total = zeros(n);
  const byItem = new Map<string, Decimal[]>();

  for (const item of items) {
    const factors = ctx.curves.factors(item.growthCurveId);
    const series = zeros(n);
    const start: CalendarDate | null = item.startDate ? parseDate(item.startDate) : null;
    const end: CalendarDate | null = item.endDate ? parseDate(item.endDate) : null;

    if (start && end && compareDates(end, start) < 0) {
      ctx.trace.error(
        'CAPITAL_DATES_OUT_OF_ORDER',
        `Capital item "${item.name}" ends before it starts.`,
        `capital:${item.id}`,
        'endDate',
      );
    }

    for (let i = 0; i < n; i += 1) {
      const period = ctx.calendar.periods[i];
      if (!period) continue;
      const growth = factors[i] ?? ONE;

      if (item.method === 'one_time') {
        // A one-time cost lands in the period containing its start date.
        if (start && compareDates(start, period.start) >= 0 && compareDates(start, period.end) <= 0) {
          series[i] = d(item.amount).times(growth);
        }
        continue;
      }

      if (start && compareDates(start, period.end) > 0) continue;
      if (end && compareDates(end, period.start) < 0) continue;

      switch (item.method) {
        case 'fixed_annual':
          series[i] = d(item.amount).dividedBy(TWELVE).times(growth);
          break;
        case 'per_area_per_year':
          series[i] = d(item.amount).times(ctx.rentableArea).dividedBy(TWELVE).times(growth);
          break;
        case 'per_unit_per_year':
          series[i] = d(item.amount).times(ctx.unitCount).dividedBy(TWELVE).times(growth);
          break;
        case 'custom_monthly_schedule':
          series[i] = d(item.monthlySchedule[i] ?? '0').times(growth);
          break;
        default:
          series[i] = ZERO;
      }
    }

    byItem.set(item.id, series);
    for (let i = 0; i < n; i += 1) total[i] = (total[i] as Decimal).plus(series[i] as Decimal);

    if (recordTrace) {
      ctx.trace.record({
        target: `capital:${item.id}:series`,
        formula: `capital.${item.method}`,
        description: `${item.name} (${item.category.replace(/_/g, ' ')}) forecast by ${item.method.replace(/_/g, ' ')}.`,
        inputs: traceInputs({
          amount: item.amount,
          startDate: item.startDate ?? 'forecast start',
          endDate: item.endDate ?? 'forecast end',
          rentableArea: ctx.rentableArea,
          unitCount: ctx.unitCount,
        }),
        result: series.reduce((acc, v) => acc.plus(v), ZERO).toString(),
        sources: [`capital:${item.id}`],
      });
    }
  }

  return { total, byItem };
}

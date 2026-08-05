import type { OtherPropertyRevenue } from '@cre/domain-models';
import { Decimal, ONE, TWELVE, ZERO, d, zeros } from './decimal.js';
import type { ForecastCalendar } from './calendar.js';
import type { CurveSet } from './curves.js';
import type { OccurrenceSeries } from './leases.js';
import { TraceRecorder, traceInputs } from './trace.js';

export interface OtherRevenueContext {
  calendar: ForecastCalendar;
  curves: CurveSet;
  rentableArea: Decimal;
  unitCount: number;
  occupancy: Decimal[];
  baseRent: Decimal[];
  trace: TraceRecorder;
}

/** Property-level revenue that is not attached to a specific lease. */
export function computeOtherPropertyRevenue(
  items: OtherPropertyRevenue[],
  ctx: OtherRevenueContext,
  recordTrace: boolean,
): { total: Decimal[]; byItem: Map<string, Decimal[]> } {
  const n = ctx.calendar.periods.length;
  const total = zeros(n);
  const byItem = new Map<string, Decimal[]>();

  for (const item of items) {
    const factors = ctx.curves.factors(item.growthCurveId);
    const series = zeros(n);
    for (let i = 0; i < n; i += 1) {
      const growth = factors[i] ?? ONE;
      let amount: Decimal;
      switch (item.method) {
        case 'fixed_annual':
          amount = d(item.amount).dividedBy(TWELVE).times(growth);
          break;
        case 'per_unit_per_month':
          amount = d(item.amount).times(ctx.unitCount).times(growth);
          break;
        case 'per_area_per_year':
          amount = d(item.amount).times(ctx.rentableArea).dividedBy(TWELVE).times(growth);
          break;
        case 'percent_of_base_rent':
          amount = d(item.amount).times(ctx.baseRent[i] ?? ZERO);
          break;
        case 'custom_monthly_schedule':
          amount = d(item.monthlySchedule[i] ?? '0').times(growth);
          break;
        default:
          amount = ZERO;
      }
      if (item.varyWithOccupancy) amount = amount.times((ctx.occupancy[i] ?? ONE).clamp(0, 1));
      series[i] = amount;
      total[i] = (total[i] as Decimal).plus(amount);
    }
    byItem.set(item.id, series);

    if (recordTrace) {
      ctx.trace.record({
        target: `otherRevenue:${item.id}:series`,
        formula: `otherRevenue.${item.method}`,
        description: `${item.name} forecast by ${item.method.replace(/_/g, ' ')}${item.varyWithOccupancy ? ', scaled by physical occupancy' : ''}.`,
        inputs: traceInputs({
          amount: item.amount,
          rentableArea: ctx.rentableArea,
          unitCount: ctx.unitCount,
          growthCurve: item.growthCurveId ?? 'none',
        }),
        result: series.reduce((acc, v) => acc.plus(v), ZERO).toString(),
        sources: [`otherRevenue:${item.id}`],
      });
    }
  }

  return { total, byItem };
}

/**
 * Percentage (overage) rent.
 *
 * Sales and the breakpoint are compared on an annualised basis for the fiscal
 * year, then the resulting overage is spread across the months the tenant
 * occupied. A natural breakpoint is derived from the tenant's own annualised
 * base rent for that year, so a rent step or escalation moves the breakpoint
 * with it, which is the behaviour a natural-breakpoint clause describes.
 */
export function computePercentageRent(
  occurrences: OccurrenceSeries[],
  calendar: ForecastCalendar,
  curves: CurveSet,
  trace: TraceRecorder,
  recordTrace: boolean,
): { total: Decimal[]; byOccurrence: Map<string, Decimal[]> } {
  const n = calendar.periods.length;
  const total = zeros(n);
  const byOccurrence = new Map<string, Decimal[]>();
  const fiscalYears = [...calendar.periodsByFiscalYear.entries()].sort((a, b) => a[0] - b[0]);

  for (const series of occurrences) {
    const config = series.occurrence.percentageRent;
    const out = zeros(n);
    byOccurrence.set(series.occurrence.id, out);
    if (!config || !config.enabled) continue;

    const overagePercent = d(config.overagePercent);
    if (overagePercent.lessThanOrEqualTo(0)) {
      trace.warn(
        'PERCENTAGE_RENT_NO_RATE',
        `Lease ${series.occurrence.sourceLeaseId} has percentage rent enabled but no overage percentage. No overage rent is billed.`,
        `lease:${series.occurrence.sourceLeaseId}`,
        'percentageRent.overagePercent',
      );
      continue;
    }

    for (const [fiscalYear, periodIndices] of fiscalYears) {
      const occupiedMonths = periodIndices.reduce(
        (acc, index) => acc.plus(series.timeFraction[index] ?? ZERO),
        ZERO,
      );
      if (occupiedMonths.isZero()) continue;

      const firstIndex = periodIndices[0] as number;
      const growth = curves.factors(config.salesGrowthCurveId)[firstIndex] ?? ONE;
      const annualSales = d(config.baseSales).times(growth).minus(d(config.exclusions));

      const baseRentInYear = periodIndices.reduce(
        (acc, index) => acc.plus(series.baseRent[index] ?? ZERO),
        ZERO,
      );
      const annualisedBaseRent = baseRentInYear.times(TWELVE).dividedBy(occupiedMonths);

      let breakpoint: Decimal;
      if (config.breakpointType === 'natural') {
        breakpoint = annualisedBaseRent.dividedBy(overagePercent);
      } else if (config.breakpointType === 'artificial') {
        breakpoint = d(config.breakpointAmount);
      } else {
        breakpoint = ZERO;
      }

      const overage = Decimal.max(annualSales.minus(breakpoint), ZERO).times(overagePercent);
      const billed = overage.times(occupiedMonths).dividedBy(TWELVE);
      if (billed.isZero()) continue;

      for (const index of periodIndices) {
        const fraction = series.timeFraction[index] ?? ZERO;
        if (fraction.isZero()) continue;
        const amount = overage.dividedBy(TWELVE).times(fraction);
        out[index] = (out[index] as Decimal).plus(amount);
        total[index] = (total[index] as Decimal).plus(amount);
      }

      if (recordTrace) {
        trace.record({
          target: `occurrence:${series.occurrence.id}:percentageRent:${fiscalYear}`,
          formula: `percentageRent.${config.breakpointType}`,
          description: `FY${fiscalYear} overage rent: ${overagePercent.times(100).toFixed(2)}% of sales above a ${config.breakpointType} breakpoint.`,
          inputs: traceInputs({
            annualSales,
            exclusions: config.exclusions,
            annualisedBaseRent,
            breakpoint,
            overagePercent,
            occupiedMonths,
          }),
          result: billed.toString(),
          sources: [`lease:${series.occurrence.sourceLeaseId}`],
        });
      }
    }
  }

  return { total, byOccurrence };
}

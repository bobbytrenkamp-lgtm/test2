import type { RecoveryDetailRow } from '@cre/domain-models';
import { Decimal, ONE, TWELVE, ZERO, d, zeros } from './decimal.js';
import type { ForecastCalendar } from './calendar.js';
import type { ExpenseSeries } from './expenses.js';
import type { LeaseOccurrence, OccurrenceSeries } from './leases.js';
import { TraceRecorder, traceInputs } from './trace.js';

/**
 * Expense recovery (reimbursement) calculation.
 *
 * Recoveries are settled on a fiscal-year cycle: the tenant's entitlement is
 * derived from the annual expense pool, then spread across the months the
 * tenant occupied. Partial fiscal years at either end of the forecast are
 * annualised for the entitlement comparison and re-prorated afterwards, so a
 * forecast that starts in July does not understate a base-year stop.
 */

export interface RecoveryContext {
  calendar: ForecastCalendar;
  expenses: ExpenseSeries[];
  /** Total revenue-producing area, the default pro-rata denominator. */
  denominatorArea: Decimal;
  /** Average physical occupancy in each period, 0..1. */
  occupancy: Decimal[];
  trace: TraceRecorder;
}

export interface RecoveryResult {
  /** Recovery revenue per period, per occurrence id. */
  byOccurrence: Map<string, Decimal[]>;
  total: Decimal[];
  detail: RecoveryDetailRow[];
}

interface AnnualPool {
  fiscalYear: number;
  months: number;
  /** Annualised recoverable pool at actual occupancy. */
  actual: Decimal;
  /** Annualised recoverable pool grossed up to the target occupancy. */
  grossedUp: Decimal;
  averageOccupancy: Decimal;
}

function poolForYear(
  ctx: RecoveryContext,
  periodIndices: number[],
  included: (series: ExpenseSeries) => boolean,
  grossUpTarget: Decimal | null,
): AnnualPool {
  const months = periodIndices.length;
  let fixed = ZERO;
  let variableFull = ZERO;
  let occupancySum = ZERO;

  for (const index of periodIndices) {
    occupancySum = occupancySum.plus((ctx.occupancy[index] ?? ONE).clamp(0, 1));
    for (const series of ctx.expenses) {
      if (!included(series)) continue;
      fixed = fixed.plus(series.recoverableFixed[index] ?? ZERO);
      variableFull = variableFull.plus(series.recoverableVariableFull[index] ?? ZERO);
    }
  }

  const averageOccupancy = months === 0 ? ZERO : occupancySum.dividedBy(months);
  const annualiser = months === 0 ? ZERO : TWELVE.dividedBy(months);

  const actual = fixed.plus(variableFull.times(averageOccupancy)).times(annualiser);
  const target = grossUpTarget ?? averageOccupancy;
  const grossedUp = fixed.plus(variableFull.times(target)).times(annualiser);

  return {
    fiscalYear: 0,
    months,
    actual,
    grossedUp,
    averageOccupancy,
  };
}

function includedPredicate(occurrence: LeaseOccurrence): (series: ExpenseSeries) => boolean {
  const include = new Set(occurrence.recovery.includedCategories);
  const exclude = new Set(occurrence.recovery.excludedCategories);
  return (series) => {
    const category = series.expense.category;
    if (series.expense.isCapitalized) return false;
    if (exclude.has(category)) return false;
    if (include.size > 0) return include.has(category);
    return d(series.expense.recoverableShare).greaterThan(0);
  };
}

export function computeRecoveries(
  occurrences: OccurrenceSeries[],
  ctx: RecoveryContext,
  recordTrace: boolean,
): RecoveryResult {
  const n = ctx.calendar.periods.length;
  const byOccurrence = new Map<string, Decimal[]>();
  const total = zeros(n);
  const detail: RecoveryDetailRow[] = [];

  const fiscalYears = [...ctx.calendar.periodsByFiscalYear.entries()].sort((a, b) => a[0] - b[0]);

  for (const series of occurrences) {
    const occurrence = series.occurrence;
    const config = occurrence.recovery;
    const recoveries = zeros(n);
    byOccurrence.set(occurrence.id, recoveries);

    if (config.method === 'none' || config.method === 'full_service_gross') continue;

    const predicate = includedPredicate(occurrence);
    const grossUpTarget =
      config.grossUpPercent !== null && config.grossUpPercent !== undefined
        ? d(config.grossUpPercent).clamp(0, 2)
        : null;

    const denominator = config.proRataShareOverride ? null : ctx.denominatorArea;
    let proRataShare: Decimal;
    if (config.proRataShareOverride) {
      proRataShare = d(config.proRataShareOverride);
    } else if (!denominator || denominator.isZero()) {
      ctx.trace.error(
        'RECOVERY_DENOMINATOR_ZERO',
        `Lease ${occurrence.sourceLeaseId} recovers expenses on a pro-rata basis, but the property has no revenue-producing area to divide by. Recovery is treated as zero.`,
        `lease:${occurrence.sourceLeaseId}`,
        'recovery',
      );
      continue;
    } else {
      proRataShare = occurrence.area.dividedBy(denominator);
    }

    // Base year defaults to the first fiscal year the model forecasts.
    const firstFiscalYear = fiscalYears[0]?.[0] ?? 0;
    let baseYear = config.baseYear ?? firstFiscalYear;
    if (config.method === 'base_year' && !ctx.calendar.periodsByFiscalYear.has(baseYear)) {
      ctx.trace.warn(
        'BASE_YEAR_OUTSIDE_FORECAST',
        `Lease ${occurrence.sourceLeaseId} uses base year ${baseYear}, which is outside the forecast. The first forecast year (${firstFiscalYear}) was used instead.`,
        `lease:${occurrence.sourceLeaseId}`,
        'recovery.baseYear',
      );
      baseYear = firstFiscalYear;
    }

    const basePool =
      config.method === 'base_year'
        ? poolForYear(
            ctx,
            ctx.calendar.periodsByFiscalYear.get(baseYear) ?? [],
            predicate,
            grossUpTarget,
          )
        : null;

    let priorRecovery: Decimal | null = null;
    let firstRecovery: Decimal | null = null;
    let yearOrdinal = 0;

    for (const [fiscalYear, periodIndices] of fiscalYears) {
      // Months (weighted) the tenant occupied during this fiscal year.
      const occupiedMonths = periodIndices.reduce(
        (acc, index) => acc.plus(series.occupancyFraction[index] ?? ZERO),
        ZERO,
      );
      if (occupiedMonths.isZero()) continue;
      yearOrdinal += 1;

      const pool = poolForYear(ctx, periodIndices, predicate, grossUpTarget);
      const included = ctx.expenses.filter(predicate).map((s) => s.expense.category);

      let entitlement: Decimal;
      let baseYearAmount = ZERO;
      let stopAmount = ZERO;

      switch (config.method) {
        case 'triple_net':
          entitlement = pool.grossedUp.times(proRataShare);
          break;
        case 'base_year': {
          baseYearAmount = (basePool?.grossedUp ?? ZERO).times(proRataShare);
          entitlement = Decimal.max(pool.grossedUp.times(proRataShare).minus(baseYearAmount), ZERO);
          break;
        }
        case 'expense_stop': {
          stopAmount = d(config.expenseStopPerArea ?? '0').times(occurrence.area);
          entitlement = Decimal.max(pool.grossedUp.times(proRataShare).minus(stopAmount), ZERO);
          break;
        }
        case 'fixed_amount': {
          const escalation = ONE.plus(d(config.fixedEscalationRate));
          entitlement = d(config.fixedAmount ?? '0').times(escalation.pow(yearOrdinal - 1));
          break;
        }
        default:
          entitlement = ZERO;
      }

      const adminFee = entitlement.times(d(config.adminFeePercent));
      let withFee = entitlement.plus(adminFee);
      const beforeCaps = withFee;

      // Caps and floors constrain year-over-year movement in the recovered
      // amount. A cumulative cap compounds off the first billed year; a
      // non-cumulative cap resets against the immediately preceding year.
      if (priorRecovery !== null && firstRecovery !== null) {
        if (config.capPercent !== null && config.capPercent !== undefined) {
          const cap = d(config.capPercent);
          const ceiling = config.capIsCumulative
            ? firstRecovery.times(ONE.plus(cap).pow(yearOrdinal - 1))
            : priorRecovery.times(ONE.plus(cap));
          withFee = Decimal.min(withFee, ceiling);
        }
        if (config.floorPercent !== null && config.floorPercent !== undefined) {
          const floor = d(config.floorPercent);
          const minimum = config.capIsCumulative
            ? firstRecovery.times(ONE.plus(floor).pow(yearOrdinal - 1))
            : priorRecovery.times(ONE.plus(floor));
          withFee = Decimal.max(withFee, minimum);
        }
      }

      const capAdjustment = withFee.minus(beforeCaps);
      priorRecovery = withFee;
      if (firstRecovery === null) firstRecovery = withFee;

      // Spread the annual entitlement over the months actually occupied.
      const annualToPeriod = withFee.dividedBy(TWELVE);
      for (const index of periodIndices) {
        const fraction = series.occupancyFraction[index] ?? ZERO;
        if (fraction.isZero()) continue;
        const amount = annualToPeriod.times(fraction);
        recoveries[index] = (recoveries[index] as Decimal).plus(amount);
        total[index] = (total[index] as Decimal).plus(amount);
      }

      detail.push({
        leaseId: occurrence.id,
        fiscalYear,
        method: config.method,
        includedCategories: [...new Set(included)],
        tenantArea: occurrence.area.toString(),
        denominatorArea: (denominator ?? ZERO).toString(),
        proRataShare: proRataShare.toString(),
        grossExpensePool: pool.actual.toString(),
        grossedUpExpensePool: pool.grossedUp.toString(),
        baseYearAmount: baseYearAmount.toString(),
        expenseStopAmount: stopAmount.toString(),
        recoveryBeforeCaps: beforeCaps.toString(),
        capAdjustment: capAdjustment.toString(),
        adminFee: adminFee.toString(),
        finalRecovery: withFee.toString(),
      });

      if (recordTrace) {
        ctx.trace.record({
          target: `occurrence:${occurrence.id}:recovery:${fiscalYear}`,
          formula: `recovery.${config.method}`,
          description: `FY${fiscalYear} expense recovery for ${occurrence.id} under a ${config.method.replace(/_/g, ' ')} structure, billed over ${occupiedMonths.toFixed(2)} occupied months.`,
          inputs: traceInputs({
            includedCategories: included.join(', '),
            tenantArea: occurrence.area,
            denominatorArea: denominator ?? ZERO,
            proRataShare,
            annualisedPool: pool.actual,
            grossedUpPool: pool.grossedUp,
            grossUpTarget: grossUpTarget ?? 'none (actual occupancy)',
            averageOccupancy: pool.averageOccupancy,
            baseYearAmount,
            expenseStop: stopAmount,
            adminFeePercent: config.adminFeePercent,
            adminFee,
            capAdjustment,
          }),
          result: withFee.toString(),
          sources: [`lease:${occurrence.sourceLeaseId}`],
        });
      }
    }
  }

  return { byOccurrence, total, detail };
}

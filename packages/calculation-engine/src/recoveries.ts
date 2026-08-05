import type { RecoveryConfig, RecoveryDetailRow, RecoveryPool } from '@cre/domain-models';
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
 *
 * Two things a real lease does that a single settled figure cannot express:
 *
 * **Several pools.** Operating costs on a base year with a 5% cap, taxes and
 * insurance net and uncapped, is one lease and three settlements. Modelling it
 * as one pool forces a choice between capping the taxes (wrong) and uncapping
 * the operating costs (also wrong). Each pool here settles on its own terms and
 * the results are summed.
 *
 * **Reconciliation.** A tenant pays an estimate monthly and the difference is
 * billed or credited after the year closes, typically in the first quarter.
 * That moves cash between years, which moves the IRR, so it is not a
 * presentational detail. The default remains "estimate equals actual", which
 * leaves nothing to reconcile and reproduces every figure the engine produced
 * before this existed.
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
  months: number;
  /** Annualised recoverable pool at actual occupancy. */
  actual: Decimal;
  /** Annualised recoverable pool grossed up to the target occupancy. */
  grossedUp: Decimal;
  averageOccupancy: Decimal;
}

/** The code reported for a lease that has no explicit pools. */
export const IMPLICIT_POOL_CODE = 'default';

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

  return { months, actual, grossedUp, averageOccupancy };
}

function includedPredicate(terms: RecoveryPool): (series: ExpenseSeries) => boolean {
  const include = new Set(terms.includedCategories);
  const exclude = new Set(terms.excludedCategories);
  return (series) => {
    const category = series.expense.category;
    if (series.expense.isCapitalized) return false;
    if (exclude.has(category)) return false;
    if (include.size > 0) return include.has(category);
    return d(series.expense.recoverableShare).greaterThan(0);
  };
}

/**
 * The pools to settle for one lease.
 *
 * A lease with no explicit pools is one implicit pool on the lease-level terms,
 * which is what every model written before pools existed means and why those
 * models produce identical figures.
 */
function poolsFor(config: RecoveryConfig): RecoveryPool[] {
  if (config.pools.length > 0) return config.pools;
  return [{ code: IMPLICIT_POOL_CODE, name: 'Recoveries', ...config }];
}

/**
 * The period a fiscal year's true-up is billed in, or null if it falls beyond
 * the forecast.
 *
 * Measured from the last period of the fiscal year rather than from a nominal
 * year end, so a forecast that stops mid-year reconciles from where it actually
 * stopped instead of from a month it never modelled.
 */
function reconciliationPeriod(
  periodIndices: number[],
  lagMonths: number,
  totalPeriods: number,
): number | null {
  const last = periodIndices[periodIndices.length - 1];
  if (last === undefined) return null;
  const target = last + lagMonths;
  return target < totalPeriods ? target : null;
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
    const recoveries = zeros(n);
    byOccurrence.set(occurrence.id, recoveries);

    for (const pool of poolsFor(occurrence.recovery)) {
      settlePool(
        pool,
        series,
        occurrence,
        ctx,
        fiscalYears,
        { recoveries, total, detail },
        recordTrace,
      );
    }
  }

  return { byOccurrence, total, detail };
}

/** Where a pool's settled figures accumulate. */
interface RecoverySink {
  /** This occurrence's recovery revenue, per period. */
  recoveries: Decimal[];
  /** Every occurrence's, per period. */
  total: Decimal[];
  detail: RecoveryDetailRow[];
}

/**
 * Settles one pool for one lease across every fiscal year it occupies.
 *
 * Pools do not interact: each keeps its own base year, its own cap history and
 * its own reconciliation, which is the whole reason for modelling them
 * separately rather than merging their categories into one entitlement.
 */
function settlePool(
  pool: RecoveryPool,
  series: OccurrenceSeries,
  occurrence: LeaseOccurrence,
  ctx: RecoveryContext,
  fiscalYears: Array<[number, number[]]>,
  sink: RecoverySink,
  recordTrace: boolean,
): void {
  const { recoveries, total, detail } = sink;
  if (pool.method === 'none' || pool.method === 'full_service_gross') return;

  const n = ctx.calendar.periods.length;
  const predicate = includedPredicate(pool);
  const grossUpTarget =
    pool.grossUpPercent !== null && pool.grossUpPercent !== undefined
      ? d(pool.grossUpPercent).clamp(0, 2)
      : null;

  const denominator = pool.proRataShareOverride ? null : ctx.denominatorArea;
  let proRataShare: Decimal;
  if (pool.proRataShareOverride) {
    proRataShare = d(pool.proRataShareOverride);
  } else if (!denominator || denominator.isZero()) {
    ctx.trace.error(
      'RECOVERY_DENOMINATOR_ZERO',
      `Lease ${occurrence.sourceLeaseId} recovers expenses on a pro-rata basis, but the property has no revenue-producing area to divide by. Recovery is treated as zero.`,
      `lease:${occurrence.sourceLeaseId}`,
      'recovery',
    );
    return;
  } else {
    proRataShare = occurrence.area.dividedBy(denominator);
  }

  // Base year defaults to the first fiscal year the model forecasts.
  const firstFiscalYear = fiscalYears[0]?.[0] ?? 0;
  let baseYear = pool.baseYear ?? firstFiscalYear;
  if (pool.method === 'base_year' && !ctx.calendar.periodsByFiscalYear.has(baseYear)) {
    ctx.trace.warn(
      'BASE_YEAR_OUTSIDE_FORECAST',
      `Lease ${occurrence.sourceLeaseId} uses base year ${baseYear}, which is outside the forecast. The first forecast year (${firstFiscalYear}) was used instead.`,
      `lease:${occurrence.sourceLeaseId}`,
      'recovery.baseYear',
    );
    baseYear = firstFiscalYear;
  }

  const basePool =
    pool.method === 'base_year'
      ? poolForYear(
          ctx,
          ctx.calendar.periodsByFiscalYear.get(baseYear) ?? [],
          predicate,
          grossUpTarget,
        )
      : null;

  let priorRecovery: Decimal | null = null;
  let firstRecovery: Decimal | null = null;
  let priorSettled: Decimal | null = null;
  let yearOrdinal = 0;

  for (const [fiscalYear, periodIndices] of fiscalYears) {
    // Months (weighted) the tenant occupied during this fiscal year.
    const occupiedMonths = periodIndices.reduce(
      (acc, index) => acc.plus(series.timeFraction[index] ?? ZERO),
      ZERO,
    );
    if (occupiedMonths.isZero()) continue;
    yearOrdinal += 1;

    const annualPool = poolForYear(ctx, periodIndices, predicate, grossUpTarget);
    const included = ctx.expenses.filter(predicate).map((s) => s.expense.category);

    let entitlement: Decimal;
    let baseYearAmount = ZERO;
    let stopAmount = ZERO;

    switch (pool.method) {
      case 'triple_net':
        entitlement = annualPool.grossedUp.times(proRataShare);
        break;
      case 'base_year': {
        baseYearAmount = (basePool?.grossedUp ?? ZERO).times(proRataShare);
        entitlement = Decimal.max(
          annualPool.grossedUp.times(proRataShare).minus(baseYearAmount),
          ZERO,
        );
        break;
      }
      case 'expense_stop': {
        stopAmount = d(pool.expenseStopPerArea ?? '0').times(occurrence.area);
        entitlement = Decimal.max(annualPool.grossedUp.times(proRataShare).minus(stopAmount), ZERO);
        break;
      }
      case 'fixed_amount': {
        const escalation = ONE.plus(d(pool.fixedEscalationRate));
        entitlement = d(pool.fixedAmount ?? '0').times(escalation.pow(yearOrdinal - 1));
        break;
      }
      default:
        entitlement = ZERO;
    }

    const adminFee = entitlement.times(d(pool.adminFeePercent));
    let withFee = entitlement.plus(adminFee);
    const beforeCaps = withFee;

    // Caps and floors constrain year-over-year movement in the recovered
    // amount. A cumulative cap compounds off the first billed year; a
    // non-cumulative cap resets against the immediately preceding year.
    if (priorRecovery !== null && firstRecovery !== null) {
      if (pool.capPercent !== null && pool.capPercent !== undefined) {
        const cap = d(pool.capPercent);
        const ceiling = pool.capIsCumulative
          ? firstRecovery.times(ONE.plus(cap).pow(yearOrdinal - 1))
          : priorRecovery.times(ONE.plus(cap));
        withFee = Decimal.min(withFee, ceiling);
      }
      if (pool.floorPercent !== null && pool.floorPercent !== undefined) {
        const floor = d(pool.floorPercent);
        const minimum = pool.capIsCumulative
          ? firstRecovery.times(ONE.plus(floor).pow(yearOrdinal - 1))
          : priorRecovery.times(ONE.plus(floor));
        withFee = Decimal.max(withFee, minimum);
      }
    }

    const capAdjustment = withFee.minus(beforeCaps);
    priorRecovery = withFee;
    if (firstRecovery === null) firstRecovery = withFee;

    /*
     * Split the settled year between what is billed monthly and what is
     * reconciled afterwards.
     *
     * `actual` estimates perfectly, so the true-up is zero and the whole year
     * is billed across its own months — which is what this did before
     * reconciliation existed, and why existing models are unaffected.
     */
    let estimated: Decimal;
    switch (pool.estimateBasis) {
      case 'prior_year_actual':
        // The first billed year has no prior year to estimate from. Billing the
        // year itself is the honest fallback: the alternative is inventing a
        // figure, and a zero estimate would defer an entire year of recovery
        // into a single reconciliation month.
        estimated = priorSettled ?? withFee;
        break;
      case 'fixed_estimate':
        estimated = d(pool.estimatePerArea ?? '0').times(occurrence.area);
        break;
      default:
        estimated = withFee;
    }
    priorSettled = withFee;

    const trueUp = withFee.minus(estimated);
    let trueUpPeriodIndex: number | null = null;
    if (!trueUp.isZero()) {
      trueUpPeriodIndex = reconciliationPeriod(periodIndices, pool.reconciliationLagMonths, n);
      if (trueUpPeriodIndex === null) {
        // Dropping it silently would leave the forecast short by a real
        // receivable and nothing on screen to explain the gap.
        ctx.trace.warn(
          'RECONCILIATION_OUTSIDE_FORECAST',
          `Lease ${occurrence.sourceLeaseId} settles FY${fiscalYear} recoveries ${pool.reconciliationLagMonths} month(s) after year end, which is beyond the forecast. A true-up of ${trueUp.toFixed(2)} is not included.`,
          `lease:${occurrence.sourceLeaseId}`,
          'recovery.reconciliation',
        );
      }
    }

    // Spread the estimate over the months actually occupied.
    const annualToPeriod = estimated.dividedBy(TWELVE);
    for (const index of periodIndices) {
      const fraction = series.timeFraction[index] ?? ZERO;
      if (fraction.isZero()) continue;
      const amount = annualToPeriod.times(fraction);
      recoveries[index] = (recoveries[index] as Decimal).plus(amount);
      total[index] = (total[index] as Decimal).plus(amount);
    }

    if (trueUpPeriodIndex !== null) {
      recoveries[trueUpPeriodIndex] = (recoveries[trueUpPeriodIndex] as Decimal).plus(trueUp);
      total[trueUpPeriodIndex] = (total[trueUpPeriodIndex] as Decimal).plus(trueUp);
    }

    detail.push({
      leaseId: occurrence.id,
      fiscalYear,
      poolCode: pool.code,
      poolName: pool.name,
      method: pool.method,
      includedCategories: [...new Set(included)],
      tenantArea: occurrence.area.toString(),
      denominatorArea: (denominator ?? ZERO).toString(),
      proRataShare: proRataShare.toString(),
      grossExpensePool: annualPool.actual.toString(),
      grossedUpExpensePool: annualPool.grossedUp.toString(),
      baseYearAmount: baseYearAmount.toString(),
      expenseStopAmount: stopAmount.toString(),
      recoveryBeforeCaps: beforeCaps.toString(),
      capAdjustment: capAdjustment.toString(),
      adminFee: adminFee.toString(),
      finalRecovery: withFee.toString(),
      estimatedRecovery: estimated.toString(),
      trueUpAmount: trueUp.toString(),
      trueUpPeriodIndex,
    });

    if (recordTrace) {
      ctx.trace.record({
        target: `occurrence:${occurrence.id}:recovery:${pool.code}:${fiscalYear}`,
        formula: `recovery.${pool.method}`,
        description: `FY${fiscalYear} ${pool.name} recovery for ${occurrence.id} under a ${pool.method.replace(/_/g, ' ')} structure, billed over ${occupiedMonths.toFixed(2)} occupied months.`,
        inputs: traceInputs({
          pool: pool.code,
          includedCategories: included.join(', '),
          tenantArea: occurrence.area,
          denominatorArea: denominator ?? ZERO,
          proRataShare,
          annualisedPool: annualPool.actual,
          grossedUpPool: annualPool.grossedUp,
          grossUpTarget: grossUpTarget ?? 'none (actual occupancy)',
          averageOccupancy: annualPool.averageOccupancy,
          baseYearAmount,
          expenseStop: stopAmount,
          adminFeePercent: pool.adminFeePercent,
          adminFee,
          capAdjustment,
          estimateBasis: pool.estimateBasis,
          estimated,
          trueUp,
          trueUpPeriod: trueUpPeriodIndex === null ? 'none' : String(trueUpPeriodIndex + 1),
        }),
        result: withFee.toString(),
        sources: [`lease:${occurrence.sourceLeaseId}`],
      });
    }
  }
}

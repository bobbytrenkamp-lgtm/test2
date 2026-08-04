import type {
  AnnualSummaryRow,
  CashFlowLine,
  CashFlowSeries,
  LeaseCashFlowRow,
  MarketLeasingProfile,
  ModelInput,
  ModelResult,
  OccupancyReconciliation,
  ReturnMetrics,
  ValuationResult,
} from '@cre/domain-models';
import { CASH_FLOW_LINES } from '@cre/domain-models';
import { Decimal, ONE, TWELVE, ZERO, d, zeros } from './decimal.js';
import { buildCalendar, monthDifference } from './calendar.js';
import { CurveSet } from './curves.js';
import {
  type NormalizedSpace,
  type OccurrenceSeries,
  type RolloverContext,
  buildOccurrences,
  buildSpeculativeOccurrences,
  computeOccurrenceSeries,
  marketRentAt,
  normalizeSpaces,
  resolveProfile,
} from './leases.js';
import { monthlyRentFromBasis } from './rent-schedule.js';
import { computeExpenseSeries, totalExpenses } from './expenses.js';
import { computeRecoveries } from './recoveries.js';
import { computeOtherPropertyRevenue, computePercentageRent } from './revenue.js';
import { computeCapital } from './capital.js';
import { computeDebt } from './debt.js';
import { computeDcf, computeDirectCapitalization, computeSale } from './valuation.js';
import {
  breakevenOccupancy,
  equityMultiple,
  irrMonthly,
  npvMonthly,
  safeDivide,
  slice,
  toStringOrNull,
  xirr,
} from './metrics.js';
import { computeSponsorFees, computeWaterfall } from './waterfall.js';
import { TraceRecorder, type TraceOptions } from './trace.js';

/**
 * Calculation engine version.
 *
 * Bump the minor version for additive behaviour and the major version whenever
 * an existing model's numbers would change. Stored results record the version
 * that produced them so a saved valuation can always be explained.
 *
 * ## 2.0.0
 *
 * Lease options now affect the cash flow: renewal, termination and contraction
 * are expanded into probability-weighted branches the way rollover already was.
 * On its own that is additive — a model with no options is unchanged.
 *
 * What makes it major is the occupancy correction it required. Physical
 * occupancy of a space was derived from how much of the *period* an occurrence
 * covered, ignoring how much of the space's *area* it held. A lease taking
 * 6,000 of a 10,000 sqft suite reported the suite fully occupied. Occupancy is
 * now scaled by the occurrence's share of the area it sits on.
 *
 * Every model where a lease covers only part of a space will therefore show
 * different physical occupancy, and different general vacancy and credit loss
 * with it, because those are applied to occupancy. None of the twelve
 * pre-existing regression fixtures moved — they all let whole spaces — but real
 * rent rolls do not, so this is a major bump rather than a minor one.
 */
export const ENGINE_VERSION = '2.0.0';

/** Maximum passes of the revenue/expense fixed-point solver. */
const SOLVER_MAX_PASSES = 12;
/** Convergence threshold, in currency units, for the solver. */
const SOLVER_TOLERANCE = new Decimal('0.005');

export interface CalculateOptions {
  trace?: Partial<TraceOptions>;
  /** Wall-clock stamp recorded on the result. Injected for reproducible tests. */
  calculatedAt?: string;
}

export function calculate(input: ModelInput, options: CalculateOptions = {}): ModelResult {
  const traceOptions: TraceOptions = {
    enabled: options.trace?.enabled ?? false,
    targetPrefixes: options.trace?.targetPrefixes,
    maxEntries: options.trace?.maxEntries ?? 200_000,
  };
  const trace = new TraceRecorder(traceOptions);
  const recordTrace = trace.enabled;

  const calendar = buildCalendar(input.forecast);
  const n = calendar.periods.length;
  const forecastStart = calendar.periods[0]?.start;
  const forecastEnd = calendar.periods[n - 1]?.end;
  if (!forecastStart || !forecastEnd) {
    throw new Error('A forecast must contain at least one period.');
  }

  const curves = new CurveSet(input.growthCurves, calendar);
  const profiles = new Map<string, MarketLeasingProfile>(
    input.marketLeasingProfiles.map((profile) => [profile.id, profile]),
  );

  /* --------------------------------------------------------------------- */
  /* Physical structure and lease occurrences                              */
  /* --------------------------------------------------------------------- */

  const spaces = normalizeSpaces(input.spaces, input.leases, trace);
  const spaceMap = new Map<string, NormalizedSpace>(spaces.map((space) => [space.id, space]));

  const rolloverCtx: RolloverContext = {
    calendar,
    curves,
    profiles,
    defaultProfileId: input.defaultMarketLeasingProfileId ?? null,
    spaces: spaceMap,
    trace,
    forecastStart,
    forecastEnd,
  };

  const occurrences = buildOccurrences(input.leases, rolloverCtx);
  let occurrenceSeries: OccurrenceSeries[] = occurrences.map((occurrence) =>
    computeOccurrenceSeries(occurrence, rolloverCtx, recordTrace),
  );

  detectOverlaps(occurrenceSeries, spaceMap, trace);

  // Space that no lease ever touches is absorbed speculatively on the market
  // leasing assumptions, then rolls over like any other lease.
  const contractOccupancy = accumulateSpaceOccupancy(occurrenceSeries, spaces, n);
  const speculative = buildSpeculativeOccurrences(spaces, contractOccupancy, rolloverCtx);
  if (speculative.length > 0) {
    occurrenceSeries = [
      ...occurrenceSeries,
      ...speculative.map((occurrence) =>
        computeOccurrenceSeries(occurrence, rolloverCtx, recordTrace),
      ),
    ];
  }

  const revenueSpaces = spaces.filter((space) => !space.isNonRevenue);
  const totalRentableArea = revenueSpaces.reduce((acc, space) => acc.plus(space.area), ZERO);
  const declaredArea = input.property.rentableArea ? d(input.property.rentableArea) : null;
  if (declaredArea && !declaredArea.isZero()) {
    const difference = declaredArea.minus(totalRentableArea).abs();
    if (difference.greaterThan(declaredArea.times('0.01'))) {
      trace.warn(
        'AREA_MISMATCH',
        `The property records ${declaredArea.toFixed(0)} ${input.areaUnit} of rentable area, but the space list totals ${totalRentableArea.toFixed(0)}. The space list is used for occupancy and recovery denominators.`,
        `property:${input.property.id}`,
        'rentableArea',
      );
    }
  }
  const unitCount =
    input.property.unitCount > 0
      ? input.property.unitCount
      : revenueSpaces.reduce((acc, space) => acc + space.unitCount, 0);

  /* --------------------------------------------------------------------- */
  /* Occupancy and potential base rent                                     */
  /* --------------------------------------------------------------------- */

  const spaceOccupancy = accumulateSpaceOccupancy(occurrenceSeries, spaces, n);

  const occupiedArea = zeros(n);
  const vacantArea = zeros(n);
  const marketRentOnVacant = zeros(n);

  for (const space of revenueSpaces) {
    const occupancy = spaceOccupancy.get(space.id) ?? zeros(n);
    const profile = resolveProfile(
      rolloverCtx,
      space.marketLeasingProfileId,
      [space.id],
      `space:${space.id}`,
    );
    for (let i = 0; i < n; i += 1) {
      const period = calendar.periods[i];
      if (!period) continue;
      const occupied = (occupancy[i] as Decimal).clamp(0, 1);
      const vacantFraction = ONE.minus(occupied);
      occupiedArea[i] = (occupiedArea[i] as Decimal).plus(space.area.times(occupied));
      vacantArea[i] = (vacantArea[i] as Decimal).plus(space.area.times(vacantFraction));
      if (profile && vacantFraction.greaterThan(0)) {
        const market = marketRentAt(profile, period.start, rolloverCtx);
        const monthly = monthlyRentFromBasis(
          market.amount,
          market.basis,
          space.area.times(vacantFraction),
          Math.round(space.unitCount * vacantFraction.toNumber()),
        );
        marketRentOnVacant[i] = (marketRentOnVacant[i] as Decimal).plus(monthly);
      }
    }
  }

  const physicalOccupancy = occupiedArea.map((area) =>
    totalRentableArea.isZero() ? ONE : area.dividedBy(totalRentableArea),
  );

  const contractualBaseRent = zeros(n);
  const freeRentSeries = zeros(n);
  const otherLeaseRevenue = zeros(n);
  const tenantImprovements = zeros(n);
  const leasingCommissions = zeros(n);
  for (const series of occurrenceSeries) {
    for (let i = 0; i < n; i += 1) {
      contractualBaseRent[i] = (contractualBaseRent[i] as Decimal).plus(series.baseRent[i] ?? ZERO);
      freeRentSeries[i] = (freeRentSeries[i] as Decimal).plus(series.freeRent[i] ?? ZERO);
      otherLeaseRevenue[i] = (otherLeaseRevenue[i] as Decimal).plus(series.otherRevenue[i] ?? ZERO);
      tenantImprovements[i] = (tenantImprovements[i] as Decimal).plus(
        series.tenantImprovements[i] ?? ZERO,
      );
      leasingCommissions[i] = (leasingCommissions[i] as Decimal).plus(
        series.leasingCommissions[i] ?? ZERO,
      );
    }
  }

  const potentialBaseRent = contractualBaseRent.map((rent, i) =>
    rent.plus(marketRentOnVacant[i] as Decimal),
  );
  const absorptionAndTurnoverVacancy = marketRentOnVacant.map((v) => v.negated());
  const scheduledBaseRent = contractualBaseRent.map((rent, i) =>
    rent.minus(freeRentSeries[i] as Decimal),
  );

  const percentageRent = computePercentageRent(
    occurrenceSeries,
    calendar,
    curves,
    trace,
    recordTrace,
  );

  /* --------------------------------------------------------------------- */
  /* Fixed-point solve for revenue-linked expenses and recoveries          */
  /* --------------------------------------------------------------------- */

  let effectiveGrossRevenue = zeros(n);
  let expenseSeries = computeExpenseSeries(
    input.expenses,
    {
      calendar,
      curves,
      trace,
      rentableArea: totalRentableArea,
      unitCount,
      occupancy: physicalOccupancy,
      effectiveGrossRevenue,
      baseRent: scheduledBaseRent,
    },
    false,
  );
  let recoveries = computeRecoveries(
    occurrenceSeries,
    {
      calendar,
      expenses: expenseSeries,
      denominatorArea: totalRentableArea,
      occupancy: physicalOccupancy,
      trace,
    },
    false,
  );
  let otherPropertyRevenue = computeOtherPropertyRevenue(
    input.otherRevenue,
    {
      calendar,
      curves,
      rentableArea: totalRentableArea,
      unitCount,
      occupancy: physicalOccupancy,
      baseRent: scheduledBaseRent,
      trace,
    },
    false,
  );

  let grossPotentialRevenue = zeros(n);
  let generalVacancy = zeros(n);
  let creditLoss = zeros(n);
  let converged = false;

  for (let pass = 0; pass < SOLVER_MAX_PASSES; pass += 1) {
    grossPotentialRevenue = scheduledBaseRent.map((rent, i) =>
      rent
        .plus(percentageRent.total[i] as Decimal)
        .plus(recoveries.total[i] as Decimal)
        .plus(otherLeaseRevenue[i] as Decimal)
        .plus(otherPropertyRevenue.total[i] as Decimal),
    );

    const allowances = computeVacancyAllowances(
      input,
      grossPotentialRevenue,
      scheduledBaseRent,
      recoveries.total,
      percentageRent.total,
      otherLeaseRevenue.map((v, i) => v.plus(otherPropertyRevenue.total[i] as Decimal)),
      absorptionAndTurnoverVacancy,
    );
    generalVacancy = allowances.generalVacancy;
    creditLoss = allowances.creditLoss;

    const nextEgr = grossPotentialRevenue.map((gpr, i) =>
      gpr.minus(generalVacancy[i] as Decimal).minus(creditLoss[i] as Decimal),
    );

    const delta = nextEgr.reduce(
      (acc, value, i) => Decimal.max(acc, value.minus(effectiveGrossRevenue[i] as Decimal).abs()),
      ZERO,
    );
    effectiveGrossRevenue = nextEgr;

    const isFinalPass = delta.lessThan(SOLVER_TOLERANCE);
    expenseSeries = computeExpenseSeries(
      input.expenses,
      {
        calendar,
        curves,
        trace,
        rentableArea: totalRentableArea,
        unitCount,
        occupancy: physicalOccupancy,
        effectiveGrossRevenue,
        baseRent: scheduledBaseRent,
      },
      recordTrace && isFinalPass,
    );
    recoveries = computeRecoveries(
      occurrenceSeries,
      {
        calendar,
        expenses: expenseSeries,
        denominatorArea: totalRentableArea,
        occupancy: physicalOccupancy,
        trace,
      },
      recordTrace && isFinalPass,
    );
    otherPropertyRevenue = computeOtherPropertyRevenue(
      input.otherRevenue,
      {
        calendar,
        curves,
        rentableArea: totalRentableArea,
        unitCount,
        occupancy: physicalOccupancy,
        baseRent: scheduledBaseRent,
        trace,
      },
      recordTrace && isFinalPass,
    );

    if (isFinalPass) {
      converged = true;
      break;
    }
  }

  if (!converged) {
    trace.warn(
      'SOLVER_DID_NOT_CONVERGE',
      `Revenue-linked expenses did not settle within ${SOLVER_MAX_PASSES} passes. Check for an expense defined as a percentage of revenue that is also fully recoverable at a high rate.`,
      'model',
      'expenses',
    );
  }

  // Recompute the revenue lines once more against the final expense pass so the
  // reported figures match the expenses that were actually charged.
  grossPotentialRevenue = scheduledBaseRent.map((rent, i) =>
    rent
      .plus(percentageRent.total[i] as Decimal)
      .plus(recoveries.total[i] as Decimal)
      .plus(otherLeaseRevenue[i] as Decimal)
      .plus(otherPropertyRevenue.total[i] as Decimal),
  );
  const finalAllowances = computeVacancyAllowances(
    input,
    grossPotentialRevenue,
    scheduledBaseRent,
    recoveries.total,
    percentageRent.total,
    otherLeaseRevenue.map((v, i) => v.plus(otherPropertyRevenue.total[i] as Decimal)),
    absorptionAndTurnoverVacancy,
  );
  generalVacancy = finalAllowances.generalVacancy;
  creditLoss = finalAllowances.creditLoss;
  effectiveGrossRevenue = grossPotentialRevenue.map((gpr, i) =>
    gpr.minus(generalVacancy[i] as Decimal).minus(creditLoss[i] as Decimal),
  );

  const operatingExpenses = totalExpenses(expenseSeries, n, false);
  const netOperatingIncome = effectiveGrossRevenue.map((egr, i) =>
    egr.minus(operatingExpenses[i] as Decimal),
  );

  /* --------------------------------------------------------------------- */
  /* Capital and unlevered cash flow                                       */
  /* --------------------------------------------------------------------- */

  const capital = computeCapital(
    input.capital,
    {
      calendar,
      curves,
      rentableArea: totalRentableArea,
      unitCount,
      trace,
    },
    recordTrace,
  );
  const capitalizedExpenses = totalExpenses(expenseSeries, n, true);
  const capitalExpenditures = capital.total.map((value, i) =>
    value.plus(capitalizedExpenses[i] as Decimal),
  );

  const unleveredCashFlow = netOperatingIncome.map((noi, i) =>
    noi
      .minus(tenantImprovements[i] as Decimal)
      .minus(leasingCommissions[i] as Decimal)
      .minus(capitalExpenditures[i] as Decimal),
  );

  /* --------------------------------------------------------------------- */
  /* Valuation                                                             */
  /* --------------------------------------------------------------------- */

  const valuationCtx = {
    calendar,
    assumptions: input.valuation,
    noi: netOperatingIncome,
    unleveredCashFlow,
    rentableArea: totalRentableArea,
    unitCount,
    trace,
  };
  const sale = computeSale(valuationCtx);
  const dcf = computeDcf(valuationCtx, sale);
  const directCap = computeDirectCapitalization(valuationCtx);
  const valuations: ValuationResult[] = [dcf, directCap].filter(
    (value): value is ValuationResult => value !== null,
  );

  const concludedValue = dcf ? d(dcf.value) : directCap ? d(directCap.value) : ZERO;
  const acquisitionBasis = input.valuation.acquisitionPrice
    ? d(input.valuation.acquisitionPrice)
    : concludedValue;
  const acquisitionCosts = d(input.valuation.acquisitionCosts);
  const totalCost = acquisitionBasis
    .plus(acquisitionCosts)
    .plus(capital.total.reduce((acc, v) => acc.plus(v), ZERO));

  /* --------------------------------------------------------------------- */
  /* Debt                                                                  */
  /* --------------------------------------------------------------------- */

  const debt = computeDebt(
    input.debt,
    {
      calendar,
      curves,
      trace,
      noi: netOperatingIncome,
      propertyValue: concludedValue,
      totalCost,
      saleIndex: sale?.saleIndex ?? null,
    },
    recordTrace,
  );

  const grossSaleProceeds = zeros(n);
  const sellingCosts = zeros(n);
  const netDispositionProceeds = zeros(n);
  if (sale) {
    grossSaleProceeds[sale.saleIndex] = sale.grossSalePrice;
    sellingCosts[sale.saleIndex] = sale.sellingCosts;
    netDispositionProceeds[sale.saleIndex] = sale.netSaleProceeds.minus(
      debt.payoff[sale.saleIndex] as Decimal,
    );
  }

  const leveredCashFlow = unleveredCashFlow.map((ucf, i) =>
    ucf
      .plus(debt.proceeds[i] as Decimal)
      .minus(debt.interest[i] as Decimal)
      .minus(debt.principal[i] as Decimal)
      .minus(debt.fees[i] as Decimal)
      .plus(sale && i === sale.saleIndex ? sale.netSaleProceeds : ZERO)
      .minus(debt.payoff[i] as Decimal),
  );

  /* --------------------------------------------------------------------- */
  /* Equity, fees and waterfall                                            */
  /* --------------------------------------------------------------------- */

  const sponsorFees = computeSponsorFees({
    calendar,
    structure: input.equity,
    effectiveGrossRevenue,
    acquisitionBasis,
    grossSalePrice: sale?.grossSalePrice ?? ZERO,
    saleIndex: sale?.saleIndex ?? null,
    trace,
  });

  // The loan funds at closing, so any proceeds landing in the first forecast
  // month reduce the equity written at time zero instead of appearing as a
  // distribution to partners in month one.
  const closingDebt = debt.proceeds[0] ?? ZERO;
  const initialEquity = Decimal.max(
    acquisitionBasis.plus(acquisitionCosts).plus(sponsorFees.atClose).minus(closingDebt),
    ZERO,
  );
  const equityCashFlow = leveredCashFlow.map((cf, i) =>
    i === 0
      ? cf.minus(closingDebt).minus(sponsorFees.total[i] as Decimal)
      : cf.minus(sponsorFees.total[i] as Decimal),
  );

  const waterfall = computeWaterfall({
    calendar,
    structure: input.equity,
    equityCashFlow,
    initialEquity,
    trace,
  });

  /* --------------------------------------------------------------------- */
  /* Assemble output                                                       */
  /* --------------------------------------------------------------------- */

  const monthlyDecimals: Record<CashFlowLine, Decimal[]> = {
    potentialBaseRent,
    absorptionAndTurnoverVacancy,
    contractualBaseRent,
    freeRent: freeRentSeries.map((v) => v.negated()),
    scheduledBaseRent,
    percentageRent: percentageRent.total,
    expenseRecoveries: recoveries.total,
    otherLeaseRevenue,
    otherPropertyRevenue: otherPropertyRevenue.total,
    grossPotentialRevenue,
    generalVacancy: generalVacancy.map((v) => v.negated()),
    creditLoss: creditLoss.map((v) => v.negated()),
    effectiveGrossRevenue,
    operatingExpenses: operatingExpenses.map((v) => v.negated()),
    netOperatingIncome,
    tenantImprovements: tenantImprovements.map((v) => v.negated()),
    leasingCommissions: leasingCommissions.map((v) => v.negated()),
    capitalExpenditures: capitalExpenditures.map((v) => v.negated()),
    unleveredCashFlow,
    debtProceeds: debt.proceeds,
    interestExpense: debt.interest.map((v) => v.negated()),
    principalAmortization: debt.principal.map((v) => v.negated()),
    financingFees: debt.fees.map((v) => v.negated()),
    leveredCashFlow,
    grossSaleProceeds,
    sellingCosts: sellingCosts.map((v) => v.negated()),
    debtPayoff: debt.payoff.map((v) => v.negated()),
    netDispositionProceeds,
    netCashFlow: leveredCashFlow,
  };

  const monthly = {} as CashFlowSeries;
  for (const line of CASH_FLOW_LINES) {
    monthly[line] = monthlyDecimals[line].map((value) => value.toDecimalPlaces(2).toFixed(2));
  }

  const annual: AnnualSummaryRow[] = [...calendar.periodsByFiscalYear.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([fiscalYear, indices]) => {
      const lines = {} as Record<CashFlowLine, string>;
      for (const line of CASH_FLOW_LINES) {
        const series = monthlyDecimals[line];
        const value = indices.reduce((acc, index) => acc.plus(series[index] as Decimal), ZERO);
        lines[line] = value.toDecimalPlaces(2).toFixed(2);
      }
      return { fiscalYear, months: indices.length, lines };
    });

  const occupancy: OccupancyReconciliation[] = calendar.periods.map((period, i) => {
    const occupied = occupiedArea[i] as Decimal;
    const vacant = vacantArea[i] as Decimal;
    const egr = effectiveGrossRevenue[i] as Decimal;
    const potential = (potentialBaseRent[i] as Decimal)
      .plus(recoveries.total[i] as Decimal)
      .plus(percentageRent.total[i] as Decimal)
      .plus(otherLeaseRevenue[i] as Decimal)
      .plus(otherPropertyRevenue.total[i] as Decimal);
    return {
      periodIndex: period.index,
      totalRentableArea: totalRentableArea.toFixed(4),
      occupiedArea: occupied.toFixed(4),
      leasedArea: occupied.toFixed(4),
      availableArea: vacant.toFixed(4),
      physicalVacantArea: vacant.toFixed(4),
      physicalOccupancyPercent: (physicalOccupancy[i] as Decimal).toFixed(8),
      economicOccupancyPercent: potential.isZero()
        ? '0.00000000'
        : egr.dividedBy(potential).toFixed(8),
    };
  });

  const tenantNames = new Map(input.tenants.map((tenant) => [tenant.id, tenant.name]));
  const leaseCashFlows: LeaseCashFlowRow[] = occurrenceSeries.map((series) => ({
    leaseId: series.occurrence.id,
    tenantId: series.occurrence.tenantId,
    tenantName: tenantNames.get(series.occurrence.tenantId) ?? series.occurrence.tenantName,
    ...(series.occurrence.scenario === 'contract'
      ? {}
      : { rolloverOf: series.occurrence.sourceLeaseId }),
    scenario: series.occurrence.scenario,
    baseRent: series.baseRent.map((v) => v.toFixed(2)),
    freeRent: series.freeRent.map((v) => v.negated().toFixed(2)),
    percentageRent: (percentageRent.byOccurrence.get(series.occurrence.id) ?? zeros(n)).map((v) =>
      v.toFixed(2),
    ),
    recoveries: (recoveries.byOccurrence.get(series.occurrence.id) ?? zeros(n)).map((v) =>
      v.toFixed(2),
    ),
    otherRevenue: series.otherRevenue.map((v) => v.toFixed(2)),
    tenantImprovements: series.tenantImprovements.map((v) => v.negated().toFixed(2)),
    leasingCommissions: series.leasingCommissions.map((v) => v.negated().toFixed(2)),
    occupiedArea: series.occupiedArea.map((v) => v.toFixed(4)),
  }));

  const returns = computeReturns({
    input,
    calendar,
    unleveredCashFlow,
    leveredCashFlow,
    netOperatingIncome,
    grossPotentialRevenue,
    operatingExpenses,
    effectiveGrossRevenue,
    debt,
    sale,
    concludedValue,
    acquisitionBasis,
    acquisitionCosts,
    totalCost,
    initialEquity,
    closingDebt,
    totalRentableArea,
    unitCount,
    physicalOccupancy,
  });

  validateModel(input, trace, {
    totalRentableArea,
    physicalOccupancy,
    concludedValue,
  });

  return {
    engineVersion: ENGINE_VERSION,
    modelId: input.modelId,
    calculatedAt: options.calculatedAt ?? new Date().toISOString(),
    currency: input.currency,
    areaUnit: input.areaUnit,
    periods: calendar.periods.map(({ start: _s, end: _e, ...meta }) => meta),
    monthly,
    annual,
    occupancy,
    leaseCashFlows,
    recoveryDetail: recoveries.detail,
    debtSchedules: debt.schedules,
    valuations,
    returns,
    waterfall,
    diagnostics: trace.getDiagnostics(),
    trace: trace.getTrace(),
  };
}

/* -------------------------------------------------------------------------- */
/* Vacancy allowances                                                        */
/* -------------------------------------------------------------------------- */

/**
 * General vacancy and credit loss.
 *
 * Absorption and turnover vacancy is already deducted lease-by-lease when a
 * space rolls or sits empty. Applying a general vacancy allowance on top of
 * that would deduct the same vacancy twice, so by default the general allowance
 * is reduced by the vacancy the lease-level forecast already captured, and only
 * the shortfall against the target rate is charged.
 */
function computeVacancyAllowances(
  input: ModelInput,
  grossPotentialRevenue: Decimal[],
  scheduledBaseRent: Decimal[],
  recoveries: Decimal[],
  percentageRent: Decimal[],
  otherRevenue: Decimal[],
  absorptionAndTurnoverVacancy: Decimal[],
): { generalVacancy: Decimal[]; creditLoss: Decimal[] } {
  const n = grossPotentialRevenue.length;
  const rate = d(input.vacancy.generalVacancyRate);
  const creditRate = d(input.vacancy.creditLossRate);
  const appliesTo = new Set(input.vacancy.appliesTo);

  const generalVacancy = zeros(n);
  const creditLoss = zeros(n);

  for (let i = 0; i < n; i += 1) {
    let base = ZERO;
    if (appliesTo.has('base_rent')) base = base.plus(scheduledBaseRent[i] as Decimal);
    if (appliesTo.has('recoveries')) base = base.plus(recoveries[i] as Decimal);
    if (appliesTo.has('percentage_rent')) base = base.plus(percentageRent[i] as Decimal);
    if (appliesTo.has('other_revenue')) base = base.plus(otherRevenue[i] as Decimal);

    const target = base.times(rate);
    const alreadyModelled = (absorptionAndTurnoverVacancy[i] as Decimal).negated();
    generalVacancy[i] = input.vacancy.netAgainstModelledVacancy
      ? Decimal.max(target.minus(alreadyModelled), ZERO)
      : target;
    creditLoss[i] = base.times(creditRate);
  }

  return { generalVacancy, creditLoss };
}

/* -------------------------------------------------------------------------- */
/* Returns                                                                   */
/* -------------------------------------------------------------------------- */

interface ReturnsContext {
  input: ModelInput;
  calendar: ReturnType<typeof buildCalendar>;
  unleveredCashFlow: Decimal[];
  leveredCashFlow: Decimal[];
  netOperatingIncome: Decimal[];
  grossPotentialRevenue: Decimal[];
  operatingExpenses: Decimal[];
  effectiveGrossRevenue: Decimal[];
  debt: ReturnType<typeof computeDebt>;
  sale: ReturnType<typeof computeSale>;
  concludedValue: Decimal;
  acquisitionBasis: Decimal;
  acquisitionCosts: Decimal;
  totalCost: Decimal;
  initialEquity: Decimal;
  closingDebt: Decimal;
  totalRentableArea: Decimal;
  unitCount: number;
  physicalOccupancy: Decimal[];
}

function computeReturns(ctx: ReturnsContext): ReturnMetrics {
  const {
    input,
    calendar,
    unleveredCashFlow,
    leveredCashFlow,
    netOperatingIncome,
    debt,
    sale,
    concludedValue,
    acquisitionBasis,
    acquisitionCosts,
    totalCost,
    initialEquity,
    closingDebt,
    totalRentableArea,
    unitCount,
  } = ctx;

  const saleIndex = sale?.saleIndex ?? calendar.periods.length - 1;
  const horizon = saleIndex + 1;
  const initialOutflow = acquisitionBasis.plus(acquisitionCosts).negated();

  const unleveredFlows = unleveredCashFlow
    .slice(0, horizon)
    .map((cf, i) => (sale && i === sale.saleIndex ? cf.plus(sale.netSaleProceeds) : cf));
  const leveredFlows = leveredCashFlow
    .slice(0, horizon)
    .map((cf, i) => (i === 0 ? cf.minus(closingDebt) : cf));

  const unleveredIrr = irrMonthly(unleveredFlows, initialOutflow);
  const leveredIrr = irrMonthly(leveredFlows, initialEquity.negated());

  const datedUnlevered = [
    {
      date: calendar.periods[0]?.start ?? { year: 2000, month: 1, day: 1 },
      amount: initialOutflow,
    },
    ...unleveredFlows.map((amount, i) => ({
      date: calendar.periods[i]?.end ?? { year: 2000, month: 1, day: 1 },
      amount,
    })),
  ];
  const datedLevered = [
    {
      date: calendar.periods[0]?.start ?? { year: 2000, month: 1, day: 1 },
      amount: initialEquity.negated(),
    },
    ...leveredFlows.map((amount, i) => ({
      date: calendar.periods[i]?.end ?? { year: 2000, month: 1, day: 1 },
      amount,
    })),
  ];

  const year1Noi = slice(netOperatingIncome, 0, Math.min(12, netOperatingIncome.length));
  const goingInCap = safeDivide(year1Noi, acquisitionBasis);
  const yieldOnCost = safeDivide(year1Noi, totalCost);

  const dscrValues: Decimal[] = [];
  for (const schedule of debt.schedules) {
    for (const row of schedule.rows) {
      if (row.dscr !== null) dscrValues.push(d(row.dscr));
    }
  }

  const cashOnCashByYear = [...calendar.periodsByFiscalYear.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([fiscalYear, indices]) => {
      const operating = indices
        .filter((index) => index !== saleIndex)
        .reduce((acc, index) => acc.plus(leveredCashFlow[index] ?? ZERO), ZERO);
      return {
        fiscalYear,
        value: initialEquity.isZero() ? '0' : operating.dividedBy(initialEquity).toString(),
      };
    });

  const year1Gpr = slice(ctx.grossPotentialRevenue, 0, 12);
  const year1Opex = slice(ctx.operatingExpenses, 0, 12);
  const year1DebtService = slice(debt.interest, 0, 12).plus(slice(debt.principal, 0, 12));

  const debtBalanceYear1 = debt.endingBalance[Math.min(11, debt.endingBalance.length - 1)] ?? ZERO;

  return {
    unleveredIrr: toStringOrNull(unleveredIrr),
    leveredIrr: toStringOrNull(leveredIrr),
    unleveredXirr: toStringOrNull(xirr(datedUnlevered)),
    leveredXirr: toStringOrNull(xirr(datedLevered)),
    equityMultiple: toStringOrNull(equityMultiple([initialEquity.negated(), ...leveredFlows])),
    netPresentValue: npvMonthly(
      unleveredFlows,
      d(input.valuation.discountRate),
      input.valuation.discountingConvention,
      initialOutflow,
    ).toString(),
    profit: unleveredFlows.reduce((acc, v) => acc.plus(v), initialOutflow).toString(),
    goingInCapRate: toStringOrNull(goingInCap),
    stabilizedCapRate: toStringOrNull(
      safeDivide(slice(netOperatingIncome, 12, 24), acquisitionBasis),
    ),
    exitCapRate: input.valuation.terminalCapRate ?? null,
    yieldOnCost: toStringOrNull(yieldOnCost),
    cashOnCashByYear,
    averageDscr:
      dscrValues.length === 0
        ? null
        : dscrValues
            .reduce((acc, v) => acc.plus(v), ZERO)
            .dividedBy(dscrValues.length)
            .toString(),
    minimumDscr:
      dscrValues.length === 0
        ? null
        : dscrValues.reduce((acc, v) => (v.lessThan(acc) ? v : acc)).toString(),
    debtYieldYear1: toStringOrNull(safeDivide(year1Noi, debtBalanceYear1)),
    loanToValue: toStringOrNull(safeDivide(closingDebt, concludedValue)),
    loanToCost: toStringOrNull(safeDivide(closingDebt, totalCost)),
    breakevenOccupancy: toStringOrNull(breakevenOccupancy(year1Gpr, year1Opex, year1DebtService)),
    valuePerArea: toStringOrNull(safeDivide(concludedValue, totalRentableArea)),
    valuePerUnit: unitCount === 0 ? null : concludedValue.dividedBy(unitCount).toString(),
  };
}

/* -------------------------------------------------------------------------- */
/* Validation                                                                */
/* -------------------------------------------------------------------------- */

/** Occupancy fraction per space per period, summed across occurrences. */
function accumulateSpaceOccupancy(
  series: OccurrenceSeries[],
  spaces: NormalizedSpace[],
  periods: number,
): Map<string, Decimal[]> {
  const occupancy = new Map<string, Decimal[]>(spaces.map((space) => [space.id, zeros(periods)]));
  for (const entry of series) {
    for (const spaceId of entry.occurrence.spaceIds) {
      const target = occupancy.get(spaceId);
      if (!target) continue;
      for (let i = 0; i < periods; i += 1) {
        target[i] = (target[i] as Decimal).plus(entry.occupancyFraction[i] ?? ZERO);
      }
    }
  }
  return occupancy;
}

function detectOverlaps(
  series: OccurrenceSeries[],
  spaces: Map<string, NormalizedSpace>,
  trace: TraceRecorder,
): void {
  const bySpace = new Map<string, OccurrenceSeries[]>();
  for (const entry of series) {
    if (entry.occurrence.scenario !== 'contract') continue;
    for (const spaceId of entry.occurrence.spaceIds) {
      const bucket = bySpace.get(spaceId);
      if (bucket) bucket.push(entry);
      else bySpace.set(spaceId, [entry]);
    }
  }

  for (const [spaceId, entries] of bySpace) {
    if (entries.length < 2) continue;
    const periods = entries[0]?.occupancyFraction.length ?? 0;
    for (let i = 0; i < periods; i += 1) {
      const total = entries.reduce(
        (acc, entry) => acc.plus(entry.occupancyFraction[i] ?? ZERO),
        ZERO,
      );
      if (total.greaterThan('1.0001')) {
        trace.error(
          'SPACE_DOUBLE_LET',
          `Space ${spaces.get(spaceId)?.code ?? spaceId} is let to more than one tenant in forecast month ${i + 1}. Overlapping lease terms inflate both occupancy and revenue.`,
          `space:${spaceId}`,
          'leases',
        );
        break;
      }
    }
  }
}

function validateModel(
  input: ModelInput,
  trace: TraceRecorder,
  context: { totalRentableArea: Decimal; physicalOccupancy: Decimal[]; concludedValue: Decimal },
): void {
  if (context.totalRentableArea.isZero() && input.leases.length > 0) {
    trace.error(
      'NO_RENTABLE_AREA',
      'The model has leases but no rentable area, so per-area rents and recovery denominators cannot be computed.',
      `property:${input.property.id}`,
      'rentableArea',
    );
  }
  for (const [index, occupancy] of context.physicalOccupancy.entries()) {
    if (occupancy.greaterThan('1.0001')) {
      trace.error(
        'OCCUPANCY_ABOVE_100',
        `Physical occupancy exceeds 100% in forecast month ${index + 1}. Check for overlapping leases or lease areas larger than their spaces.`,
        `property:${input.property.id}`,
        'occupancy',
      );
      break;
    }
    if (occupancy.lessThan(0)) {
      trace.error(
        'NEGATIVE_OCCUPANCY',
        `Physical occupancy is negative in forecast month ${index + 1}.`,
        `property:${input.property.id}`,
        'occupancy',
      );
      break;
    }
  }
  if (!input.valuation.discountRate || d(input.valuation.discountRate).isZero()) {
    trace.warn(
      'ZERO_DISCOUNT_RATE',
      'The discount rate is zero, so the discounted cash-flow value is an undiscounted sum of future cash flows.',
      'valuation',
      'discountRate',
    );
  }
  for (const lease of input.leases) {
    if (d(lease.area).isZero() && lease.status !== 'vacant') {
      trace.warn(
        'LEASE_MISSING_AREA',
        `Lease ${lease.id} has no area. Per-area rent, recoveries and occupancy will all be zero for it.`,
        `lease:${lease.id}`,
        'area',
      );
    }
  }
  const currencies = new Set([input.currency]);
  if (currencies.size > 1) {
    trace.error('MULTIPLE_CURRENCIES', 'A model cannot mix currencies.', 'model', 'currency');
  }
}

export { monthDifference, TWELVE, ONE };

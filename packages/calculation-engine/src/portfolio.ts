import type { ModelResult } from '@cre/domain-models';
import { Decimal, ONE, TWELVE, ZERO, d, zeros } from './decimal.js';
import { equityMultiple, irrMonthly, safeDivide, toStringOrNull } from './metrics.js';

/**
 * Portfolio aggregation.
 *
 * Two rules govern everything here.
 *
 * First, a rate is never averaged as if it were an amount. A capitalisation
 * rate, discount rate or occupancy is aggregated by rebuilding it from its own
 * numerator and denominator across the portfolio, which is the only way the
 * portfolio figure remains the rate the portfolio actually earns.
 *
 * Second, a portfolio internal rate of return is solved from combined
 * portfolio-level cash flows, never averaged from property-level returns.
 * Averaging returns is wrong whenever the assets differ in size or timing,
 * which they always do.
 */

export interface PortfolioMember {
  propertyId: string;
  propertyName: string;
  propertyType: string;
  market: string | null;
  /** Share of the asset the portfolio owns, "0".."1". */
  ownershipPercent: string;
  rentableArea: string | null;
  unitCount: number;
  result: ModelResult;
}

export interface PortfolioAggregate {
  propertyCount: number;
  /** Ownership-weighted totals. */
  grossAssetValue: string;
  netAssetValue: string;
  totalDebt: string;
  totalRentableArea: string;
  totalUnits: string;
  year1NetOperatingIncome: string;
  year1CapitalExpenditure: string;
  /** Rebuilt from portfolio numerators and denominators, not averaged. */
  weightedGoingInCapRate: string | null;
  weightedDiscountRate: string | null;
  weightedExitCapRate: string | null;
  physicalOccupancy: string | null;
  loanToValue: string | null;
  /** Solved from combined portfolio cash flows. */
  portfolioUnleveredIrr: string | null;
  portfolioLeveredIrr: string | null;
  portfolioEquityMultiple: string | null;
  /** Longest forecast among the members, in months. */
  horizonMonths: number;
  byPropertyType: Array<{ key: string; value: string; share: string }>;
  byMarket: Array<{ key: string; value: string; share: string }>;
  /**
   * A quick top-20 glance, keyed by name and folded into every roll-up
   * automatically. For the full picture — a tenant matched by id rather than
   * name (so two tenants that happen to share a name are not merged), each
   * property they occupy, lease count, credit profile and earliest
   * expiration — see `GET /portfolios/:id/tenant-exposure` in
   * `apps/api/src/routes/portfolios.ts`, computed on request rather than
   * folded into every aggregate.
   */
  tenantConcentration: Array<{ tenantName: string; annualRent: string; share: string }>;
  leaseExpirationByYear: Array<{ fiscalYear: number; expiringArea: string; expiringRent: string }>;
  debtMaturityByYear: Array<{ fiscalYear: number; balance: string }>;
}

function dcfValue(result: ModelResult): Decimal {
  const dcf = result.valuations.find((valuation) => valuation.method === 'dcf');
  if (dcf) return d(dcf.value);
  const direct = result.valuations.find(
    (valuation) => valuation.method === 'direct_capitalization',
  );
  return direct ? d(direct.value) : ZERO;
}

function annualLine(
  result: ModelResult,
  index: number,
  line: keyof ModelResult['annual'][number]['lines'],
): Decimal {
  return d(result.annual[index]?.lines[line] ?? '0');
}

/**
 * A model's first fiscal-year NOI, annualised when that year is a partial
 * one.
 *
 * `AnnualSummaryRow.months` is "12 except at the ends" — and a forecast that
 * does not start on the fiscal year's own first month (a calendar-fiscal-year
 * fund with a mid-year acquisition is the ordinary case, not an edge one) has
 * a partial first bucket. Reading it as "year 1 NOI" unannualised understated
 * both the reported figure and the going-in cap rate built from it by however
 * much of the year the forecast missed.
 */
function annualizedYear1Noi(result: ModelResult): Decimal {
  const row = result.annual[0];
  const value = d(row?.lines.netOperatingIncome ?? '0');
  const months = row?.months ?? 0;
  if (months > 0 && months < 12) return value.times(TWELVE).dividedBy(months);
  return value;
}

export function aggregatePortfolio(members: PortfolioMember[]): PortfolioAggregate {
  const horizonMonths = members.reduce(
    (acc, member) => Math.max(acc, member.result.periods.length),
    0,
  );

  let grossAssetValue = ZERO;
  let totalDebt = ZERO;
  let totalArea = ZERO;
  let totalUnits = ZERO;
  let year1Noi = ZERO;
  let year1Capex = ZERO;
  let occupiedArea = ZERO;
  let discountRateWeighted = ZERO;
  let exitCapWeighted = ZERO;
  let valueWeightBasis = ZERO;

  const unleveredFlows = zeros(horizonMonths);
  const leveredFlows = zeros(horizonMonths);
  let initialUnlevered = ZERO;
  let initialEquity = ZERO;

  const byType = new Map<string, Decimal>();
  const byMarket = new Map<string, Decimal>();
  const tenantRent = new Map<string, Decimal>();
  const expirations = new Map<number, { area: Decimal; rent: Decimal }>();
  const debtMaturity = new Map<string, Decimal>();

  for (const member of members) {
    const share = d(member.ownershipPercent).clamp(0, 1);
    const result = member.result;
    const value = dcfValue(result).times(share);
    grossAssetValue = grossAssetValue.plus(value);

    const debtAtStart = result.debtSchedules.reduce(
      (acc, schedule) => acc.plus(d(schedule.rows[0]?.endingBalance ?? '0')),
      ZERO,
    );
    totalDebt = totalDebt.plus(debtAtStart.times(share));

    const area = d(member.rentableArea ?? '0');
    totalArea = totalArea.plus(area.times(share));
    totalUnits = totalUnits.plus(d(member.unitCount).times(share));

    year1Noi = year1Noi.plus(annualizedYear1Noi(result).times(share));
    year1Capex = year1Capex.plus(annualLine(result, 0, 'capitalExpenditures').abs().times(share));

    const occupancy = d(result.occupancy[0]?.physicalOccupancyPercent ?? '0');
    occupiedArea = occupiedArea.plus(area.times(occupancy).times(share));

    // Rates are weighted by value so the portfolio rate reflects where the
    // capital actually is.
    const dcf = result.valuations.find((valuation) => valuation.method === 'dcf');
    if (dcf) {
      discountRateWeighted = discountRateWeighted.plus(
        d(dcf.detail.discountRate ?? '0').times(value),
      );
      valueWeightBasis = valueWeightBasis.plus(value);
    }
    // Gated on the same `dcf` presence as `valueWeightBasis` above: `exitCapRate`
    // is copied from the input assumption regardless of whether a terminal
    // value was actually computed (`computeSale` can fail for reasons unrelated
    // to the rate itself, e.g. a sale month outside the forecast), so weighting
    // it in without that gate would count a member's rate against a value
    // basis that never included that member's own value.
    if (dcf && result.returns.exitCapRate) {
      exitCapWeighted = exitCapWeighted.plus(d(result.returns.exitCapRate).times(value));
    }

    // Cash flows combine at ownership share and are padded to the longest
    // horizon so a shorter hold does not shift a longer one's timing.
    for (let i = 0; i < horizonMonths; i += 1) {
      const unlevered = d(result.monthly.unleveredCashFlow[i] ?? '0')
        .plus(d(result.monthly.netDispositionProceeds[i] ?? '0'))
        .times(share);
      unleveredFlows[i] = (unleveredFlows[i] as Decimal).plus(unlevered);
      leveredFlows[i] = (leveredFlows[i] as Decimal).plus(
        d(result.monthly.leveredCashFlow[i] ?? '0').times(share),
      );
    }
    const basis = d(result.returns.valuePerArea ?? '0').times(area);
    initialUnlevered = initialUnlevered.minus((dcf ? dcfValue(result) : basis).times(share));
    initialEquity = initialEquity.minus(dcfValue(result).minus(debtAtStart).times(share));

    accumulate(byType, member.propertyType, value);
    accumulate(byMarket, member.market ?? 'Unassigned', value);

    for (const lease of result.leaseCashFlows) {
      if (lease.scenario !== 'contract') continue;
      const annualRent = lease.baseRent
        .slice(0, 12)
        .reduce((acc, entry) => acc.plus(d(entry)), ZERO)
        .times(share);
      accumulate(tenantRent, lease.tenantName, annualRent);
    }

    // Expiry exposure is read from the point each contract lease's occupied
    // area drops to zero within the forecast.
    for (const lease of result.leaseCashFlows) {
      if (lease.scenario !== 'contract') continue;
      const lastOccupied = lastIndexWhere(lease.occupiedArea, (entry) => Number(entry) > 0);
      if (lastOccupied < 0 || lastOccupied >= result.periods.length - 1) continue;
      const fiscalYear = result.periods[lastOccupied]?.fiscalYear;
      if (fiscalYear === undefined) continue;
      const bucket = expirations.get(fiscalYear) ?? { area: ZERO, rent: ZERO };
      bucket.area = bucket.area.plus(d(lease.occupiedArea[lastOccupied] ?? '0').times(share));
      bucket.rent = bucket.rent.plus(
        lease.baseRent
          .slice(Math.max(0, lastOccupied - 11), lastOccupied + 1)
          .reduce((acc, entry) => acc.plus(d(entry)), ZERO)
          .times(share),
      );
      expirations.set(fiscalYear, bucket);
    }

    for (const schedule of result.debtSchedules) {
      const lastActive = lastIndexWhere(schedule.rows, (row) => Number(row.endingBalance) > 0);
      if (lastActive < 0) continue;
      const fiscalYear = result.periods[lastActive]?.fiscalYear;
      if (fiscalYear === undefined) continue;
      accumulate(
        debtMaturity,
        String(fiscalYear),
        d(schedule.rows[lastActive]?.endingBalance ?? '0').times(share),
      );
    }
  }

  const netAssetValue = grossAssetValue.minus(totalDebt);

  return {
    propertyCount: members.length,
    grossAssetValue: grossAssetValue.toFixed(2),
    netAssetValue: netAssetValue.toFixed(2),
    totalDebt: totalDebt.toFixed(2),
    totalRentableArea: totalArea.toFixed(4),
    totalUnits: totalUnits.toFixed(0),
    year1NetOperatingIncome: year1Noi.toFixed(2),
    year1CapitalExpenditure: year1Capex.toFixed(2),
    weightedGoingInCapRate: toStringOrNull(safeDivide(year1Noi, grossAssetValue)),
    weightedDiscountRate: toStringOrNull(safeDivide(discountRateWeighted, valueWeightBasis)),
    weightedExitCapRate: toStringOrNull(safeDivide(exitCapWeighted, valueWeightBasis)),
    physicalOccupancy: toStringOrNull(safeDivide(occupiedArea, totalArea)),
    loanToValue: toStringOrNull(safeDivide(totalDebt, grossAssetValue)),
    portfolioUnleveredIrr: toStringOrNull(irrMonthly(unleveredFlows, initialUnlevered)),
    portfolioLeveredIrr: toStringOrNull(irrMonthly(leveredFlows, initialEquity)),
    portfolioEquityMultiple: toStringOrNull(equityMultiple([initialEquity, ...leveredFlows])),
    horizonMonths,
    byPropertyType: shares(byType, grossAssetValue),
    byMarket: shares(byMarket, grossAssetValue),
    tenantConcentration: shares(tenantRent, sumMap(tenantRent))
      .sort((a, b) => Number(b.value) - Number(a.value))
      .slice(0, 20)
      .map((entry) => ({ tenantName: entry.key, annualRent: entry.value, share: entry.share })),
    leaseExpirationByYear: [...expirations.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([fiscalYear, bucket]) => ({
        fiscalYear,
        expiringArea: bucket.area.toFixed(4),
        expiringRent: bucket.rent.toFixed(2),
      })),
    debtMaturityByYear: [...debtMaturity.entries()]
      .sort((a, b) => Number(a[0]) - Number(b[0]))
      .map(([fiscalYear, balance]) => ({
        fiscalYear: Number(fiscalYear),
        balance: balance.toFixed(2),
      })),
  };
}

/** Index of the last element satisfying the predicate, or -1. */
function lastIndexWhere<T>(values: readonly T[], predicate: (value: T) => boolean): number {
  for (let i = values.length - 1; i >= 0; i -= 1) {
    if (predicate(values[i] as T)) return i;
  }
  return -1;
}

function accumulate(map: Map<string, Decimal>, key: string, value: Decimal): void {
  map.set(key, (map.get(key) ?? ZERO).plus(value));
}

function sumMap(map: Map<string, Decimal>): Decimal {
  let total = ZERO;
  for (const value of map.values()) total = total.plus(value);
  return total;
}

function shares(
  map: Map<string, Decimal>,
  total: Decimal,
): Array<{ key: string; value: string; share: string }> {
  return [...map.entries()]
    .sort((a, b) => b[1].comparedTo(a[1]))
    .map(([key, value]) => ({
      key,
      value: value.toFixed(2),
      share: total.isZero() ? '0' : value.dividedBy(total).toFixed(8),
    }));
}

export { ONE };

import { Decimal, ONE, ZERO, d } from './decimal.js';

/**
 * The cost approach: land value plus the depreciated replacement cost of
 * the improvements on it.
 *
 * The third leg of the appraisal triangle, alongside the income approach
 * (`computeDcf`, `computeDirectCapitalization`) and the sales comparison
 * approach (`sales-comparison.ts`) — most persuasive for new or
 * special-purpose improvements where comparable sales are thin and the
 * subject's own income is not yet stabilized, the exact case the other two
 * approaches are weakest for. A standalone calculator, the same shape as
 * its two siblings: it takes assumptions the engine's forecast does not
 * model (replacement cost, accrued depreciation) and its result is meant to
 * be read, not fed back into `calculate()`.
 */

export interface CostApproachImprovement {
  id: string;
  description?: string | null;
  /** Replacement or reproduction cost new, before any depreciation. */
  replacementCostNew: string;
  /** Physical deterioration, as a decimal fraction of replacementCostNew ("0.10" = 10% depreciated). */
  physicalDeterioration?: string | null;
  /** Functional obsolescence — outdated layout, systems, or design — same basis. */
  functionalObsolescence?: string | null;
  /** External (economic) obsolescence — caused by factors off the site — same basis. */
  externalObsolescence?: string | null;
}

export interface CostApproachInput {
  /** Land value, as if vacant and available for its highest and best use. */
  landValue: string;
  improvements: CostApproachImprovement[];
  /**
   * Entrepreneurial profit/incentive a developer would require to undertake
   * the project, as a decimal fraction of total replacement cost new.
   * Omitted or zero when the improvements are existing rather than newly
   * built, the usual case for underwriting an acquisition.
   */
  entrepreneurialProfitPercent?: string | null;
}

export interface CostApproachImprovementResult {
  id: string;
  replacementCostNew: string;
  /**
   * The sum of every depreciation component supplied, clamped to [0, 1] —
   * accrued depreciation cannot sensibly exceed the cost it is subtracted
   * from, or go negative and inflate it.
   */
  totalDepreciationPercent: string;
  depreciatedCost: string;
}

export interface CostApproachResult {
  landValue: string;
  improvements: CostApproachImprovementResult[];
  totalReplacementCostNew: string;
  entrepreneurialProfit: string;
  totalDepreciatedCost: string;
  /** landValue + totalDepreciatedCost + entrepreneurialProfit. */
  indicatedValue: string;
}

function sumDepreciation(improvement: CostApproachImprovement): Decimal {
  const raw = [
    improvement.physicalDeterioration,
    improvement.functionalObsolescence,
    improvement.externalObsolescence,
  ].reduce((total: Decimal, value) => (value ? total.plus(d(value)) : total), ZERO);
  return Decimal.max(ZERO, Decimal.min(ONE, raw));
}

export function computeCostApproach(input: CostApproachInput): CostApproachResult {
  const landValue = d(input.landValue);
  if (landValue.lessThan(0)) {
    throw new Error('landValue cannot be negative.');
  }

  const improvements: CostApproachImprovementResult[] = input.improvements.map((improvement) => {
    const replacementCostNew = d(improvement.replacementCostNew);
    if (replacementCostNew.lessThan(0)) {
      throw new Error(`Improvement "${improvement.id}": replacementCostNew cannot be negative.`);
    }
    const totalDepreciationPercent = sumDepreciation(improvement);
    const depreciatedCost = replacementCostNew.times(ONE.minus(totalDepreciationPercent));
    return {
      id: improvement.id,
      replacementCostNew: replacementCostNew.toString(),
      totalDepreciationPercent: totalDepreciationPercent.toString(),
      depreciatedCost: depreciatedCost.toString(),
    };
  });

  const totalReplacementCostNew = improvements.reduce(
    (total, improvement) => total.plus(d(improvement.replacementCostNew)),
    ZERO,
  );
  const totalDepreciatedCost = improvements.reduce(
    (total, improvement) => total.plus(d(improvement.depreciatedCost)),
    ZERO,
  );
  const entrepreneurialProfit = input.entrepreneurialProfitPercent
    ? totalReplacementCostNew.times(d(input.entrepreneurialProfitPercent))
    : ZERO;

  return {
    landValue: landValue.toString(),
    improvements,
    totalReplacementCostNew: totalReplacementCostNew.toString(),
    entrepreneurialProfit: entrepreneurialProfit.toString(),
    totalDepreciatedCost: totalDepreciatedCost.toString(),
    indicatedValue: landValue.plus(totalDepreciatedCost).plus(entrepreneurialProfit).toString(),
  };
}

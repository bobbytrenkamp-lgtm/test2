import { Decimal, ZERO, d } from './decimal.js';

/**
 * The sales comparison approach: an indicated value built from what
 * comparable properties actually sold for, adjusted for how each one
 * differs from the subject, and reconciled to a single per-unit conclusion.
 *
 * The income approach (`computeDcf`, `computeDirectCapitalization`) is the
 * primary basis for an investment-grade valuation everywhere else in this
 * engine. Appraisal practice — and Argus Enterprise's own Sales Comparison
 * worksheet — treats this as an independent second approach, not a
 * refinement of the first: two methods starting from different evidence
 * (the subject's own income versus what the market actually paid for
 * similar assets) that should be read side by side, not blended into one
 * number. Deliberately a standalone calculator, the same shape as
 * `debt-sizing.ts` and `straight-line-rent.ts` — it takes assumptions the
 * engine's forecast does not model (comparable transactions) and its result
 * is meant to be read, not fed back into `calculate()`.
 */

export interface ComparableSaleAdjustments {
  /** Time/market-conditions adjustment between the comp's sale date and today, as a decimal fraction ("0.03" = +3%). */
  marketConditions?: string | null;
  /** Adjustment for a locational difference from the subject. */
  location?: string | null;
  /** Adjustment for physical characteristics — age, construction quality, parking, etc. */
  physicalCharacteristics?: string | null;
  /** Adjustment for condition or finish quality. */
  conditionQuality?: string | null;
  /** Any adjustment not covered above (financing terms, expenditures after sale, etc.). */
  other?: string | null;
}

export interface ComparableSale {
  id: string;
  /** Total transaction price. */
  salePrice: string;
  /** The unit the comparison is made on — rentable square feet, units, beds, keys — matching the subject's own basis. */
  unitsOfComparison: string;
  adjustments: ComparableSaleAdjustments;
  /** Relative weight in reconciliation. Defaults to equal weighting when omitted. */
  weight?: string | null;
}

export interface SalesComparisonInput {
  /** The subject's own size in the same unit the comparables are priced on. */
  subjectUnitsOfComparison: string;
  comparables: ComparableSale[];
  /** How the adjusted comparables are reconciled to one indicated value per unit. Defaults to a weighted average. */
  reconciliation?: 'weighted_average' | 'median';
}

export interface ComparableSaleResult {
  id: string;
  /** Sale price divided by the comp's own units of comparison, before any adjustment. */
  rawPricePerUnit: string;
  /** Sum of every adjustment supplied for this comp. */
  totalAdjustmentPercent: string;
  /** `rawPricePerUnit` scaled by `(1 + totalAdjustmentPercent)`. */
  adjustedPricePerUnit: string;
}

export interface SalesComparisonResult {
  comparables: ComparableSaleResult[];
  reconciliation: 'weighted_average' | 'median';
  /** The reconciled per-unit value, in the same unit `subjectUnitsOfComparison` is expressed in. */
  indicatedValuePerUnit: string;
  /** `indicatedValuePerUnit` times the subject's own size. */
  indicatedValue: string;
}

function sumAdjustments(adjustments: ComparableSaleAdjustments): Decimal {
  return [
    adjustments.marketConditions,
    adjustments.location,
    adjustments.physicalCharacteristics,
    adjustments.conditionQuality,
    adjustments.other,
  ].reduce((total: Decimal, value) => (value ? total.plus(d(value)) : total), ZERO);
}

export function computeSalesComparison(input: SalesComparisonInput): SalesComparisonResult {
  const subjectUnits = d(input.subjectUnitsOfComparison);
  if (!subjectUnits.greaterThan(0)) {
    throw new Error('subjectUnitsOfComparison must be a positive number.');
  }
  if (input.comparables.length === 0) {
    throw new Error('At least one comparable sale is required.');
  }

  const comparables: ComparableSaleResult[] = input.comparables.map((comp) => {
    const units = d(comp.unitsOfComparison);
    if (!units.greaterThan(0)) {
      throw new Error(`Comparable "${comp.id}": unitsOfComparison must be a positive number.`);
    }
    const rawPricePerUnit = d(comp.salePrice).dividedBy(units);
    const totalAdjustmentPercent = sumAdjustments(comp.adjustments);
    const adjustedPricePerUnit = rawPricePerUnit.times(totalAdjustmentPercent.plus(1));
    return {
      id: comp.id,
      rawPricePerUnit: rawPricePerUnit.toString(),
      totalAdjustmentPercent: totalAdjustmentPercent.toString(),
      adjustedPricePerUnit: adjustedPricePerUnit.toString(),
    };
  });

  const reconciliation = input.reconciliation ?? 'weighted_average';
  const adjustedPrices = comparables.map((comp) => d(comp.adjustedPricePerUnit));

  let indicatedValuePerUnit: Decimal;
  if (reconciliation === 'median') {
    const sorted = [...adjustedPrices].sort((a, b) => a.comparedTo(b));
    const mid = Math.floor(sorted.length / 2);
    indicatedValuePerUnit =
      sorted.length % 2 === 1
        ? (sorted[mid] as Decimal)
        : (sorted[mid - 1] as Decimal).plus(sorted[mid] as Decimal).dividedBy(2);
  } else {
    const weights = input.comparables.map((comp) =>
      comp.weight ? d(comp.weight) : new Decimal(1),
    );
    const totalWeight = weights.reduce((total, weight) => total.plus(weight), ZERO);
    if (!totalWeight.greaterThan(0)) {
      throw new Error('The comparables’ weights must sum to a positive number.');
    }
    const weightedSum = adjustedPrices.reduce(
      (total, price, index) => total.plus(price.times(weights[index] as Decimal)),
      ZERO,
    );
    indicatedValuePerUnit = weightedSum.dividedBy(totalWeight);
  }

  return {
    comparables,
    reconciliation,
    indicatedValuePerUnit: indicatedValuePerUnit.toString(),
    indicatedValue: indicatedValuePerUnit.times(subjectUnits).toString(),
  };
}

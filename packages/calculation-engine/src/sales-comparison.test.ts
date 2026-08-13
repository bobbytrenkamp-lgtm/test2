import { describe, expect, it } from 'vitest';
import { computeSalesComparison, type ComparableSale } from './sales-comparison.js';

/**
 * Every expected value below is plain arithmetic worked out by hand from the
 * fixture's own numbers, never taken from a call to `computeSalesComparison`
 * itself.
 */

// Comp A: $5,000,000 / 50,000 SF = $100.00/SF raw.
// Adjustments: +0.02 market conditions, -0.01 location, +0.03 physical = +0.04 total.
// Adjusted: 100 x 1.04 = $104.00/SF.
const compA: ComparableSale = {
  id: 'A',
  salePrice: '5000000',
  unitsOfComparison: '50000',
  adjustments: { marketConditions: '0.02', location: '-0.01', physicalCharacteristics: '0.03' },
};

// Comp B: $4,500,000 / 45,000 SF = $100.00/SF raw.
// Adjustments: +0.01 market conditions, -0.02 condition/quality = -0.01 total.
// Adjusted: 100 x 0.99 = $99.00/SF.
const compB: ComparableSale = {
  id: 'B',
  salePrice: '4500000',
  unitsOfComparison: '45000',
  adjustments: { marketConditions: '0.01', conditionQuality: '-0.02' },
};

// Comp C: $6,000,000 / 60,000 SF = $100.00/SF raw. Adjustment: +0.05 other.
// Adjusted: 100 x 1.05 = $105.00/SF.
const compC: ComparableSale = {
  id: 'C',
  salePrice: '6000000',
  unitsOfComparison: '60000',
  adjustments: { other: '0.05' },
};

describe('computeSalesComparison', () => {
  it('computes each comparable’s raw and adjusted price per unit', () => {
    const result = computeSalesComparison({
      subjectUnitsOfComparison: '50000',
      comparables: [compA, compB],
    });
    expect(result.comparables[0]).toEqual({
      id: 'A',
      rawPricePerUnit: '100',
      totalAdjustmentPercent: '0.04',
      adjustedPricePerUnit: '104',
    });
    expect(result.comparables[1]).toEqual({
      id: 'B',
      rawPricePerUnit: '100',
      totalAdjustmentPercent: '-0.01',
      adjustedPricePerUnit: '99',
    });
  });

  it('reconciles by equal-weighted average when no weight is given', () => {
    // (104 + 99) / 2 = 101.50.
    const result = computeSalesComparison({
      subjectUnitsOfComparison: '50000',
      comparables: [compA, compB],
    });
    expect(result.reconciliation).toBe('weighted_average');
    expect(result.indicatedValuePerUnit).toBe('101.5');
    // 101.50 x 50,000 = 5,075,000.
    expect(result.indicatedValue).toBe('5075000');
  });

  it('weights comparables unequally when a weight is given', () => {
    // (104 x 3 + 99 x 1) / (3 + 1) = (312 + 99) / 4 = 102.75.
    const result = computeSalesComparison({
      subjectUnitsOfComparison: '50000',
      comparables: [
        { ...compA, weight: '3' },
        { ...compB, weight: '1' },
      ],
    });
    expect(result.indicatedValuePerUnit).toBe('102.75');
    // 102.75 x 50,000 = 5,137,500.
    expect(result.indicatedValue).toBe('5137500');
  });

  it('reconciles by median, which an outlying comp does not shift the way an average would', () => {
    // Adjusted prices: 104, 99, 105. Sorted: 99, 104, 105. Median = 104
    // (the middle value), distinct from the mean of the same three
    // (308 / 3 = 102.666...), which is exactly the point of using it.
    const result = computeSalesComparison({
      subjectUnitsOfComparison: '50000',
      comparables: [compA, compB, compC],
      reconciliation: 'median',
    });
    expect(result.indicatedValuePerUnit).toBe('104');
    expect(result.indicatedValue).toBe('5200000');
  });

  it('averages the two middle values for an even number of comparables under median reconciliation', () => {
    // Adjusted prices: 104, 99. Sorted: 99, 104. Even count -> (99 + 104) / 2 = 101.5.
    const result = computeSalesComparison({
      subjectUnitsOfComparison: '50000',
      comparables: [compA, compB],
      reconciliation: 'median',
    });
    expect(result.indicatedValuePerUnit).toBe('101.5');
  });

  it('rejects a non-positive subject size', () => {
    expect(() =>
      computeSalesComparison({ subjectUnitsOfComparison: '0', comparables: [compA] }),
    ).toThrow(/subjectUnitsOfComparison/);
  });

  it('rejects a comparable with a non-positive units of comparison, rather than dividing by zero', () => {
    expect(() =>
      computeSalesComparison({
        subjectUnitsOfComparison: '50000',
        comparables: [{ ...compA, unitsOfComparison: '0' }],
      }),
    ).toThrow(/Comparable "A"/);
  });

  it('rejects an empty comparable set', () => {
    expect(() =>
      computeSalesComparison({ subjectUnitsOfComparison: '50000', comparables: [] }),
    ).toThrow(/At least one comparable/);
  });
});

import { describe, expect, it } from 'vitest';
import { computeCostApproach } from './cost-approach.js';

/**
 * Every expected value below is plain arithmetic worked out by hand from the
 * fixture's own numbers, never taken from a call to `computeCostApproach`
 * itself.
 */

describe('computeCostApproach', () => {
  it('depreciates each improvement by the sum of its own components', () => {
    // Improvement A: 8,000,000 replacement cost new.
    // Depreciation: 0.10 physical + 0.05 functional + 0.02 external = 0.17.
    // Depreciated cost: 8,000,000 x (1 - 0.17) = 6,640,000.
    const result = computeCostApproach({
      landValue: '0',
      improvements: [
        {
          id: 'A',
          replacementCostNew: '8000000',
          physicalDeterioration: '0.10',
          functionalObsolescence: '0.05',
          externalObsolescence: '0.02',
        },
      ],
    });
    expect(result.improvements[0]).toEqual({
      id: 'A',
      replacementCostNew: '8000000',
      totalDepreciationPercent: '0.17',
      depreciatedCost: '6640000',
    });
  });

  it('sums land, depreciated improvements and entrepreneurial profit to the indicated value', () => {
    // Improvement A: 8,000,000 at 0.17 depreciation -> 6,640,000 depreciated.
    // Improvement B: 2,000,000 at 0.20 depreciation -> 1,600,000 depreciated.
    // Total replacement cost new: 10,000,000. Entrepreneurial profit at 10%: 1,000,000.
    // Total depreciated cost: 6,640,000 + 1,600,000 = 8,240,000.
    // Land: 1,500,000. Indicated value: 1,500,000 + 8,240,000 + 1,000,000 = 10,740,000.
    const result = computeCostApproach({
      landValue: '1500000',
      entrepreneurialProfitPercent: '0.10',
      improvements: [
        {
          id: 'A',
          replacementCostNew: '8000000',
          physicalDeterioration: '0.10',
          functionalObsolescence: '0.05',
          externalObsolescence: '0.02',
        },
        { id: 'B', replacementCostNew: '2000000', physicalDeterioration: '0.20' },
      ],
    });
    expect(result.totalReplacementCostNew).toBe('10000000');
    expect(result.entrepreneurialProfit).toBe('1000000');
    expect(result.totalDepreciatedCost).toBe('8240000');
    expect(result.indicatedValue).toBe('10740000');
  });

  it('clamps depreciation exceeding 100% to fully depreciated, rather than a negative cost', () => {
    // 0.9 + 0.4 + 0.3 = 1.6, clamped to 1.0 -> depreciated cost is zero.
    const result = computeCostApproach({
      landValue: '0',
      improvements: [
        {
          id: 'A',
          replacementCostNew: '500000',
          physicalDeterioration: '0.9',
          functionalObsolescence: '0.4',
          externalObsolescence: '0.3',
        },
      ],
    });
    expect(result.improvements[0]?.totalDepreciationPercent).toBe('1');
    expect(result.improvements[0]?.depreciatedCost).toBe('0');
  });

  it('clamps a negative depreciation sum to zero, rather than inflating the cost', () => {
    const result = computeCostApproach({
      landValue: '0',
      improvements: [{ id: 'A', replacementCostNew: '500000', physicalDeterioration: '-0.05' }],
    });
    expect(result.improvements[0]?.totalDepreciationPercent).toBe('0');
    expect(result.improvements[0]?.depreciatedCost).toBe('500000');
  });

  it('values raw land with no improvements at all as just the land value', () => {
    const result = computeCostApproach({ landValue: '1200000', improvements: [] });
    expect(result.totalReplacementCostNew).toBe('0');
    expect(result.totalDepreciatedCost).toBe('0');
    expect(result.indicatedValue).toBe('1200000');
  });

  it('defaults entrepreneurial profit to zero when omitted', () => {
    const result = computeCostApproach({
      landValue: '100000',
      improvements: [{ id: 'A', replacementCostNew: '900000' }],
    });
    expect(result.entrepreneurialProfit).toBe('0');
    expect(result.indicatedValue).toBe('1000000');
  });

  it('rejects a negative land value', () => {
    expect(() => computeCostApproach({ landValue: '-1', improvements: [] })).toThrow(/landValue/);
  });

  it('rejects a negative replacement cost new', () => {
    expect(() =>
      computeCostApproach({
        landValue: '0',
        improvements: [{ id: 'A', replacementCostNew: '-100' }],
      }),
    ).toThrow(/Improvement "A"/);
  });
});

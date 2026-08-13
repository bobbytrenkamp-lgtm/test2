import { describe, expect, it } from 'vitest';
import { computeStraightLineRent } from './straight-line-rent.js';

/**
 * Expected values are computed independently of `computeStraightLineRent` —
 * plain arithmetic on the fixture's own stated rent figures, never copied
 * from the function's own output.
 */
describe('computeStraightLineRent', () => {
  it('spreads a 3% escalation evenly, ending the deferred balance at exactly zero', () => {
    // Hand-derived: 100,000 + 103,000 + 106,090 = 309,090 total; straight-line
    // = 309,090 / 3 = 103,030 exactly (evenly divisible, so every period
    // recognises the same amount with nothing left for the last period to
    // absorb).
    //
    // Deferred balance, period by period:
    //   Year 1: 103,030 recognised - 100,000 billed = +3,030
    //   Year 2: +3,030 + (103,030 - 103,000) = +3,060
    //   Year 3: +3,060 + (103,030 - 106,090) = +3,060 - 3,060 = 0
    const result = computeStraightLineRent(['100000', '103000', '106090']);
    expect(result.straightLineMonthlyRent).toBe('103030');
    expect(result.recognizedRent).toEqual(['103030', '103030', '103030']);
    expect(result.deferredRentBalance).toEqual(['3030', '3060', '0']);
  });

  it('pushes a rounding residual onto the last period so the series sums back exactly', () => {
    // Hand-derived: 30 + 30 + 40 = 100 total; 100 / 3 = 33.333... rounds to
    // 33.33. Two periods at 33.33 leaves 100 - 66.66 = 33.34 for the third.
    const result = computeStraightLineRent(['30', '30', '40']);
    expect(result.straightLineMonthlyRent).toBe('33.33');
    expect(result.recognizedRent).toEqual(['33.33', '33.33', '33.34']);
    // 33.33 + 33.33 + 33.34 = 100.00, matching the actual total exactly —
    // the whole point of pushing the residual onto the last period.
    const recognizedTotal = result.recognizedRent.reduce((sum, v) => sum + Number(v), 0);
    expect(recognizedTotal).toBeCloseTo(100, 8);
    expect(result.deferredRentBalance).toEqual(['3.33', '6.66', '0']);
  });

  it('recognises rent during a free-rent period, carrying it as a deferred asset until it unwinds', () => {
    // Hand-derived: 0 (free) + 1,000 + 1,000 = 2,000 total; 2,000 / 3 =
    // 666.666... rounds to 666.67. Last period absorbs the residual:
    // 2,000 - 666.67 - 666.67 = 666.66.
    const result = computeStraightLineRent(['0', '1000', '1000']);
    expect(result.straightLineMonthlyRent).toBe('666.67');
    expect(result.recognizedRent).toEqual(['666.67', '666.67', '666.66']);
    // Month 1 (free): recognises 666.67 against 0 billed -> a 666.67 asset.
    // Month 2: +666.67 + (666.67 - 1,000) = 333.34.
    // Month 3: +333.34 + (666.66 - 1,000) = 333.34 - 333.34 = 0.
    expect(result.deferredRentBalance).toEqual(['666.67', '333.34', '0']);
  });

  it('always ends the deferred balance at exactly zero, for any series', () => {
    // A mathematical property of the construction (recognised sums to the
    // same total as actual, by the last period's residual), not a
    // fixture-specific number: checked here against a series unrelated to
    // any of the other fixtures.
    const series = ['12345.67', '0', '9999.99', '50000', '1'];
    const result = computeStraightLineRent(series);
    expect(result.deferredRentBalance.at(-1)).toBe('0');
  });

  it('reduces to the single period itself, with no deferred balance', () => {
    const result = computeStraightLineRent(['5000']);
    expect(result.straightLineMonthlyRent).toBe('5000');
    expect(result.recognizedRent).toEqual(['5000']);
    expect(result.deferredRentBalance).toEqual(['0']);
  });

  it('returns empty results for an empty series rather than dividing by zero', () => {
    const result = computeStraightLineRent([]);
    expect(result.straightLineMonthlyRent).toBe('0');
    expect(result.recognizedRent).toEqual([]);
    expect(result.actualRent).toEqual([]);
    expect(result.deferredRentBalance).toEqual([]);
  });
});

import { describe, expect, it } from 'vitest';
import { buildComparison, type BuildComparisonInput } from './research-comparison.js';
import { researchComparisonSchema, type ResearchObservation } from './cre-property-research.js';

/**
 * The comparable-selection and percentile engine: a pure function, so every
 * test here is arithmetic checked by hand rather than a claim taken on
 * faith. See `docs/property-research.md`'s own description of why this is
 * the natural next increment and what it deliberately does not attempt
 * (geographic distance — `ResearchObservation` has no coordinate to compute
 * one from).
 */

const GEOGRAPHY = { type: 'radius' as const, value: 1, unit: 'mile' as const };

function observation(overrides: Partial<ResearchObservation> = {}): ResearchObservation {
  return {
    sourceId: 'src-1',
    metric: 'comp.rent',
    value: '2000',
    valueType: 'decimal',
    unitType: '2bed_2bath',
    ...overrides,
  };
}

function input(overrides: Partial<BuildComparisonInput> = {}): BuildComparisonInput {
  return {
    metric: 'comp.rent',
    unitType: '2bed_2bath',
    observations: [],
    geography: GEOGRAPHY,
    now: '2026-06-01T00:00:00.000Z',
    ...overrides,
  };
}

const FIVE_POINTS = [2000, 2100, 2200, 2300, 2400].map((value) =>
  observation({ value: String(value) }),
);

describe('buildComparison', () => {
  it('computes min/p25/median/p75/max by linear interpolation, hand-verified', () => {
    // Sorted: 2000, 2100, 2200, 2300, 2400 (n=5). p25 rank = 0.25*4 = 1 (exact
    // index 1 = 2100); median rank = 0.5*4 = 2 (exact index 2 = 2200); p75
    // rank = 0.75*4 = 3 (exact index 3 = 2300) — no interpolation needed for
    // this set, so the expected values are the raw data points themselves.
    const result = buildComparison(input({ observations: FIVE_POINTS }));
    expect(result.stats).toEqual({
      count: 5,
      min: '2000',
      p25: '2100',
      median: '2200',
      p75: '2300',
      max: '2400',
    });
    expect(result.coverage.sampleCount).toBe(5);
    expect(result.coverage.exclusions).toEqual([]);
  });

  it('interpolates a percentile that does not land on a sample point', () => {
    // Four points: 10, 20, 30, 40. p25 rank = 0.25*3 = 0.75, between index 0
    // (10) and index 1 (20): 10 + 0.75*10 = 17.5.
    const result = buildComparison(
      input({
        observations: [10, 20, 30, 40].map((value) => observation({ value: String(value) })),
      }),
    );
    expect(result.stats.p25).toBe('17.5');
  });

  it('computes the subject percentile and premium to median', () => {
    // Median is 2200 (see the first test). Subject at 2150: two of five
    // values (2000, 2100) are below it, none equal, so percentile rank =
    // (2/5)*100 = 40. Premium to median = (2150-2200)/2200 = -0.0227272...,
    // rounded to six places.
    const result = buildComparison(input({ observations: FIVE_POINTS, subjectValue: '2150' }));
    expect(result.subjectPercentile).toBe(40);
    expect(result.premiumToMedian).toBe('-0.022727');
  });

  it('excludes an observation of a different metric, and records why', () => {
    const result = buildComparison(
      input({
        observations: [...FIVE_POINTS, observation({ metric: 'comp.opex', value: '500' })],
      }),
    );
    expect(result.coverage.sampleCount).toBe(5);
    expect(result.coverage.exclusions).toEqual([
      { count: 1, reason: 'Addressed a different metric than "comp.rent".' },
    ]);
  });

  it('excludes an observation of a different unit type, and records why', () => {
    const result = buildComparison(
      input({
        observations: [...FIVE_POINTS, observation({ unitType: '1bed_1bath', value: '1500' })],
      }),
    );
    expect(result.coverage.sampleCount).toBe(5);
    expect(result.coverage.exclusions).toEqual([
      { count: 1, reason: 'Unit type did not match "2bed_2bath".' },
    ]);
  });

  it('excludes an observation with no usable numeric value', () => {
    const result = buildComparison(
      input({
        observations: [...FIVE_POINTS, observation({ value: null }), observation({ value: 'tbd' })],
      }),
    );
    expect(result.coverage.sampleCount).toBe(5);
    expect(result.coverage.exclusions).toEqual([
      { count: 2, reason: 'Value was missing or not a number.' },
    ]);
  });

  it('excludes a stale observation but keeps one with no recorded date', () => {
    const stale = observation({ value: '2050', observedAt: '2024-01-01T00:00:00.000Z' });
    const undated = observation({ value: '2075' });
    const result = buildComparison(
      input({ observations: [...FIVE_POINTS, stale, undated], maxAgeDays: 180 }),
    );
    // The stale point is excluded; the undated one cannot be judged stale
    // and stays in the sample, which is why the count is 6, not 5 or 7.
    expect(result.coverage.sampleCount).toBe(6);
    expect(result.coverage.exclusions).toEqual([
      { count: 1, reason: 'Observed more than 180 days ago.' },
    ]);
  });

  it('flags a statistical outlier out of the statistics without touching the source array', () => {
    // Adding 9000 to the five-point set pushes it far outside 1.5x the IQR
    // of the remaining data (worked out in the file-level comment); after
    // its exclusion the statistics land on exactly the same numbers as the
    // plain five-point test above.
    const withOutlier = [...FIVE_POINTS, observation({ value: '9000' })];
    const result = buildComparison(input({ observations: withOutlier }));

    expect(result.coverage.sampleCount).toBe(5);
    expect(result.stats.median).toBe('2200');
    expect(result.stats.max).toBe('2400');
    const outlierExclusion = result.coverage.exclusions.find((entry) =>
      entry.reason.includes('outlier'),
    );
    expect(outlierExclusion?.count).toBe(1);

    // The source array itself is never mutated — flagging, not deletion.
    expect(withOutlier).toHaveLength(6);
    expect(withOutlier.some((entry) => entry.value === '9000')).toBe(true);
  });

  it('does not apply outlier fencing to a sample smaller than four', () => {
    // A three-point sample cannot support a quartile split that means
    // anything; the whole sample is honest about being small rather than
    // having one of its three points thrown out by a formula.
    const three = [1000, 2000, 50000].map((value) => observation({ value: String(value) }));
    const result = buildComparison(input({ observations: three }));
    expect(result.coverage.sampleCount).toBe(3);
    expect(result.coverage.exclusions).toEqual([]);
  });

  it('returns a valid, empty comparison rather than failing when nothing matches', () => {
    const result = buildComparison(input({ observations: [] }));
    expect(result.coverage.sampleCount).toBe(0);
    expect(result.stats).toEqual({
      count: 0,
      min: null,
      p25: null,
      median: null,
      p75: null,
      max: null,
    });
    expect(result.subjectPercentile).toBeNull();
    // Still a schema-valid ResearchComparison, not a special case a caller
    // has to detect separately.
    expect(() => researchComparisonSchema.parse(result)).not.toThrow();
  });

  it('always produces schema-valid output', () => {
    const result = buildComparison(
      input({ observations: FIVE_POINTS, subjectValue: '2150', sourceIds: ['src-1'] }),
    );
    expect(() => researchComparisonSchema.parse(result)).not.toThrow();
  });

  it('states the geographic-distance limitation on every comparison', () => {
    const result = buildComparison(input({ observations: FIVE_POINTS }));
    expect(result.coverage.limitations.join(' ')).toContain('Geographic proximity');
  });
});

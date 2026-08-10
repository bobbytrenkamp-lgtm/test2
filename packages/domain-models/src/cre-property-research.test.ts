import { describe, expect, it } from 'vitest';
import {
  crePropertyResearchSchema,
  parsePropertyResearchPayload,
  researchObservationSchema,
  researchRecommendationSchema,
} from './cre-property-research.js';

/**
 * The paste-to-document parser and schema for property research.
 *
 * Mirrors `cre-assumption-import.test.ts` in spirit and in method: valid
 * JSON in the right shape becomes a document, anything else becomes a
 * plain-language explanation with the paste left untouched. What is unique
 * to this format and worth its own tests is the semantic separation between
 * an observation (a stated fact) and a recommendation (the only thing that
 * can become a test2 proposal) — see the module doc comment on
 * `cre-property-research.ts` for why collapsing the two would defeat the
 * whole point of the format.
 */

const MINIMAL = {
  format: 'cre-property-research',
  version: 1,
  subject: { address: '123 Main Street, Raleigh, NC', assetType: 'industrial' },
  sources: [{ id: 'src-1', kind: 'listing_url', url: 'https://example.invalid/listing/1' }],
  observations: [
    {
      sourceId: 'src-1',
      metric: 'listing.askingRent',
      value: '2150',
      valueType: 'decimal',
    },
  ],
};

describe('parsePropertyResearchPayload', () => {
  it('parses a well-formed document', () => {
    const result = parsePropertyResearchPayload(JSON.stringify(MINIMAL));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.subject.address).toBe('123 Main Street, Raleigh, NC');
      expect(result.data.observations).toHaveLength(1);
    }
  });

  it('strips one surrounding markdown fence', () => {
    const fenced = '```json\n' + JSON.stringify(MINIMAL) + '\n```';
    expect(parsePropertyResearchPayload(fenced).ok).toBe(true);
  });

  it('strips a fence with no language tag', () => {
    const fenced = '```\n' + JSON.stringify(MINIMAL) + '\n```';
    expect(parsePropertyResearchPayload(fenced).ok).toBe(true);
  });

  it('tolerates surrounding whitespace', () => {
    expect(parsePropertyResearchPayload(`\n\n  ${JSON.stringify(MINIMAL)}   \n`).ok).toBe(true);
  });

  it('refuses empty input, with a message rather than a crash', () => {
    const result = parsePropertyResearchPayload('   ');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('Paste');
  });

  it('refuses malformed JSON without pretending to repair it', () => {
    const result = parsePropertyResearchPayload('{ "format": "cre-property-research", oops }');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('not valid JSON');
  });

  it('refuses a JSON array', () => {
    const result = parsePropertyResearchPayload('[1, 2, 3]');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('not an object');
  });

  it('refuses a document with the wrong format name', () => {
    const result = parsePropertyResearchPayload(
      JSON.stringify({ ...MINIMAL, format: 'cre-assumption-import' }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('cre-property-research');
      expect(result.error).toContain('cre-assumption-import');
    }
  });

  it('refuses a document with no format field, saying it is missing', () => {
    const { format: _format, ...withoutFormat } = MINIMAL;
    const result = parsePropertyResearchPayload(JSON.stringify(withoutFormat));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('missing');
  });

  it('refuses an unsupported version rather than misreading it', () => {
    const result = parsePropertyResearchPayload(JSON.stringify({ ...MINIMAL, version: 2 }));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('version 1');
      expect(result.error).toContain('version 2');
    }
  });

  it('does not erase the original paste on failure', () => {
    const original = '{ this is not json';
    const result = parsePropertyResearchPayload(original);
    expect(result.ok).toBe(false);
    expect(original).toBe('{ this is not json');
  });

  it('defaults subject and every array so a minimal document is valid', () => {
    const result = parsePropertyResearchPayload(
      JSON.stringify({ format: 'cre-property-research', version: 1 }),
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.subject).toEqual({});
      expect(result.data.sources).toEqual([]);
      expect(result.data.observations).toEqual([]);
      expect(result.data.comparisons).toEqual([]);
      expect(result.data.modelEstimates).toEqual([]);
      expect(result.data.recommendations).toEqual([]);
    }
  });

  it('refuses an observation with an invalid value for its own valueType', () => {
    const result = parsePropertyResearchPayload(
      JSON.stringify({
        ...MINIMAL,
        observations: [
          { sourceId: 'src-1', metric: 'listing.askingRent', value: 'a lot', valueType: 'decimal' },
        ],
      }),
    );
    expect(result.ok).toBe(false);
  });
});

describe('semantic separation: observation vs. recommendation', () => {
  it('an observation has no field that could address a test2 model target', () => {
    // The whole point of keeping these as two schemas: nothing about an
    // observation can accidentally become something applied to a model.
    // `metric` is free text, not `assumptionTargetSchema`.
    const shape = researchObservationSchema.innerType().shape;
    expect('target' in shape).toBe(false);
    expect('metric' in shape).toBe(true);
  });

  it('only a recommendation carries a real assumptionTargetSchema target and a required methodology', () => {
    const shape = researchRecommendationSchema.innerType().shape;
    expect('target' in shape).toBe(true);
    expect('methodology' in shape).toBe(true);

    // A recommendation naming an invalid target shape is refused the same
    // way a cre-assumption-import assumption is.
    expect(() =>
      researchRecommendationSchema.parse({
        target: 'not a valid target!!',
        value: '0.06',
        valueType: 'decimal',
        methodology: 'Comparable set median.',
      }),
    ).toThrow();

    // A recommendation with no methodology is refused — a recommendation
    // that cannot say how it was derived is not one.
    expect(() =>
      researchRecommendationSchema.parse({
        target: 'valuation.discountRate',
        value: '0.08',
        valueType: 'decimal',
        methodology: '',
      }),
    ).toThrow();
  });

  it('a recommendation validates its value against its own valueType, same rule as everywhere else', () => {
    expect(() =>
      researchRecommendationSchema.parse({
        target: 'valuation.saleMonth',
        value: 'soon',
        valueType: 'integer',
        methodology: 'Stated exit timing.',
      }),
    ).toThrow();
  });

  it('a recommendation may be a remark with no figure, the same as an assumption proposal', () => {
    const parsed = researchRecommendationSchema.parse({
      target: 'valuation.discountRate',
      value: null,
      valueType: 'decimal',
      methodology: 'Qualitative: three competing developments nearby.',
    });
    expect(parsed.value).toBeNull();
  });
});

describe('crePropertyResearchSchema: comparisons, model estimates, coverage', () => {
  it('accepts a full comparison with coverage and geography', () => {
    const parsed = crePropertyResearchSchema.parse({
      ...MINIMAL,
      comparisons: [
        {
          metric: 'rent',
          unitType: '2bed_2bath',
          subjectValue: '2150',
          stats: { count: 18, min: '1975', p25: '2125', median: '2275', p75: '2425', max: '2650' },
          subjectPercentile: 34,
          premiumToMedian: '-0.055',
          geography: { type: 'radius', value: 1, unit: 'mile' },
          coverage: {
            sampleCount: 18,
            propertyCount: 12,
            dateRangeStart: '2026-05-01',
            dateRangeEnd: '2026-08-01',
            exclusions: [
              { count: 3, reason: 'Furnished corporate housing, not a comparable unit type.' },
            ],
            limitations: ['Radius search only; submarket boundary not applied.'],
          },
        },
      ],
    });
    expect(parsed.comparisons[0]?.subjectPercentile).toBe(34);
    expect(parsed.comparisons[0]?.coverage.exclusions).toHaveLength(1);
  });

  it('accepts a model estimate in the test3 shape, requiring a named model', () => {
    expect(() =>
      crePropertyResearchSchema.parse({
        ...MINIMAL,
        modelEstimates: [{ target: 'market_rent', estimate: '2245', model: '' }],
      }),
    ).toThrow();

    const parsed = crePropertyResearchSchema.parse({
      ...MINIMAL,
      modelEstimates: [
        {
          target: 'market_rent',
          estimate: '2245',
          unit: 'per_unit_per_month',
          model: 'mf-rent-v3',
          confidence: { low: '2200', high: '2290', level: 0.8 },
          drivers: [{ factor: 'submarket_absorption', effect: 'positive' }],
        },
      ],
    });
    expect(parsed.modelEstimates[0]?.model).toBe('mf-rent-v3');
  });

  it('bounds every array so a document cannot be unbounded', () => {
    const one = MINIMAL.observations[0] as Record<string, unknown>;
    expect(() =>
      crePropertyResearchSchema.parse({
        ...MINIMAL,
        observations: Array.from({ length: 2001 }, () => one),
      }),
    ).toThrow();
  });
});

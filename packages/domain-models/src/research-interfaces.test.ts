import { describe, expect, it } from 'vitest';
import {
  researchRequestSchema,
  test1ResearchRequestSchema,
  test1ResearchResponseSchema,
  test3RecommendationSchema,
} from './research-interfaces.js';

/**
 * Contracts for systems this repository does not contain.
 *
 * These tests check shape only — there is nothing live to integration-test.
 * What matters here is that the contract is internally consistent (a test1
 * response's observation shape is the one `cre-property-research.ts`
 * actually accepts) and that it stays honest about what is required versus
 * optional, since a contract nobody can violate accidentally is the whole
 * value of writing it down before the other side exists.
 */

describe('researchRequestSchema', () => {
  it('accepts a request naming a URL subject and the research lines wanted', () => {
    const parsed = researchRequestSchema.parse({
      subject: { url: 'https://example.invalid/listing/1' },
      assetType: 'multifamily',
      research: ['property_identity', 'multifamily_rents'],
    });
    expect(parsed.research).toEqual(['property_identity', 'multifamily_rents']);
  });

  it('accepts a request naming only coordinates, with a geography scope', () => {
    const parsed = researchRequestSchema.parse({
      subject: { latitude: 35.7796, longitude: -78.6382 },
      research: ['market_rent'],
      geography: { type: 'radius', value: 1, unit: 'mile' },
    });
    expect(parsed.geography?.type).toBe('radius');
  });

  it('refuses a request naming no research line at all', () => {
    // An empty request has nothing for an orchestrator to do with it; this
    // schema refuses it rather than silently running everything.
    expect(() => researchRequestSchema.parse({ subject: {}, research: [] })).toThrow();
  });

  it('refuses an unrecognized research line rather than accepting an open vocabulary', () => {
    expect(() =>
      researchRequestSchema.parse({ subject: {}, research: ['made_up_line'] }),
    ).toThrow();
  });
});

describe('test1ResearchRequestSchema and test1ResearchResponseSchema', () => {
  it('accepts a request test2 or test3 could send test1', () => {
    const parsed = test1ResearchRequestSchema.parse({
      address: '123 Main Street, Raleigh, NC',
      research: ['property_identity', 'multifamily_rents'],
    });
    expect(parsed.address).toContain('Raleigh');
  });

  it('accepts a response in the shape observations can be dropped from directly', () => {
    const parsed = test1ResearchResponseSchema.parse({
      subject: { standardizedAddress: '123 Main St, Raleigh, NC 27601', parcelId: 'PIN-0012345' },
      observations: [
        {
          metric: 'comp.rent',
          value: '2275',
          valueType: 'decimal',
          unitType: '2bed_2bath',
          observedAt: '2026-07-01T00:00:00.000Z',
        },
      ],
      coverage: { sampleCount: 18, propertyCount: 12 },
      source: { system: 'test1', version: '1.0.0' },
    });
    expect(parsed.observations[0]?.metric).toBe('comp.rent');
    expect(parsed.source.system).toBe('test1');
  });

  it('refuses a response claiming to be from a different system', () => {
    expect(() =>
      test1ResearchResponseSchema.parse({
        subject: {},
        source: { system: 'test3' },
      }),
    ).toThrow();
  });

  it('defaults observations to an empty array so a not-yet-covered request still parses', () => {
    const parsed = test1ResearchResponseSchema.parse({
      subject: {},
      source: { system: 'test1' },
    });
    expect(parsed.observations).toEqual([]);
  });
});

describe('test3RecommendationSchema', () => {
  it("is the same shape as cre-property-research.ts's modelEstimateSchema, so a response needs no translation", () => {
    const parsed = test3RecommendationSchema.parse({
      target: 'market_rent',
      estimate: '2245',
      unit: 'per_unit_per_month',
      model: 'mf-rent-v3',
      confidence: { low: '2200', high: '2290', level: 0.8 },
    });
    expect(parsed.model).toBe('mf-rent-v3');
  });

  it('refuses an estimate with no named model — an unnamed model cannot be weighed', () => {
    expect(() =>
      test3RecommendationSchema.parse({ target: 'market_rent', estimate: '2245', model: '' }),
    ).toThrow();
  });
});

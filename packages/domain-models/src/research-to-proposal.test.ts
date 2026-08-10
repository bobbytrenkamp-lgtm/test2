import { describe, expect, it } from 'vitest';
import {
  crePropertyResearchSchema,
  type CrePropertyResearch,
  type CrePropertyResearchInput,
} from './cre-property-research.js';
import {
  recommendationToProposalInput,
  recommendationsToProposalInputs,
} from './research-to-proposal.js';

/**
 * The one place research becomes underwriting.
 *
 * The tests that matter here confirm the conversion is exactly that and no
 * more: `sourceKind` is always `recommended` — never `imported`, never
 * anything implying the number is a fact rather than a synthesis — and
 * every citation a recommendation makes survives into the proposal's
 * evidence rather than being summarised away, so an analyst reviewing the
 * proposal is looking at the same comparable set and model estimate the
 * recommendation was actually built from.
 */

function research(overrides: Partial<CrePropertyResearchInput> = {}): CrePropertyResearch {
  return crePropertyResearchSchema.parse({
    format: 'cre-property-research',
    version: 1,
    subject: {
      name: 'Example Apartments',
      address: '123 Main St, Raleigh, NC',
      assetType: 'multifamily',
    },
    sources: [
      { id: 'src-listing', kind: 'listing_url', name: 'Listing', url: 'https://example.invalid/1' },
      { id: 'src-test1', kind: 'test1', name: 'test1 comparables' },
    ],
    comparisons: [
      {
        id: 'cmp-2b2b',
        metric: 'rent',
        unitType: '2bed_2bath',
        subjectValue: '2150',
        stats: { count: 18, min: '1975', p25: '2125', median: '2275', p75: '2425', max: '2650' },
        subjectPercentile: 34,
        premiumToMedian: '-0.055',
        geography: { type: 'radius', value: 1, unit: 'mile' },
        coverage: { sampleCount: 18, propertyCount: 12 },
        sourceIds: ['src-test1'],
      },
    ],
    modelEstimates: [
      {
        id: 'est-rent',
        target: 'market_rent',
        estimate: '2245',
        unit: 'per_unit_per_month',
        model: 'mf-rent-v3',
        sourceIds: ['src-test1'],
      },
    ],
    recommendations: [
      {
        id: 'rec-rent',
        target: 'marketLeasing.MF_2B2B.marketRent',
        value: '2250',
        valueType: 'decimal',
        confidence: 0.85,
        methodology: 'Comparable-set median adjusted toward the test3 model estimate.',
        sourceIds: ['src-listing', 'src-test1'],
        comparisonIds: ['cmp-2b2b'],
        modelEstimateIds: ['est-rent'],
      },
    ],
    ...overrides,
  });
}

describe('recommendationToProposalInput', () => {
  it('always proposes as sourceKind "recommended", never as a fact', () => {
    const doc = research();
    const proposal = recommendationToProposalInput(doc, doc.recommendations[0]!);
    expect(proposal.sourceKind).toBe('recommended');
  });

  it('carries the target, value and valueType straight through', () => {
    const doc = research();
    const proposal = recommendationToProposalInput(doc, doc.recommendations[0]!);
    expect(proposal.target).toBe('marketLeasing.MF_2B2B.marketRent');
    expect(proposal.value).toBe('2250');
    expect(proposal.valueType).toBe('decimal');
    expect(proposal.confidence).toBe(0.85);
  });

  it('resolves every citation into self-contained evidence, not just an id', () => {
    const doc = research();
    const proposal = recommendationToProposalInput(doc, doc.recommendations[0]!);
    const evidence = proposal.evidence as Record<string, unknown>;

    expect(evidence.methodology).toContain('Comparable-set median');

    const sources = evidence.sources as Array<Record<string, unknown>>;
    expect(sources).toHaveLength(2);
    expect(sources.map((s) => s.kind).sort()).toEqual(['listing_url', 'test1']);

    const comparisons = evidence.comparisons as Array<Record<string, unknown>>;
    expect(comparisons).toHaveLength(1);
    expect(comparisons[0]?.metric).toBe('rent');
    expect((comparisons[0]?.stats as Record<string, unknown>).median).toBe('2275');

    const modelEstimates = evidence.modelEstimates as Array<Record<string, unknown>>;
    expect(modelEstimates).toHaveLength(1);
    expect(modelEstimates[0]?.model).toBe('mf-rent-v3');
  });

  it('names the source by the model that produced it, when one did', () => {
    const doc = research();
    const proposal = recommendationToProposalInput(doc, doc.recommendations[0]!);
    expect(proposal.sourceName).toContain('mf-rent-v3');
  });

  it('names the source by whatever was cited when no model was used', () => {
    const doc = research({
      recommendations: [
        {
          target: 'valuation.discountRate',
          value: '0.08',
          valueType: 'decimal',
          methodology: 'Stated in the listing brochure.',
          sourceIds: ['src-listing'],
          comparisonIds: [],
          modelEstimateIds: [],
        },
      ],
    });
    const proposal = recommendationToProposalInput(doc, doc.recommendations[0]!);
    expect(proposal.sourceName).toContain('Listing');
    expect(proposal.evidence).not.toHaveProperty('modelEstimates.0');
  });

  it('still converts a recommendation that cites nothing, rather than refusing it', () => {
    const doc = research({
      recommendations: [
        {
          target: 'valuation.discountRate',
          value: '0.08',
          valueType: 'decimal',
          methodology: 'Analyst judgment; no supporting data available yet.',
        },
      ],
    });
    const proposal = recommendationToProposalInput(doc, doc.recommendations[0]!);
    expect(proposal.sourceName).toBe('Property research — Example Apartments');
    expect((proposal.evidence as Record<string, unknown>).sources).toEqual([]);
  });

  it('carries a null-valued, remark-only recommendation through unchanged', () => {
    const doc = research({
      recommendations: [
        {
          target: 'vacancy.generalVacancyRate',
          value: null,
          valueType: 'decimal',
          methodology: 'Insufficient comparable data for a numeric recommendation yet.',
        },
      ],
    });
    const proposal = recommendationToProposalInput(doc, doc.recommendations[0]!);
    expect(proposal.value).toBeNull();
  });

  it('converts every recommendation in a document, in order', () => {
    const doc = research({
      recommendations: [
        { target: 'valuation.discountRate', value: '0.08', valueType: 'decimal', methodology: 'A' },
        {
          target: 'vacancy.generalVacancyRate',
          value: '0.05',
          valueType: 'decimal',
          methodology: 'B',
        },
      ],
    });
    const proposals = recommendationsToProposalInputs(doc);
    expect(proposals.map((p) => p.target)).toEqual([
      'valuation.discountRate',
      'vacancy.generalVacancyRate',
    ]);
    expect(proposals.every((p) => p.sourceKind === 'recommended')).toBe(true);
  });
});

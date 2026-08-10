import type { AssumptionProposalInput } from './assumption-proposals.js';
import type {
  CrePropertyResearch,
  ModelEstimate,
  ResearchComparison,
  ResearchRecommendation,
  ResearchSource,
} from './cre-property-research.js';

/**
 * The one place research becomes underwriting.
 *
 * Everything in `cre-property-research.ts` — observations, comparisons,
 * model estimates — is evidence. A `ResearchRecommendation` is the only kind
 * of entry in that format shaped like something test2 can act on, and this
 * file's only job is turning one into an `AssumptionProposalInput`: the
 * exact same shape a market-data service or an imported document already
 * posts through `POST /models/:id/assumption-proposals` (see
 * `docs/assumption-contract.md`).
 *
 * This is deliberately the **entire** integration. There is no new write
 * path here, no new table, no new decision route. A converted recommendation
 * goes through `recordAssumptionProposals` and is accepted or rejected by an
 * analyst exactly like every other proposal always has been — the
 * conversion changes what a proposal is *about*, never what happens to one.
 * `sourceKind` is always `'recommended'`: a comparable set's median is
 * evidence, not a claim about what the property is worth, and the source
 * kind says so.
 */

const SOURCE_KIND_LABEL: Record<ResearchSource['kind'], string> = {
  listing_url: 'Listing',
  address_lookup: 'Address lookup',
  document: 'Document',
  test1: 'test1',
  test3: 'test3',
  historical: 'Historical data',
  analyst: 'Analyst',
};

/**
 * Converts one recommendation into the shape the existing assumption-proposal
 * contract accepts, resolving its cited sources, comparisons and model
 * estimates into a self-contained evidence object — so the existing
 * Provenance screen, which already renders a proposal's `evidence` as given,
 * needs no change to show a research-derived proposal's working.
 *
 * Refuses nothing: a recommendation that cites nothing still converts, with
 * thin evidence, because a source's own reasoning being missing is a fact an
 * analyst should see on the proposal, not a reason to silently drop it.
 */
export function recommendationToProposalInput(
  research: CrePropertyResearch,
  recommendation: ResearchRecommendation,
): AssumptionProposalInput {
  const sources = resolveSources(research, recommendation.sourceIds);
  const comparisons = resolveComparisons(research, recommendation.comparisonIds);
  const modelEstimates = resolveModelEstimates(research, recommendation.modelEstimateIds);

  return {
    target: recommendation.target,
    value: recommendation.value === null ? null : String(recommendation.value),
    valueType: recommendation.valueType,
    sourceKind: 'recommended',
    sourceName: describeSourceName(research.subject.name, sources, modelEstimates),
    confidence: recommendation.confidence ?? null,
    evidence: {
      methodology: recommendation.methodology,
      subject: research.subject.address ?? research.subject.name ?? null,
      sources: sources.map((source) => ({
        kind: source.kind,
        name: source.name ?? null,
        url: source.url ?? null,
        documentName: source.documentName ?? null,
        retrievedAt: source.retrievedAt ?? null,
      })),
      comparisons: comparisons.map((comparison) => ({
        metric: comparison.metric,
        unitType: comparison.unitType ?? null,
        subjectValue: comparison.subjectValue ?? null,
        stats: comparison.stats,
        subjectPercentile: comparison.subjectPercentile ?? null,
        premiumToMedian: comparison.premiumToMedian ?? null,
        geography: comparison.geography,
        coverage: comparison.coverage,
      })),
      modelEstimates: modelEstimates.map((estimate) => ({
        target: estimate.target,
        estimate: estimate.estimate,
        unit: estimate.unit ?? null,
        model: estimate.model,
        trainingPeriod: estimate.trainingPeriod ?? null,
        confidence: estimate.confidence ?? null,
        drivers: estimate.drivers,
      })),
    },
    notes: recommendation.notes ?? null,
  };
}

/** Converts every recommendation in a document at once, in document order. */
export function recommendationsToProposalInputs(
  research: CrePropertyResearch,
): AssumptionProposalInput[] {
  return research.recommendations.map((recommendation) =>
    recommendationToProposalInput(research, recommendation),
  );
}

function resolveSources(research: CrePropertyResearch, ids: string[]): ResearchSource[] {
  const wanted = new Set(ids);
  return research.sources.filter((source) => wanted.has(source.id));
}

function resolveComparisons(research: CrePropertyResearch, ids: string[]): ResearchComparison[] {
  const wanted = new Set(ids);
  return research.comparisons.filter((comparison) => comparison.id && wanted.has(comparison.id));
}

function resolveModelEstimates(research: CrePropertyResearch, ids: string[]): ModelEstimate[] {
  const wanted = new Set(ids);
  return research.modelEstimates.filter((estimate) => estimate.id && wanted.has(estimate.id));
}

/**
 * Names the proposal the way an analyst reads a source: by the model that
 * produced the number when there is one, else by whatever was cited, else
 * plainly as research with nothing more specific to say.
 */
function describeSourceName(
  subjectName: string | null | undefined,
  sources: ResearchSource[],
  modelEstimates: ModelEstimate[],
): string {
  if (modelEstimates.length > 0) {
    const models = [...new Set(modelEstimates.map((estimate) => estimate.model))];
    return `Property research — ${models.join(', ')}`;
  }
  if (sources.length > 0) {
    const names = [
      ...new Set(sources.map((source) => source.name ?? SOURCE_KIND_LABEL[source.kind])),
    ];
    return `Property research — ${names.join(', ')}`;
  }
  return subjectName ? `Property research — ${subjectName}` : 'Property research';
}

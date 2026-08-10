import { z } from 'zod';
import {
  assumptionTargetSchema,
  assumptionValueTypeEnum,
  validateTypedValue,
} from './assumption-proposals.js';

/**
 * `cre-property-research`, version 1.
 *
 * The interchange format for **research about a subject property** — what a
 * listing page said, what nearby rents look like, what a statistical model
 * estimates — as distinct from `cre-assumption-import`, which is one
 * document's worth of assumptions extracted for a specific model already
 * open in this platform. See `docs/property-research.md` for the
 * architecture this sits inside and, importantly, for what is a live
 * pipeline today versus a contract with nothing behind it yet.
 *
 * ## Why this is a second format rather than a bigger `cre-assumption-import`
 *
 * `cre-assumption-import` answers one question: *what does this document say
 * about the model I have open*. Its `assumptions` are already addressed at
 * real, writable test2 targets, because the whole point of that pipeline is
 * "paste, review, apply" against a single model.
 *
 * Research answers a different, earlier question: *what do I know about this
 * property, before I have decided what any of it means for an underwriting*.
 * A nearby comparable's rent is not a test2 target — nothing about it is
 * ever applied — it is evidence that might support a *recommendation*, which
 * is the only thing here shaped like a `cre-assumption-import` assumption.
 * Collapsing the two formats would either force every research fact to
 * pretend it addresses a model field it does not, or force
 * `cre-assumption-import` to carry a research-evidence graph it does not
 * need. Two formats, one converging on the other at exactly one point (see
 * `research-to-proposal.ts`), keeps each one honest about what it is.
 *
 * ## The four kinds of thing this format holds, and why they cannot merge
 *
 * - **Observation** — a fact a source stated. A listing's asking rent, an
 *   OM's stated occupancy, a nearby unit's advertised rent. Never authoritative
 *   for underwriting on its own.
 * - **Comparison** — a deterministic statistic computed from observations:
 *   a median, a percentile, a premium or discount. Still not a
 *   recommendation — it describes the data, not what to do about it.
 * - **Model estimate** — the output of a statistical or economic model (a
 *   test3-shaped result). An opinion, clearly labelled as one, with its own
 *   model name and version.
 * - **Recommendation** — the only kind of entry here that can become a
 *   test2 assumption proposal. It has to cite what it is based on.
 *
 * A reader who cannot tell which of these four they are looking at cannot
 * tell whether a number is a fact, a statistic, a model's opinion, or a
 * suggestion — which is exactly the ambiguity this format exists to remove.
 * See §6 of the milestone note this format was built from: asking rent,
 * market observation, recommended rent and underwritten rent must never
 * collapse into one field.
 */

export const CRE_PROPERTY_RESEARCH_FORMAT = 'cre-property-research';
export const CRE_PROPERTY_RESEARCH_VERSION = 1;

/* -------------------------------------------------------------------------- */
/* Subject identity                                                           */
/* -------------------------------------------------------------------------- */

/**
 * What is being researched.
 *
 * Deliberately over-specified relative to what any one source can supply,
 * because identity resolution's whole job is triangulating from partial
 * information — a listing gives an address and a name, an address lookup
 * gives a parcel and a county, and neither alone is a stable identifier.
 * `name` is explicitly **not** load-bearing: "Park Place Apartments" is not
 * unique, and nothing here treats it as one. `modelId`, when present, is
 * what actually pins this research to a test2 model — everything else is
 * for finding or confirming that model, or for research that has no model
 * yet.
 */
export const researchSubjectSchema = z.object({
  name: z.string().max(300).nullish(),
  address: z.string().max(500).nullish(),
  /** The address as a lookup source normalised it, when one did. */
  standardizedAddress: z.string().max(500).nullish(),
  city: z.string().max(200).nullish(),
  state: z.string().max(100).nullish(),
  zip: z.string().max(20).nullish(),
  county: z.string().max(200).nullish(),
  latitude: z.number().min(-90).max(90).nullish(),
  longitude: z.number().min(-180).max(180).nullish(),
  /** A real parcel identifier from an assessor or GIS source — never invented. */
  parcelId: z.string().max(100).nullish(),
  assetType: z.string().max(100).nullish(),
  /** test1's own identifier for this property, when test1 has resolved one. */
  test1PropertyId: z.string().max(100).nullish(),
  /** The test2 model this research is attached to, when it is attached to one. */
  modelId: z.string().uuid().nullish(),
});
export type ResearchSubject = z.infer<typeof researchSubjectSchema>;

/* -------------------------------------------------------------------------- */
/* Sources                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Where a piece of research came from.
 *
 * `listing_url` and `document` both name an external Skill's output, the
 * same separation `cre-assumption-import` already draws: this platform
 * never fetches a URL or opens a document itself. `test1` and `test3` name
 * the two sibling systems in the architecture — see `research-interfaces.ts`
 * for the contracts they would satisfy; neither is wired up to a live
 * endpoint from this repository today.
 */
export const researchSourceKindEnum = z.enum([
  'listing_url',
  'address_lookup',
  'document',
  'test1',
  'test3',
  'historical',
  'analyst',
]);
export type ResearchSourceKind = z.infer<typeof researchSourceKindEnum>;

export const researchSourceSchema = z.object({
  /** Referenced by `sourceIds` on observations, comparisons and estimates below. */
  id: z.string().min(1).max(60),
  kind: researchSourceKindEnum,
  name: z.string().max(200).nullish(),
  url: z.string().max(2000).nullish(),
  documentName: z.string().max(300).nullish(),
  /** When this platform (or the Skill that fed it) retrieved the source. */
  retrievedAt: z.string().datetime().nullish(),
  notes: z.string().max(2000).nullish(),
});
export type ResearchSource = z.infer<typeof researchSourceSchema>;

/* -------------------------------------------------------------------------- */
/* Observations                                                                */
/* -------------------------------------------------------------------------- */

/**
 * One fact, as a source stated it.
 *
 * `metric` is deliberately free text rather than a `cre-assumption-import`
 * target: a comparable unit's rent is not a field of any test2 model, and
 * validating it against the target registry would be validating it against
 * the wrong thing. It is namespaced by convention (`listing.askingRent`,
 * `comp.rent`, `market.medianRent2Bed`) so a reader can group observations
 * without this schema enforcing a closed vocabulary research has not
 * finished growing.
 */
export const researchObservationSchema = z
  .object({
    id: z.string().min(1).max(60).nullish(),
    sourceId: z.string().min(1).max(60),
    metric: z.string().min(1).max(200),
    value: z.union([z.string(), z.number(), z.boolean()]).nullable(),
    valueType: assumptionValueTypeEnum,
    unit: z.string().max(60).nullish(),
    displayValue: z.string().max(200).nullish(),
    /**
     * When the fact was true, not when it was retrieved — a rent observed
     * eighteen months ago and one from yesterday are not the same kind of
     * evidence, and nothing here is allowed to imply otherwise by omission.
     */
    observedAt: z.string().datetime().nullish(),
    /** e.g. "2bed_2bath", for a multifamily rent or unit-level fact. */
    unitType: z.string().max(60).nullish(),
    geography: z.string().max(200).nullish(),
    notes: z.string().max(2000).nullish(),
  })
  .superRefine((observation, ctx) => {
    if (observation.value === null || observation.value === undefined) return;
    const problem = validateTypedValue(String(observation.value), observation.valueType);
    if (problem) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['value'], message: problem });
  });
export type ResearchObservation = z.infer<typeof researchObservationSchema>;

/* -------------------------------------------------------------------------- */
/* Comparisons                                                                 */
/* -------------------------------------------------------------------------- */

export const researchGeographySchema = z.object({
  type: z.enum(['radius', 'block', 'neighborhood', 'zip', 'submarket', 'city', 'county']),
  /** The radius distance, when `type` is `radius`. */
  value: z.number().min(0).nullish(),
  unit: z.enum(['mile', 'km']).nullish(),
  label: z.string().max(200).nullish(),
});
export type ResearchGeography = z.infer<typeof researchGeographySchema>;

/**
 * What a comparison's sample actually consists of, stated rather than
 * implied. "Lowest observed comparable rent" only means something next to
 * how many observations, over what dates, in what area — see §12 and §33 of
 * the milestone note this format was built from.
 */
export const researchCoverageSchema = z.object({
  sampleCount: z.number().int().min(0),
  propertyCount: z.number().int().min(0).nullish(),
  dateRangeStart: z.string().nullish(),
  dateRangeEnd: z.string().nullish(),
  medianObservationAgeDays: z.number().min(0).nullish(),
  /** Observations considered and left out, and why — never silently dropped. */
  exclusions: z
    .array(z.object({ count: z.number().int().min(1), reason: z.string().min(1).max(500) }))
    .default([]),
  limitations: z.array(z.string().max(500)).default([]),
});
export type ResearchCoverage = z.infer<typeof researchCoverageSchema>;

const sampleStatsSchema = z.object({
  count: z.number().int().min(0),
  min: z.string().nullish(),
  p25: z.string().nullish(),
  median: z.string().nullish(),
  p75: z.string().nullish(),
  max: z.string().nullish(),
});
export type SampleStats = z.infer<typeof sampleStatsSchema>;

/**
 * A subject-vs-market statistical position — descriptive statistics over a
 * comparable set, never a judgement about what the subject *should* be.
 * Deliberately does not compute anything itself; this schema is the shape a
 * (future, deterministic) comparable-selection engine would fill in, kept
 * separate from that engine the same way `cre-assumption-import`'s schema
 * is kept separate from `assumption-import-analyze.ts`.
 */
export const researchComparisonSchema = z.object({
  id: z.string().min(1).max(60).nullish(),
  metric: z.string().min(1).max(200),
  unitType: z.string().max(60).nullish(),
  subjectValue: z.string().nullish(),
  stats: sampleStatsSchema,
  subjectPercentile: z.number().min(0).max(100).nullish(),
  /** Signed decimal fraction: subject vs. median, e.g. "-0.055" for -5.5%. */
  premiumToMedian: z.string().nullish(),
  geography: researchGeographySchema,
  coverage: researchCoverageSchema,
  sourceIds: z.array(z.string().min(1)).default([]),
  notes: z.string().max(2000).nullish(),
});
export type ResearchComparison = z.infer<typeof researchComparisonSchema>;

/* -------------------------------------------------------------------------- */
/* Model estimates (test3-shaped)                                             */
/* -------------------------------------------------------------------------- */

/**
 * A statistical or economic model's output — test3's contract, restated
 * here as the shape this format accepts one in. See `research-interfaces.ts`
 * for the same shape as test3's own response contract; the two are
 * deliberately identical so a test3 response can be dropped into
 * `modelEstimates` without translation.
 */
export const modelEstimateSchema = z.object({
  id: z.string().min(1).max(60).nullish(),
  /** The research metric this estimates, e.g. "market_rent", "rent_growth", "vacancy". */
  target: z.string().min(1).max(200),
  estimate: z.string(),
  unit: z.string().max(60).nullish(),
  /** Model name and version, e.g. "mf-rent-v3". Never omitted — an unnamed model cannot be weighed. */
  model: z.string().min(1).max(200),
  trainingPeriod: z.string().max(200).nullish(),
  confidence: z
    .object({
      low: z.string().nullish(),
      high: z.string().nullish(),
      level: z.number().min(0).max(1).nullish(),
    })
    .nullish(),
  drivers: z
    .array(z.object({ factor: z.string().min(1).max(200), effect: z.string().max(500).nullish() }))
    .default([]),
  sourceIds: z.array(z.string().min(1)).default([]),
  notes: z.string().max(2000).nullish(),
});
export type ModelEstimate = z.infer<typeof modelEstimateSchema>;

/* -------------------------------------------------------------------------- */
/* Recommendations — the only entry that can become a test2 proposal          */
/* -------------------------------------------------------------------------- */

/**
 * An explicit, proposed test2 assumption — reusing `cre-assumption-import`'s
 * own `target`/`value`/`valueType` shape on purpose, because this is exactly
 * what `research-to-proposal.ts` converts into an
 * `AssumptionProposalInput`. `methodology` is required and free text: a
 * recommendation that cannot say how it was derived is not a recommendation,
 * it is a guess wearing one's clothes.
 */
export const researchRecommendationSchema = z
  .object({
    id: z.string().min(1).max(60).nullish(),
    target: assumptionTargetSchema,
    value: z.union([z.string(), z.number(), z.boolean()]).nullable(),
    valueType: assumptionValueTypeEnum,
    unit: z.string().max(60).nullish(),
    displayValue: z.string().max(200).nullish(),
    /** How sure the recommendation is — not a claim about the underlying data's precision. */
    confidence: z.number().min(0).max(1).nullish(),
    methodology: z.string().min(1).max(2000),
    sourceIds: z.array(z.string().min(1)).default([]),
    comparisonIds: z.array(z.string().min(1)).default([]),
    modelEstimateIds: z.array(z.string().min(1)).default([]),
    notes: z.string().max(2000).nullish(),
  })
  .superRefine((recommendation, ctx) => {
    if (recommendation.value === null || recommendation.value === undefined) return;
    const problem = validateTypedValue(String(recommendation.value), recommendation.valueType);
    if (problem) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['value'], message: problem });
  });
export type ResearchRecommendation = z.infer<typeof researchRecommendationSchema>;

/* -------------------------------------------------------------------------- */
/* The envelope                                                               */
/* -------------------------------------------------------------------------- */

export const crePropertyResearchSchema = z.object({
  format: z.literal(CRE_PROPERTY_RESEARCH_FORMAT),
  version: z.literal(CRE_PROPERTY_RESEARCH_VERSION),
  subject: researchSubjectSchema.default({}),
  sources: z.array(researchSourceSchema).max(50).default([]),
  observations: z.array(researchObservationSchema).max(2000).default([]),
  comparisons: z.array(researchComparisonSchema).max(200).default([]),
  modelEstimates: z.array(modelEstimateSchema).max(200).default([]),
  recommendations: z.array(researchRecommendationSchema).max(200).default([]),
});
export type CrePropertyResearch = z.infer<typeof crePropertyResearchSchema>;
export type CrePropertyResearchInput = z.input<typeof crePropertyResearchSchema>;

export interface ParsedPropertyResearch {
  ok: true;
  data: CrePropertyResearch;
}
export interface RejectedPropertyResearch {
  ok: false;
  error: string;
}

/**
 * Turns pasted text into a validated `cre-property-research` document, or
 * explains in plain language why it could not.
 *
 * Deliberately the same tolerance as `parseImportPayload`, and no more: one
 * surrounding Markdown fence and outer whitespace, nothing else repaired.
 * See that function's doc comment for why — the reasoning is identical and
 * is not restated here.
 */
export function parsePropertyResearchPayload(
  raw: string,
): ParsedPropertyResearch | RejectedPropertyResearch {
  const stripped = stripSurroundingFence(raw);
  if (stripped.trim().length === 0) {
    return {
      ok: false,
      error: 'Paste the research output before analyzing — nothing was found.',
    };
  }

  let json: unknown;
  try {
    json = JSON.parse(stripped);
  } catch {
    return {
      ok: false,
      error:
        'The pasted text is not valid JSON. Paste the research output exactly as given, ' +
        'including the outer braces — nothing here was changed by hand.',
    };
  }

  if (typeof json !== 'object' || json === null || Array.isArray(json)) {
    return {
      ok: false,
      error:
        'The pasted JSON is not an object. A cre-property-research document is a single object.',
    };
  }

  const candidate = json as Record<string, unknown>;
  if (candidate.format !== CRE_PROPERTY_RESEARCH_FORMAT) {
    return {
      ok: false,
      error:
        `The pasted text does not contain a "${CRE_PROPERTY_RESEARCH_FORMAT}" document. Its ` +
        `"format" field is ${
          candidate.format === undefined ? 'missing' : JSON.stringify(candidate.format)
        }, not "${CRE_PROPERTY_RESEARCH_FORMAT}".`,
    };
  }
  if (candidate.version !== CRE_PROPERTY_RESEARCH_VERSION) {
    return {
      ok: false,
      error:
        `This release reads ${CRE_PROPERTY_RESEARCH_FORMAT} version ${CRE_PROPERTY_RESEARCH_VERSION}. ` +
        `The pasted document is version ${
          candidate.version === undefined ? '(missing)' : JSON.stringify(candidate.version)
        }, which is not read the same way and is refused rather than guessed at.`,
    };
  }

  const result = crePropertyResearchSchema.safeParse(candidate);
  if (!result.success) {
    const [first] = result.error.issues;
    const path = first?.path.join('.') || '(document)';
    return {
      ok: false,
      error: `${path}: ${first?.message ?? 'failed validation'}.`,
    };
  }

  return { ok: true, data: result.data };
}

/** Strips exactly one surrounding ```` ``` ```` or ```` ```json ```` fence, and outer whitespace. */
function stripSurroundingFence(raw: string): string {
  const trimmed = raw.trim();
  const fenced = /^```(?:json)?\s*\n?([\s\S]*?)\n?```$/i.exec(trimmed);
  return fenced ? (fenced[1] as string).trim() : trimmed;
}

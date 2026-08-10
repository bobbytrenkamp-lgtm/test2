import { z } from 'zod';
import { researchGeographySchema } from './cre-property-research.js';

/**
 * Contracts for systems this repository does not contain.
 *
 * `test1` (geographic, parcel and raw market observations) and `test3`
 * (statistical and economic modelling) are sibling systems in the wider
 * architecture, not code that lives in `test2`. Nothing in this file calls
 * either one — there is no HTTP client here, no fetch, no live integration.
 * What this file specifies is the **shape** an eventual test1 response or a
 * research request has to satisfy to be usable by test2, so that when those
 * systems exist, the boundary between "test2's problem" and "test1 or
 * test3's problem" has already been drawn rather than improvised at
 * integration time.
 *
 * See `docs/property-research.md` for which parts of this architecture are
 * live today (none of the cross-repository parts) versus designed only
 * (this file, and `cre-property-research.ts`).
 *
 * ## Why this belongs in `@cre/domain-models` at all
 *
 * A contract with no implementation on either side is still worth writing
 * down in code rather than prose: it is checked by the compiler wherever it
 * is referenced, and a test1 response that does not fit this shape fails a
 * type error the day someone tries to plug it in, rather than an incident
 * months after a silent mismatch shipped.
 */

/* -------------------------------------------------------------------------- */
/* The universal research request                                            */
/* -------------------------------------------------------------------------- */

/**
 * What research to run about what subject — the request an orchestration
 * layer (§21/§23 of the milestone note this was built from) would eventually
 * accept from the "Research this property" action. `research` names which
 * lines of inquiry to run rather than being open-ended, so a caller states
 * intent rather than the orchestrator guessing what an empty request wants.
 *
 * Not every value here is wired to anything yet — see
 * `docs/property-research.md`'s status table. The type exists so the
 * eventual orchestrator, the eventual "Research this property" UI action,
 * and any Claude Skill built against it are typed against the same shape
 * from day one, rather than three shapes that drift.
 */
export const researchLineEnum = z.enum([
  'property_identity',
  'multifamily_rents',
  'market_rent',
  'rent_growth',
  'vacancy',
]);
export type ResearchLine = z.infer<typeof researchLineEnum>;

export const researchRequestSchema = z.object({
  subject: z.object({
    url: z.string().max(2000).nullish(),
    address: z.string().max(500).nullish(),
    latitude: z.number().min(-90).max(90).nullish(),
    longitude: z.number().min(-180).max(180).nullish(),
    /** A test2 model this research should attach to, when researching from one. */
    modelId: z.string().uuid().nullish(),
  }),
  assetType: z.string().max(100).nullish(),
  research: z.array(researchLineEnum).min(1).max(20),
  geography: researchGeographySchema.nullish(),
});
export type ResearchRequest = z.infer<typeof researchRequestSchema>;

/* -------------------------------------------------------------------------- */
/* The test1 research interface                                              */
/* -------------------------------------------------------------------------- */

/**
 * What test2 or test3 would ask test1 for, given a resolved or partial
 * subject. Coordinates, an address or a parcel — whichever identity
 * resolution has managed to establish so far; test1's own job includes
 * refining a partial identity, not requiring a complete one up front.
 */
export const test1ResearchRequestSchema = z.object({
  address: z.string().max(500).nullish(),
  latitude: z.number().min(-90).max(90).nullish(),
  longitude: z.number().min(-180).max(180).nullish(),
  parcelId: z.string().max(100).nullish(),
  assetType: z.string().max(100).nullish(),
  geography: researchGeographySchema.nullish(),
  research: z.array(researchLineEnum).min(1).max(20),
});
export type Test1ResearchRequest = z.infer<typeof test1ResearchRequestSchema>;

/**
 * What test1 would answer with — resolved subject identity, whatever raw
 * observations it holds for that request, and an honest statement of what
 * the response does and does not cover.
 *
 * Deliberately data, not test2 UI and not test2 database rows (§37 of the
 * milestone note): a `subject` and a list of `observations` in the same
 * shape `cre-property-research.ts` already defines, plus `coverage` in
 * that same schema's shape, so a test1 response can be dropped directly
 * into a `cre-property-research` document's `subject`/`observations`
 * fields without a translation step.
 */
export const test1ResearchResponseSchema = z.object({
  subject: z.object({
    standardizedAddress: z.string().max(500).nullish(),
    city: z.string().max(200).nullish(),
    state: z.string().max(100).nullish(),
    zip: z.string().max(20).nullish(),
    county: z.string().max(200).nullish(),
    latitude: z.number().min(-90).max(90).nullish(),
    longitude: z.number().min(-180).max(180).nullish(),
    parcelId: z.string().max(100).nullish(),
    test1PropertyId: z.string().max(100).nullish(),
  }),
  /** Free-form, namespaced facts in the same shape as `researchObservationSchema`. */
  observations: z
    .array(
      z.object({
        metric: z.string().min(1).max(200),
        value: z.union([z.string(), z.number(), z.boolean()]).nullable(),
        valueType: z.enum(['decimal', 'integer', 'date', 'boolean', 'string', 'enum']),
        unit: z.string().max(60).nullish(),
        observedAt: z.string().datetime().nullish(),
        unitType: z.string().max(60).nullish(),
        geography: z.string().max(200).nullish(),
      }),
    )
    .max(5000)
    .default([]),
  coverage: z
    .object({
      sampleCount: z.number().int().min(0),
      propertyCount: z.number().int().min(0).nullish(),
      dateRangeStart: z.string().nullish(),
      dateRangeEnd: z.string().nullish(),
      limitations: z.array(z.string().max(500)).default([]),
    })
    .nullish(),
  source: z.object({
    system: z.literal('test1'),
    version: z.string().max(60).nullish(),
    respondedAt: z.string().datetime().nullish(),
  }),
});
export type Test1ResearchResponse = z.infer<typeof test1ResearchResponseSchema>;

/* -------------------------------------------------------------------------- */
/* The test3 recommendation interface                                        */
/* -------------------------------------------------------------------------- */

/**
 * Re-exported rather than redefined: test3's output contract **is**
 * `ModelEstimate`, the same shape `cre-property-research.ts`'s
 * `modelEstimates` array holds. A test3 response can be appended to that
 * array with no translation. See that file's `modelEstimateSchema` for the
 * shape and why every field on it exists.
 */
export { modelEstimateSchema as test3RecommendationSchema } from './cre-property-research.js';
export type { ModelEstimate as Test3Recommendation } from './cre-property-research.js';

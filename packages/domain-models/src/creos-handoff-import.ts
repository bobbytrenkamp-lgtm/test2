import { z } from 'zod';
import { CreosUlidSchema } from './creos-ids.js';
import type {
  CreAssumptionImport,
  ExtractionMethod,
  ImportFieldAssumption,
} from './cre-assumption-import.js';

/**
 * `creos-handoff-v1` (Phase 5: SiteIntel -> Underwrite handoff, receiving
 * side).
 *
 * The authoritative schema for this contract lives in the CREOS Enterprise
 * repository (`src/domain/handoff.ts`, `property.ts`, `assumption.ts`) — no
 * shared package exists between these independently deployed applications,
 * so this file ports the validation rules this app actually needs to check
 * by hand, the same pattern already established for `creos-ids.ts`. This is
 * NOT a full reimplementation of that repository's schema (no referential-
 * integrity check across `sources[]`/`provenance[]`, since Phase 5's
 * SiteIntel producer — see that repo's `js/parcel/handoff.js` — never
 * populates those arrays); it validates exactly the surface this module
 * reads, and fails closed (rejects, does not guess) on anything it doesn't
 * recognize, matching this project's own governance conventions.
 *
 * ## What this module does NOT do
 *
 * It does not write anything anywhere. `translateSiteIntelHandoff` is a
 * pure function producing a `cre-assumption-import` v1 document (see
 * `cre-assumption-import.ts`) — from there, the translated document goes
 * through the exact same `analyzeImport` / accept-by-hand path any other
 * import does. A SiteIntel observation reaches `assumption_proposals` only
 * if an analyst explicitly accepts it there, same as a person-posted
 * proposal or a Claude Skill's PDF extraction.
 *
 * ## Why every SiteIntel fact lands as "unsupported", not "new"/"changed"
 *
 * SiteIntel's `observed` block (see that repo's
 * `js/parcel/site-intelligence.js` — `toUnderwritingInputs()`) is
 * deliberately never underwriting *inputs*: assessed value is explicitly
 * not a purchase price, a prior sale is explicitly not a future one, and
 * SiteIntel refuses outright to supply `acquisition_price` (see that
 * repository's `assumptions_required` block, which this translator never
 * reads — it is nulls-with-reasons by design and this app has no
 * corresponding field to put a fabricated value in regardless). None of
 * `assumption-targets.ts`'s real targets (`valuation.*`, `vacancy.*`, the
 * various collections) describe a zoning code, a tax-assessed value, or a
 * parcel's acreage — there is no model field these facts could correctly
 * overwrite. So every `siteIntel.*` target this module produces resolves
 * to `status: 'unsupported'` in the analyzer, which is the *correct*
 * outcome, not a gap to route around: `assumption-proposals.ts`'s own
 * module doc says a proposal whose target this release cannot locate
 * "is still shown to the analyst... silently dropping it would be the
 * worst of the options." That is exactly SiteIntel's situation here —
 * these are informational context for a human decision, never something
 * this app should offer to auto-apply.
 */

const CONFIDENCE_LEVELS = ['low', 'medium', 'high', 'verified'] as const;
const SOURCE_TYPES = ['user', 'observed', 'modeled', 'document', 'calculated', 'derived'] as const;
const VALUE_TYPES = ['number', 'decimalString', 'string', 'boolean', 'date'] as const;
const MODULE_IDS = ['creos', 'siteintel', 'underwrite', 'marketsignal'] as const;

const HandoffAssumptionSchema = z
  .object({
    assumptionId: CreosUlidSchema,
    name: z.string().min(1),
    category: z.string().min(1),
    unit: z.string().min(1).optional(),
    valueType: z.enum(VALUE_TYPES),
    value: z.union([z.number(), z.string(), z.boolean()]),
    sourceType: z.enum(SOURCE_TYPES),
    sourceModule: z.enum(MODULE_IDS),
    status: z.enum(['proposed', 'accepted', 'overridden', 'rejected']),
    confidence: z.enum(CONFIDENCE_LEVELS).optional(),
    methodology: z.string().optional(),
  })
  .passthrough();

const HandoffPropertySchema = z
  .object({
    identity: z
      .object({
        propertyId: CreosUlidSchema,
        propertyName: z.string().min(1),
      })
      .passthrough(),
    classification: z
      .object({ propertyType: z.string().min(1), subtype: z.string().optional() })
      .partial()
      .passthrough()
      .optional(),
    location: z.object({ latitude: z.number(), longitude: z.number() }).optional(),
    market: z
      .object({ marketId: z.string().optional(), submarket: z.string().optional() })
      .optional(),
  })
  .passthrough();

/**
 * `creos-handoff-v1`'s Underwrite-boundary governance rule, re-checked
 * independently on receipt rather than trusted from the sender: every
 * non-`user` observation/assumption in a payload with
 * `targetModule: 'underwrite'` must be exactly `status: 'proposed'`. A
 * payload claiming a pre-decided value — `accepted`, `overridden`, or
 * `rejected` — is refused outright, the same rule test4's own
 * `HandoffSchema` enforces (see that repo's BUG-007 in `BUG_TRACKER.md`).
 * This is not redundant with that repository checking it first: this app
 * has no way to know the sender actually ran that validation, and a
 * boundary this project treats as a real governance control has to hold
 * even against a hand-edited or buggy producer, not just a well-behaved
 * one.
 */
export const CreosHandoffV1Schema = z
  .object({
    schemaVersion: z.literal('creos-handoff-v1'),
    handoffId: CreosUlidSchema,
    createdAt: z.string().datetime({ offset: true }),
    sourceModule: z.enum(MODULE_IDS),
    targetModule: z.enum(MODULE_IDS),
    property: HandoffPropertySchema.optional(),
    observations: z.array(HandoffAssumptionSchema).default([]),
    assumptions: z.array(HandoffAssumptionSchema).default([]),
  })
  .passthrough()
  .superRefine((handoff, ctx) => {
    if (handoff.targetModule !== 'underwrite') return;
    for (const [key, list] of [
      ['observations', handoff.observations],
      ['assumptions', handoff.assumptions],
    ] as const) {
      list.forEach((item, index) => {
        if (item.sourceType !== 'user' && item.status !== 'proposed') {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: [key, index, 'status'],
            message:
              `A handoff targeting underwrite cannot carry a ${item.sourceType} assumption as ` +
              `"${item.status}" — cross-module assumptions must arrive proposed.`,
          });
        }
      });
    }
  });
export type CreosHandoffV1 = z.infer<typeof CreosHandoffV1Schema>;
export type CreosHandoffAssumption = z.infer<typeof HandoffAssumptionSchema>;

export interface ParsedHandoff {
  ok: true;
  data: CreosHandoffV1;
}
export interface RejectedHandoff {
  ok: false;
  /** An analyst-facing explanation — never a raw parser or zod error. Mirrors `cre-assumption-import.ts`'s `parseImportPayload`. */
  error: string;
}

/**
 * Parses and validates a raw `creos-handoff-v1` JSON file. Fails closed:
 * any parse error, schema mismatch, or governance violation is refused
 * with an analyst-facing message rather than partially accepted.
 */
export function parseCreosHandoffPayload(raw: string): ParsedHandoff | RejectedHandoff {
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return { ok: false, error: 'The selected file is empty.' };
  }

  let json: unknown;
  try {
    json = JSON.parse(trimmed);
  } catch {
    return {
      ok: false,
      error:
        'The selected file is not valid JSON. It should be the .json file SiteIntel downloaded, unmodified.',
    };
  }

  if (typeof json !== 'object' || json === null || Array.isArray(json)) {
    return { ok: false, error: 'A creos-handoff-v1 document is a single JSON object.' };
  }

  const candidate = json as Record<string, unknown>;
  if (candidate.schemaVersion !== 'creos-handoff-v1') {
    return {
      ok: false,
      error:
        'This is not a creos-handoff-v1 document. Its "schemaVersion" is ' +
        `${candidate.schemaVersion === undefined ? 'missing' : JSON.stringify(candidate.schemaVersion)}, ` +
        'not "creos-handoff-v1".',
    };
  }
  if (candidate.targetModule !== 'underwrite') {
    return {
      ok: false,
      error:
        `This handoff targets "${String(candidate.targetModule)}", not "underwrite" — it was not ` +
        'meant to be imported here.',
    };
  }

  const result = CreosHandoffV1Schema.safeParse(candidate);
  if (!result.success) {
    const [first] = result.error.issues;
    const path = first?.path.join('.') || '(document)';
    return { ok: false, error: `${path}: ${first?.message ?? 'failed validation'}.` };
  }

  return { ok: true, data: result.data };
}

const CONFIDENCE_TO_FRACTION: Record<(typeof CONFIDENCE_LEVELS)[number], number> = {
  low: 0.25,
  medium: 0.5,
  high: 0.75,
  verified: 0.95,
};

function slug(name: string): string {
  const cleaned = name
    .replace(/[^A-Za-z0-9]+/g, ' ')
    .trim()
    .split(' ')
    .filter(Boolean);
  if (cleaned.length === 0) return 'value';
  return cleaned
    .map((word, index) =>
      index === 0
        ? word.charAt(0).toLowerCase() + word.slice(1)
        : word.charAt(0).toUpperCase() + word.slice(1),
    )
    .join('');
}

function mapValueType(
  valueType: CreosHandoffAssumption['valueType'],
): 'decimal' | 'string' | 'boolean' | 'date' {
  switch (valueType) {
    case 'number':
    case 'decimalString':
      return 'decimal';
    case 'boolean':
      return 'boolean';
    case 'date':
      return 'date';
    case 'string':
    default:
      return 'string';
  }
}

function translateAssumption(item: CreosHandoffAssumption): ImportFieldAssumption {
  const extraction: { method: ExtractionMethod; derivation: string | null } = {
    method: 'explicit',
    derivation: null,
  };
  return {
    target: `siteIntel.${item.category}.${slug(item.name)}`,
    value: item.value,
    valueType: mapValueType(item.valueType),
    unit: item.unit ?? null,
    displayValue: item.unit ? `${item.value} ${item.unit}` : String(item.value),
    confidence: item.confidence ? CONFIDENCE_TO_FRACTION[item.confidence] : null,
    extraction,
    evidence: item.methodology ? [{ note: item.methodology }] : [],
    notes: null,
  };
}

/**
 * Pure translation: a validated `creos-handoff-v1` document into a
 * `cre-assumption-import` v1 document, so it can flow through the exact
 * same parse -> analyze -> accept-by-hand pipeline any other import does
 * (see this file's module doc for why that is the right amount of new
 * machinery — none — rather than a second review surface).
 */
export function translateSiteIntelHandoff(handoff: CreosHandoffV1): CreAssumptionImport {
  const propertyName = handoff.property?.identity?.propertyName ?? null;
  const stateObservation = handoff.observations.find((o) => o.name === 'State');
  const documentDate = handoff.createdAt.slice(0, 10);

  return {
    format: 'cre-assumption-import',
    version: 1,
    source: {
      kind: 'imported',
      system: 'CREOS SiteIntel',
      skill: null,
      documentName: propertyName
        ? `SiteIntel handoff: ${propertyName}`
        : `SiteIntel handoff ${handoff.handoffId.slice(-8)}`,
      documentDate,
      extractedAt: handoff.createdAt,
    },
    property: {
      name: propertyName,
      assetType: handoff.property?.classification?.propertyType ?? null,
      market: handoff.property?.market?.submarket ?? null,
      state: typeof stateObservation?.value === 'string' ? stateObservation.value : null,
    },
    assumptions: handoff.observations.map(translateAssumption),
    records: [],
  };
}

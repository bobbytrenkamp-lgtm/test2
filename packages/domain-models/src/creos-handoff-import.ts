import { z } from 'zod';
import { CreosUlidSchema } from './creos-ids.js';
import type {
  CreAssumptionImport,
  ExtractionMethod,
  ImportFieldAssumption,
} from './cre-assumption-import.js';

/**
 * `creos-handoff-v1` (Phase 5: SiteIntel -> Underwrite; Phase 6:
 * MarketSignal -> Underwrite — receiving side for both).
 *
 * The authoritative schema for this contract lives in the CREOS Enterprise
 * repository (`src/domain/handoff.ts`, `property.ts`, `assumption.ts`) — no
 * shared package exists between these independently deployed applications,
 * so this file ports the validation rules this app actually needs to check
 * by hand, the same pattern already established for `creos-ids.ts`. This is
 * NOT a full reimplementation of that repository's schema (no referential-
 * integrity check across `sources[]`/`provenance[]`, since neither producer
 * this app has seen so far — test1's `js/parcel/handoff.js`, test3's
 * `src/test3/creos_handoff.py` — populates those arrays); it validates
 * exactly the surface this module reads, and fails closed (rejects, does
 * not guess) on anything it doesn't recognize, matching this project's own
 * governance conventions.
 *
 * ## What this module does NOT do
 *
 * It does not write anything anywhere. `translateCreosHandoff` is a pure
 * function producing a `cre-assumption-import` v1 document (see
 * `cre-assumption-import.ts`) — from there, the translated document goes
 * through the exact same `analyzeImport` / accept-by-hand path any other
 * import does. A handoff fact reaches `assumption_proposals` only if an
 * analyst explicitly accepts it there, same as a person-posted proposal or
 * a Claude Skill's PDF extraction.
 *
 * ## One translator, two source modules, two different outcomes
 *
 * `translateCreosHandoff` dispatches on `handoff.sourceModule` and combines
 * whichever of `observations[]`/`assumptions[]` that source populates
 * (SiteIntel sends raw facts as `observations[]`; MarketSignal sends
 * modeled recommendations as `assumptions[]` — see each producer's own
 * source for why). What differs is target routing:
 *
 * - **SiteIntel** (Phase 5): every fact is deliberately routed to an
 *   informational `siteIntel.<category>.<field>` namespace, never a real
 *   target. Its `observed` block (`js/parcel/site-intelligence.js`'s
 *   `toUnderwritingInputs()`) is never underwriting *input* — assessed
 *   value is explicitly not a purchase price, a prior sale is explicitly
 *   not a future one, and SiteIntel refuses outright to supply
 *   `acquisition_price`. None of `assumption-targets.ts`'s real targets
 *   describe a zoning code or a parcel's acreage — there is no model field
 *   these facts could correctly overwrite.
 * - **MarketSignal** (Phase 6): its `ASSUMPTION_CATALOG`
 *   (`src/test3/assumptions/catalog.py`) genuinely does target real
 *   underwriting fields for 3 of its 15 assumption types — a market's
 *   vacancy/exit-cap/discount-rate forecast really can inform
 *   `vacancy.generalVacancyRate` / `valuation.terminalCapRate` /
 *   `valuation.discountRate`, and `MARKET_SIGNAL_DIRECT_TARGETS` below
 *   routes exactly those three there directly. The other 12 (rent growth,
 *   leasing-profile fields, debt rate, ...) need a model-specific
 *   collection row `<code>` MarketSignal cannot know at export time
 *   (`growthCurves.<code>.field`, `marketLeasing.<code>.marketRent`, ...) —
 *   sending an uncoded, partially-resolved path would misrepresent it as
 *   real when it isn't, so those twelve fall back to the same
 *   `marketSignal.<category>` informational namespace SiteIntel's facts
 *   use. A direct target still arrives `status: 'proposed'` like every
 *   cross-module assumption — routing it to a real target changes whether
 *   an analyst *can* apply it with one click, never whether they have to
 *   decide first.
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
        'The selected file is not valid JSON. It should be the .json handoff file downloaded from SiteIntel or MarketSignal, unmodified.',
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

/**
 * The only three of MarketSignal's 15 catalog assumption types
 * (`src/test3/assumptions/catalog.py`'s `ASSUMPTION_CATALOG`) that name a
 * real, model-level (no collection `<code>` needed) underwriting target.
 * See this file's module doc for why the other twelve stay informational.
 */
const MARKET_SIGNAL_DIRECT_TARGETS: Record<string, string> = {
  vacancy: 'vacancy.generalVacancyRate',
  exit_cap_rate: 'valuation.terminalCapRate',
  discount_rate: 'valuation.discountRate',
};

const SOURCE_LABELS: Record<string, string> = {
  siteintel: 'CREOS SiteIntel',
  marketsignal: 'CREOS MarketSignal',
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

/**
 * Makes a category safe to use as a target segment without changing an
 * already-safe one — unlike `slug()`, which is deliberately for turning a
 * human-readable *name* into a camelCase field identifier, and would
 * needlessly rewrite a catalog category like `exit_cap_rate` (already valid:
 * `assumptionTargetSchema` allows letters, digits, `_`, `-`, `.`, `:`) into
 * `exitCapRate`, breaking the identifier callers match `category` against
 * (`MARKET_SIGNAL_DIRECT_TARGETS`'s own keys, and any producer-side catalog
 * that expects its category to survive the round trip unchanged). Only a
 * character the schema would actually reject — a space, most punctuation —
 * gets replaced.
 */
function sanitizeTargetSegment(value: string): string {
  const cleaned = value.replace(/[^A-Za-z0-9_.\-:]+/g, '_').replace(/^_+|_+$/g, '');
  return cleaned.length === 0 ? 'value' : cleaned;
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

function targetFor(sourceModule: string, item: CreosHandoffAssumption): string {
  // `item.category` is free text (`HandoffAssumptionSchema.category` is only
  // `z.string().min(1)`) but every segment of a target has to satisfy
  // `assumptionTargetSchema`'s own `^[A-Za-z0-9_.\-:]+$` — a category like
  // "Site Assessment" would otherwise build an invalid target and fail the
  // *whole* translated document's validation later, blocking every fact in
  // the handoff over one item's target, not just that item.
  // `sanitizeTargetSegment`, not `slug()`: the direct-target lookup below is
  // keyed by the raw catalog category ('vacancy', 'exit_cap_rate', ...),
  // already valid and checked before sanitizing, and the informational
  // fallback should leave an already-valid category exactly as the catalog
  // wrote it too.
  if (sourceModule === 'marketsignal') {
    return (
      MARKET_SIGNAL_DIRECT_TARGETS[item.category] ??
      `marketSignal.${sanitizeTargetSegment(item.category)}`
    );
  }
  const category = sanitizeTargetSegment(item.category);
  if (sourceModule === 'siteintel') {
    return `siteIntel.${category}.${slug(item.name)}`;
  }
  // Defensive fallback for a source module this file hasn't reasoned about
  // yet — namespaced and informational, never a guessed real target. Only
  // siteintel/marketsignal above have had their target mappings actually
  // worked out and tested.
  return `${sourceModule}.${category}.${slug(item.name)}`;
}

function translateAssumption(
  sourceModule: string,
  item: CreosHandoffAssumption,
): ImportFieldAssumption {
  const extraction: { method: ExtractionMethod; derivation: string | null } = {
    method: 'explicit',
    derivation: null,
  };
  // `unit`/`methodology` are unbounded in `HandoffAssumptionSchema` (only
  // `cre-assumption-import`'s own schema caps `unit`/`displayValue`/a
  // `note` at 60/200/1000 chars), so an over-length one here would otherwise
  // fail that schema's validation for the *whole* translated document,
  // blocking every fact in the handoff over one item's descriptive text —
  // never the authoritative `value` itself, which nothing here touches.
  const unit = item.unit ? item.unit.slice(0, 60) : null;
  const displayValue = (unit ? `${item.value} ${unit}` : String(item.value)).slice(0, 200);
  return {
    target: targetFor(sourceModule, item),
    value: item.value,
    valueType: mapValueType(item.valueType),
    unit,
    displayValue,
    confidence: item.confidence ? CONFIDENCE_TO_FRACTION[item.confidence] : null,
    extraction,
    evidence: item.methodology ? [{ note: item.methodology.slice(0, 1000) }] : [],
    notes: null,
  };
}

/**
 * Pure translation: a validated `creos-handoff-v1` document (from either
 * SiteIntel or MarketSignal — see this file's module doc for how target
 * routing differs between them) into a `cre-assumption-import` v1
 * document, so it can flow through the exact same parse -> analyze ->
 * accept-by-hand pipeline any other import does (see this file's module
 * doc for why that is the right amount of new machinery — none — rather
 * than a second review surface).
 */
export function translateCreosHandoff(handoff: CreosHandoffV1): CreAssumptionImport {
  const propertyName = handoff.property?.identity?.propertyName ?? null;
  const documentDate = handoff.createdAt.slice(0, 10);
  const sourceLabel =
    SOURCE_LABELS[handoff.sourceModule] ?? `CREOS handoff (${handoff.sourceModule})`;
  const items = [...handoff.observations, ...handoff.assumptions];
  // `HandoffAssumptionSchema` is identical for `observations[]` and
  // `assumptions[]` — nothing requires a "State" fact to arrive in one array
  // rather than the other — so this has to search the same combined `items`
  // every other fact in this handoff is drawn from, not just `observations`.
  const stateObservation = items.find((item) => item.name === 'State');

  return {
    format: 'cre-assumption-import',
    version: 1,
    source: {
      kind: 'imported',
      system: sourceLabel,
      skill: null,
      documentName: propertyName
        ? `${sourceLabel} handoff: ${propertyName}`
        : `${sourceLabel} handoff ${handoff.handoffId.slice(-8)}`,
      documentDate,
      extractedAt: handoff.createdAt,
    },
    property: {
      name: propertyName,
      assetType: handoff.property?.classification?.propertyType ?? null,
      market: handoff.property?.market?.submarket ?? null,
      state: typeof stateObservation?.value === 'string' ? stateObservation.value : null,
    },
    assumptions: items.map((item) => translateAssumption(handoff.sourceModule, item)),
    records: [],
  };
}

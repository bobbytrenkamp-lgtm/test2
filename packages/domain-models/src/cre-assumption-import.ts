import { z } from 'zod';
import {
  assumptionTargetSchema,
  assumptionValueTypeEnum,
  validateTypedValue,
} from './assumption-proposals.js';

/**
 * `cre-assumption-import`, version 1.
 *
 * The interchange format an external extraction tool — a Claude Skill
 * reading a PDF, most immediately — writes, and an analyst pastes into this
 * platform. See `docs/claude-assumption-import.md` for the full
 * specification and the instruction template meant to be handed to the
 * extraction tool itself.
 *
 * ## What this format is not
 *
 * It is not a write path. Nothing described by a `cre-assumption-import`
 * document reaches a model directly — every assumption in it becomes an
 * `assumption_proposals` row (`assumption-proposals.ts`), through the exact
 * same acceptance step a human-posted proposal goes through. This schema
 * only says what a *paste* has to look like to be understood; the safety
 * boundary is unchanged and is not this file's concern.
 *
 * ## Why versioned from the start
 *
 * `format` and `version` are both required literals. A document that claims
 * to be `cre-assumption-import` version 2 someday will be refused by this
 * version's parser rather than partially misread by it — a version's rules
 * apply to that version's documents and nothing is inferred across the
 * boundary. See `parseImportPayload` for where that refusal happens.
 */

export const CRE_ASSUMPTION_IMPORT_FORMAT = 'cre-assumption-import';
export const CRE_ASSUMPTION_IMPORT_VERSION = 1;

/**
 * How confident the extraction tool is that it read the source correctly.
 *
 * `explicit` — the source states the value directly ("Exit Cap Rate: 6.25%").
 * `derived` — the source states enough to calculate the value mathematically,
 * and the calculation is recorded in `derivation`.
 * `inferred` — the value required interpretation beyond direct reading or
 * arithmetic. Inferred assumptions are never bulk-selected by default; see
 * the analyzer's `needsReview` status.
 */
export const extractionMethodEnum = z.enum(['explicit', 'derived', 'inferred']);
export type ExtractionMethod = z.infer<typeof extractionMethodEnum>;

export const importExtractionSchema = z.object({
  method: extractionMethodEnum,
  /** Required reasoning for a `derived` value: the arithmetic, stated. */
  derivation: z.string().max(1000).nullish(),
});
export type ImportExtraction = z.infer<typeof importExtractionSchema>;

/**
 * One piece of support for an assumption: where in the document it came
 * from, and what the document actually said there.
 *
 * Deliberately thin. This is not a document-management system and does not
 * try to be one — `sourceValue` is the figure or phrase as printed, not an
 * excerpt of surrounding prose, and there is no field for storing a page's
 * full text. Enough to verify a claim against the original PDF by hand;
 * nothing that would make this platform a second copy of that PDF.
 */
export const importEvidenceItemSchema = z.object({
  page: z.number().int().min(1).max(100_000).nullish(),
  section: z.string().max(300).nullish(),
  label: z.string().max(300).nullish(),
  /** The value exactly as the source states it, e.g. "6.25%", "$12.50/SF". */
  sourceValue: z.string().max(500).nullish(),
  note: z.string().max(1000).nullish(),
});
export type ImportEvidenceItem = z.infer<typeof importEvidenceItemSchema>;

/**
 * Who or what produced the document, and when it was read.
 *
 * `kind` reuses `assumptionSourceKindEnum`'s vocabulary and defaults to
 * `imported`: a Claude Skill reading a PDF is reporting what the document
 * says, not recommending a position. See `docs/assumption-contract.md` for
 * why that distinction is load-bearing rather than cosmetic.
 */
export const importSourceSchema = z.object({
  kind: z
    .enum(['imported', 'market_data', 'calculated', 'historical', 'recommended'])
    .default('imported'),
  /** The extraction tool itself, e.g. "Claude Skill". */
  system: z.string().max(200).nullish(),
  /** The specific skill, e.g. "cre-underwriting-extractor". */
  skill: z.string().max(200).nullish(),
  documentName: z.string().max(300).nullish(),
  /** The document's own date — an appraisal date, an OM's "as of" date. */
  documentDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected a date formatted as YYYY-MM-DD')
    .nullish(),
  extractedAt: z.string().datetime().nullish(),
});
export type ImportSource = z.infer<typeof importSourceSchema>;

/**
 * The property the document appears to describe. Context, never a
 * destination: the model already open in this platform is where every
 * assumption is compared against and would be written, regardless of what
 * this section says. See `docs/claude-assumption-import.md` for the mismatch
 * warning this drives.
 */
export const importPropertySchema = z.object({
  name: z.string().max(300).nullish(),
  assetType: z.string().max(100).nullish(),
  market: z.string().max(200).nullish(),
  state: z.string().max(100).nullish(),
});
export type ImportProperty = z.infer<typeof importPropertySchema>;

/**
 * One field-level assumption.
 *
 * `value` is the normalised, machine-readable figure — a decimal string for
 * a rate, `"2026-09-01"` for a date — and is authoritative. `displayValue`
 * is what the source showed a human ("6.25%") and is informational only;
 * nothing in this platform parses it to decide what the assumption actually
 * is. See `docs/claude-assumption-import.md`'s unit-normalisation rules for
 * why that boundary is strict rather than helpful.
 */
export const importFieldAssumptionSchema = z
  .object({
    target: assumptionTargetSchema,
    value: z.union([z.string(), z.number(), z.boolean()]).nullable(),
    valueType: assumptionValueTypeEnum,
    /** Presentation only — never authoritative and never parsed. */
    unit: z.string().max(60).nullish(),
    displayValue: z.string().max(200).nullish(),
    /** How sure the *extraction* is, 0 to 1 — not investment or forecast confidence. */
    confidence: z.number().min(0).max(1).nullish(),
    extraction: importExtractionSchema.nullish(),
    evidence: z.array(importEvidenceItemSchema).max(20).default([]),
    notes: z.string().max(2000).nullish(),
  })
  .superRefine((assumption, ctx) => {
    if (assumption.value === null || assumption.value === undefined) return;
    const problem = validateTypedValue(String(assumption.value), assumption.valueType);
    if (problem) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['value'], message: problem });
    }
  });
export type ImportFieldAssumption = z.infer<typeof importFieldAssumptionSchema>;

/**
 * A whole record at once — a market-leasing profile, a loan — rather than
 * one field at a time.
 *
 * Evidence here is keyed by field name, because a bundle's fields commonly
 * come from different pages of the source, and flattening them without
 * losing that would otherwise imply every field came from the same place.
 * The analyzer flattens a bundle into individual field-level proposed
 * changes and carries each field's own evidence array onto its own change —
 * never the bundle's evidence onto every field alike.
 */
export const importRecordBundleSchema = z.object({
  /** The contract's collection name, e.g. `marketLeasing`, `debt`, `expenses`. */
  collection: z.string().min(1).max(60),
  /** The business code this record has, or should have, in the model. */
  code: z.string().min(1).max(60),
  name: z.string().max(200).nullish(),
  /** Field name to its normalised, machine-readable value. */
  fields: z.record(z.union([z.string(), z.number(), z.boolean(), z.null()])),
  /** Field name to that field's own evidence. Absent fields have none recorded. */
  evidence: z.record(z.array(importEvidenceItemSchema)).default({}),
  notes: z.string().max(2000).nullish(),
});
export type ImportRecordBundle = z.infer<typeof importRecordBundleSchema>;

export const creAssumptionImportSchema = z.object({
  format: z.literal(CRE_ASSUMPTION_IMPORT_FORMAT),
  version: z.literal(CRE_ASSUMPTION_IMPORT_VERSION),
  source: importSourceSchema,
  property: importPropertySchema.default({}),
  /** Individual field-level assumptions. */
  assumptions: z.array(importFieldAssumptionSchema).max(500).default([]),
  /** Whole records — a leasing profile, a loan — reported together. */
  records: z.array(importRecordBundleSchema).max(200).default([]),
});
export type CreAssumptionImport = z.infer<typeof creAssumptionImportSchema>;

export interface ParsedImport {
  ok: true;
  data: CreAssumptionImport;
}
export interface RejectedImport {
  ok: false;
  /** An analyst-facing explanation — never a raw parser or zod error. */
  error: string;
}

/**
 * Turns pasted text into a validated `cre-assumption-import` document, or
 * explains in plain language why it could not.
 *
 * Tolerates exactly one thing beyond bare JSON: a single surrounding Markdown
 * fence (```` ```json ... ``` ````), because that is what a chat interface's
 * copy button reliably produces. Nothing beyond that is repaired — no
 * trailing-comma fixups, no quote-style guessing, no LLM-assisted recovery.
 * A parser that tried to be clever about malformed input would be a second,
 * undocumented dialect of the format, and this platform is not going to
 * maintain one of those by accident.
 */
export function parseImportPayload(raw: string): ParsedImport | RejectedImport {
  const stripped = stripSurroundingFence(raw);
  if (stripped.trim().length === 0) {
    return {
      ok: false,
      error: 'Paste the structured output before analyzing — nothing was found.',
    };
  }

  let json: unknown;
  try {
    json = JSON.parse(stripped);
  } catch {
    return {
      ok: false,
      error:
        'The pasted text is not valid JSON. Paste the extraction tool’s output exactly as ' +
        'given, including the outer braces — nothing here was changed by hand.',
    };
  }

  if (typeof json !== 'object' || json === null || Array.isArray(json)) {
    return {
      ok: false,
      error:
        'The pasted JSON is not an object. A cre-assumption-import document is a single object.',
    };
  }

  const candidate = json as Record<string, unknown>;
  if (candidate.format !== CRE_ASSUMPTION_IMPORT_FORMAT) {
    return {
      ok: false,
      error:
        `The pasted text does not contain a "${CRE_ASSUMPTION_IMPORT_FORMAT}" document. Its ` +
        `"format" field is ${
          candidate.format === undefined ? 'missing' : JSON.stringify(candidate.format)
        }, not "${CRE_ASSUMPTION_IMPORT_FORMAT}".`,
    };
  }
  if (candidate.version !== CRE_ASSUMPTION_IMPORT_VERSION) {
    return {
      ok: false,
      error:
        `This release reads ${CRE_ASSUMPTION_IMPORT_FORMAT} version ${CRE_ASSUMPTION_IMPORT_VERSION}. ` +
        `The pasted document is version ${
          candidate.version === undefined ? '(missing)' : JSON.stringify(candidate.version)
        }, which is not read the same way and is refused rather than guessed at.`,
    };
  }

  const result = creAssumptionImportSchema.safeParse(candidate);
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

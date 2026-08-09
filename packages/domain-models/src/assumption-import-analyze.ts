import type { ModelInput } from './model-input.js';
import type { AssumptionValueType } from './assumption-proposals.js';
import { resolveAssumptionValue, validateTypedValue, COLLECTION_KEYS } from './assumption-proposals.js';
import type { AssumptionUnit, TargetDescriptor } from './assumption-targets.js';
import { COLLECTIONS_BY_NAME, describeTarget } from './assumption-targets.js';
import type {
  CreAssumptionImport,
  ImportEvidenceItem,
  ImportExtraction,
  ImportProperty,
  ImportRecordBundle,
  ImportSource,
} from './cre-assumption-import.js';

/**
 * The deterministic analyzer.
 *
 * Takes a parsed `cre-assumption-import` document and the model's own
 * `ModelInput`, and returns a complete preview of what would happen if every
 * recognized assumption were accepted — without writing anything. This is
 * the "Comparison / Mapping" stage of the pipeline described in
 * `docs/claude-assumption-import.md`: parsing and schema validation already
 * happened (`cre-assumption-import.ts`), target resolution is
 * `assumption-targets.ts`'s job, and this file's only job is to line the two
 * up against what the model currently holds and say, per assumption, what
 * an analyst is looking at.
 *
 * Nothing here creates an `assumption_proposals` row. That happens only when
 * an analyst acts on this preview — see the assumption-import routes.
 *
 * ## Why `analyzeImport` never guesses
 *
 * Every branch below either finds one clear answer or produces a status that
 * asks a person to look. Two different values extracted for the same target
 * are shown as a conflict, not resolved by page order or confidence. A field
 * whose declared type doesn't match what the target actually is gets marked
 * invalid rather than coerced. A record whose business code doesn't exist in
 * the model yet is a `missingCollectionRecord`, not an inferred match to the
 * closest existing one. See `docs/claude-assumption-import.md` for why that
 * restraint is the point of the whole contract.
 */

export type ImportItemStatus =
  | 'new'
  | 'changed'
  | 'same'
  | 'needsReview'
  | 'conflict'
  | 'missingTarget'
  | 'unsupported'
  | 'invalid';

/** One distinct value seen for a target, with the evidence that reported it. */
export interface AnalyzedValue {
  value: string;
  displayValue: string | null;
  evidence: ImportEvidenceItem[];
}

export interface AnalyzedAssumption {
  target: string;
  label: string | null;
  collection: string | null;
  code: string | null;
  valueType: AssumptionValueType | null;
  unit: AssumptionUnit | null;
  currentValue: string | null;
  extractedValue: string | null;
  extractedDisplayValue: string | null;
  status: ImportItemStatus;
  /** Analyst-facing explanation, set whenever the status is not `new`/`changed`/`same`. */
  reason: string | null;
  confidence: number | null;
  extraction: ImportExtraction | null;
  evidence: ImportEvidenceItem[];
  notes: string | null;
  /** Populated only when `status` is `conflict`: every distinct value seen. */
  conflictingValues: AnalyzedValue[] | null;
}

/** A whole record bundle whose business code does not exist in this model yet. */
export interface MissingCollectionRecord {
  collection: string;
  code: string;
  name: string | null;
  /** e.g. "a market leasing profile" — used to phrase the reviewer's prompt. */
  noun: string;
  fields: Record<string, { value: string | null; evidence: ImportEvidenceItem[] }>;
}

export interface ImportAnalysisSummary {
  /** Distinct targets found, after merging duplicates. */
  received: number;
  /** Targets this release can address at all (excludes `unsupported`). */
  recognized: number;
  new: number;
  changed: number;
  same: number;
  needsReview: number;
  conflicts: number;
  missingTarget: number;
  unsupported: number;
  invalid: number;
}

export interface ImportAnalysis {
  source: ImportSource;
  property: ImportProperty;
  /** True when the document's stated property looks like a different one than this model's. A warning, never a block. */
  propertyMismatch: boolean;
  items: AnalyzedAssumption[];
  missingCollectionRecords: MissingCollectionRecord[];
  summary: ImportAnalysisSummary;
}

/** One reported value, before it is resolved against a target or grouped with duplicates. */
interface RawItem {
  target: string;
  rawValue: string | number | boolean | null;
  /** The type the source declared, when it declared one at all — bundle fields never do. */
  declaredValueType: AssumptionValueType | null;
  displayValue: string | null;
  confidence: number | null;
  extraction: ImportExtraction | null;
  evidence: ImportEvidenceItem[];
  notes: string | null;
  missingRecord: { collection: string; code: string; noun: string } | null;
}

export function analyzeImport(document: CreAssumptionImport, modelInput: ModelInput): ImportAnalysis {
  const missingCollectionRecords: MissingCollectionRecord[] = [];
  const rawItems: RawItem[] = [];

  for (const assumption of document.assumptions) {
    rawItems.push({
      target: assumption.target,
      rawValue: assumption.value,
      declaredValueType: assumption.valueType,
      displayValue: assumption.displayValue ?? null,
      confidence: assumption.confidence ?? null,
      extraction: assumption.extraction ?? null,
      evidence: assumption.evidence,
      notes: assumption.notes ?? null,
      missingRecord: null,
    });
  }

  for (const bundle of document.records) {
    rawItems.push(...flattenBundle(bundle, modelInput, missingCollectionRecords));
  }

  const grouped = new Map<string, RawItem[]>();
  for (const item of rawItems) {
    const list = grouped.get(item.target);
    if (list) list.push(item);
    else grouped.set(item.target, [item]);
  }

  const items = [...grouped.entries()].map(([target, group]) => classifyGroup(target, group, modelInput));

  return {
    source: document.source,
    property: document.property,
    propertyMismatch: detectPropertyMismatch(document.property, modelInput),
    items,
    missingCollectionRecords,
    summary: summarize(items),
  };
}

/** Whether a collection row with this business code exists on the model already. */
function recordExists(modelInput: ModelInput, collection: string, code: string): boolean {
  const key = COLLECTION_KEYS[collection] ?? collection;
  const rows = (modelInput as unknown as Record<string, unknown>)[key];
  if (!Array.isArray(rows)) return false;
  return rows.some((row) => row && typeof row === 'object' && (row as { id?: string }).id === code);
}

function flattenBundle(
  bundle: ImportRecordBundle,
  modelInput: ModelInput,
  missing: MissingCollectionRecord[],
): RawItem[] {
  const descriptor = COLLECTIONS_BY_NAME[bundle.collection];

  if (!descriptor) {
    // An unrecognized collection name entirely — each field resolves to
    // "unsupported" on its own via `describeTarget`, same as a stray
    // individual assumption naming a target this release does not model.
    return Object.entries(bundle.fields).map(([field, value]) => ({
      target: `${bundle.collection}.${bundle.code}.${field}`,
      rawValue: value,
      declaredValueType: null,
      displayValue: null,
      confidence: null,
      extraction: null,
      evidence: bundle.evidence[field] ?? [],
      notes: bundle.notes ?? null,
      missingRecord: null,
    }));
  }

  const exists = recordExists(modelInput, bundle.collection, bundle.code);
  if (!exists) {
    missing.push({
      collection: bundle.collection,
      code: bundle.code,
      name: bundle.name ?? null,
      noun: descriptor.noun,
      fields: Object.fromEntries(
        Object.entries(bundle.fields).map(([field, value]) => [
          field,
          { value: value === null ? null : String(value), evidence: bundle.evidence[field] ?? [] },
        ]),
      ),
    });
  }

  return Object.entries(bundle.fields).map(([field, value]) => ({
    target: `${bundle.collection}.${bundle.code}.${field}`,
    rawValue: value,
    declaredValueType: null,
    displayValue: null,
    confidence: null,
    extraction: null,
    evidence: bundle.evidence[field] ?? [],
    notes: bundle.notes ?? null,
    missingRecord: exists
      ? null
      : { collection: bundle.collection, code: bundle.code, noun: descriptor.noun },
  }));
}

function classifyGroup(
  target: string,
  group: RawItem[],
  modelInput: ModelInput,
): AnalyzedAssumption {
  const first = group[0] as RawItem;
  const distinct = distinctValues(group);

  if (first.missingRecord) {
    const merged = distinct[0] ?? null;
    return {
      target,
      label: null,
      collection: first.missingRecord.collection,
      code: first.missingRecord.code,
      valueType: null,
      unit: null,
      currentValue: null,
      extractedValue: merged?.value ?? null,
      extractedDisplayValue: merged?.displayValue ?? null,
      status: 'missingTarget',
      reason:
        `${first.missingRecord.code} is not in this model as ${first.missingRecord.noun}. ` +
        'Create it or map it to an existing profile before applying.',
      confidence: first.confidence,
      extraction: first.extraction,
      evidence: mergeEvidence(group),
      notes: first.notes,
      conflictingValues: null,
    };
  }

  const resolved = describeTarget(target);
  if (!resolved.ok) {
    return {
      target,
      label: null,
      collection: null,
      code: null,
      valueType: first.declaredValueType,
      unit: null,
      currentValue: null,
      extractedValue: distinct[0]?.value ?? null,
      extractedDisplayValue: distinct[0]?.displayValue ?? null,
      status: 'unsupported',
      reason: resolved.reason,
      confidence: first.confidence,
      extraction: first.extraction,
      evidence: mergeEvidence(group),
      notes: first.notes,
      conflictingValues: null,
    };
  }

  const descriptor = resolved.descriptor;
  const collection = resolved.collection ?? null;
  const code = collection ? (target.split('.')[1] ?? null) : null;

  if (distinct.length === 0) {
    // Every mention of this target was a remark with no figure attached —
    // still worth surfacing, but there is nothing to accept.
    return {
      target,
      label: descriptor.label,
      collection,
      code,
      valueType: descriptor.valueType,
      unit: descriptor.unit ?? null,
      currentValue: resolveAssumptionValue(modelInput as unknown as Record<string, unknown>, target),
      extractedValue: null,
      extractedDisplayValue: null,
      status: 'needsReview',
      reason: 'No value was extracted for this target, only a note. Review the source before deciding.',
      confidence: first.confidence,
      extraction: first.extraction,
      evidence: mergeEvidence(group),
      notes: first.notes,
      conflictingValues: null,
    };
  }

  if (distinct.length > 1) {
    // Different pages disagree. Never chosen automatically — see the module
    // doc comment for why that is not this file's decision to make.
    return {
      target,
      label: descriptor.label,
      collection,
      code,
      valueType: descriptor.valueType,
      unit: descriptor.unit ?? null,
      currentValue: resolveAssumptionValue(modelInput as unknown as Record<string, unknown>, target),
      extractedValue: null,
      extractedDisplayValue: null,
      status: 'conflict',
      reason:
        `${distinct.length} different values were extracted for ${descriptor.label} from ` +
        'different parts of the document. Choose which one is correct.',
      confidence: null,
      extraction: null,
      evidence: mergeEvidence(group),
      notes: first.notes,
      conflictingValues: distinct,
    };
  }

  const merged = distinct[0] as AnalyzedValue;

  if (first.declaredValueType && first.declaredValueType !== descriptor.valueType) {
    return invalidItem(
      target,
      descriptor,
      collection,
      code,
      group,
      `This was extracted as a ${first.declaredValueType} value but ${descriptor.label} expects ` +
        `a ${descriptor.valueType} value.`,
    );
  }

  const shapeProblem = validateTypedValue(merged.value, descriptor.valueType);
  if (shapeProblem) {
    return invalidItem(target, descriptor, collection, code, group, shapeProblem);
  }

  const current = resolveAssumptionValue(modelInput as unknown as Record<string, unknown>, target);
  let status: ImportItemStatus =
    current === null ? 'new' : valuesMatch(current, merged.value, descriptor.valueType) ? 'same' : 'changed';
  let reason: string | null = null;

  if (status !== 'same') {
    if (first.extraction?.method === 'inferred') {
      status = 'needsReview';
      reason =
        'This value was inferred rather than read directly from the document. Review it before applying.';
    } else if (descriptor.unit === 'rate' && descriptor.valueType === 'decimal') {
      const numeric = Number(merged.value);
      if (Number.isFinite(numeric) && Math.abs(numeric) > 1) {
        status = 'needsReview';
        reason =
          `"${merged.value}" is unusually large for a rate — verify this was normalized to a ` +
          'decimal fraction (e.g. 6.25% -> 0.0625) rather than left as a whole number.';
      }
    }
  }

  return {
    target,
    label: descriptor.label,
    collection,
    code,
    valueType: descriptor.valueType,
    unit: descriptor.unit ?? null,
    currentValue: current,
    extractedValue: merged.value,
    extractedDisplayValue: merged.displayValue,
    status,
    reason,
    confidence: first.confidence,
    extraction: first.extraction,
    evidence: merged.evidence,
    notes: first.notes,
    conflictingValues: null,
  };
}

function invalidItem(
  target: string,
  descriptor: TargetDescriptor,
  collection: string | null,
  code: string | null,
  group: RawItem[],
  reason: string,
): AnalyzedAssumption {
  const first = group[0] as RawItem;
  return {
    target,
    label: descriptor.label,
    collection,
    code,
    valueType: descriptor.valueType,
    unit: descriptor.unit ?? null,
    currentValue: null,
    extractedValue: normalizeRaw(first.rawValue),
    extractedDisplayValue: first.displayValue,
    status: 'invalid',
    reason,
    confidence: first.confidence,
    extraction: first.extraction,
    evidence: mergeEvidence(group),
    notes: first.notes,
    conflictingValues: null,
  };
}

/** Distinct non-null values reported for one target, each with its merged evidence. */
function distinctValues(group: RawItem[]): AnalyzedValue[] {
  const byValue = new Map<string, { displayValue: string | null; evidence: ImportEvidenceItem[] }>();
  for (const item of group) {
    const key = normalizeRaw(item.rawValue);
    if (key === null) continue;
    const existing = byValue.get(key);
    if (existing) {
      existing.evidence.push(...item.evidence);
      existing.displayValue = existing.displayValue ?? item.displayValue;
    } else {
      byValue.set(key, { displayValue: item.displayValue, evidence: [...item.evidence] });
    }
  }
  return [...byValue.entries()].map(([value, data]) => ({
    value,
    displayValue: data.displayValue,
    evidence: dedupeEvidence(data.evidence),
  }));
}

function mergeEvidence(group: RawItem[]): ImportEvidenceItem[] {
  return dedupeEvidence(group.flatMap((item) => item.evidence));
}

function dedupeEvidence(evidence: ImportEvidenceItem[]): ImportEvidenceItem[] {
  const seen = new Set<string>();
  const out: ImportEvidenceItem[] = [];
  for (const item of evidence) {
    const key = JSON.stringify([
      item.page ?? null,
      item.section ?? null,
      item.label ?? null,
      item.sourceValue ?? null,
    ]);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

function normalizeRaw(raw: string | number | boolean | null): string | null {
  return raw === null || raw === undefined ? null : String(raw);
}

/**
 * Whether two values are the *same* value, not merely the same characters.
 *
 * A decimal read back from Postgres carries the column's fixed scale —
 * `"0.065"` typed in comes back as `"0.06500000"` — and comparing those as
 * strings would report every untouched rate as "changed". Every other
 * `valueType` is compared as written: an integer, a date and a boolean are
 * canonical already, and an enum or a string comparing loosely would be the
 * guessing this whole contract exists not to do.
 */
function valuesMatch(current: string, extracted: string, valueType: AssumptionValueType): boolean {
  if (valueType === 'decimal') return canonicalDecimal(current) === canonicalDecimal(extracted);
  return current === extracted;
}

function canonicalDecimal(raw: string): string {
  const negative = raw.startsWith('-');
  const unsigned = negative ? raw.slice(1) : raw;
  const [wholePart = '0', fractionPart = ''] = unsigned.split('.');
  const whole = wholePart.replace(/^0+(?=\d)/, '');
  const fraction = fractionPart.replace(/0+$/, '');
  const canonical = fraction.length > 0 ? `${whole}.${fraction}` : whole;
  return negative && canonical !== '0' ? `-${canonical}` : canonical;
}

function detectPropertyMismatch(property: ImportProperty, modelInput: ModelInput): boolean {
  const documented = property.name?.trim().toLowerCase();
  const actual = modelInput.property.name?.trim().toLowerCase();
  if (!documented || !actual) return false;
  if (documented === actual) return false;
  if (documented.includes(actual) || actual.includes(documented)) return false;
  return true;
}

function summarize(items: AnalyzedAssumption[]): ImportAnalysisSummary {
  const count = (status: ImportItemStatus) => items.filter((item) => item.status === status).length;
  return {
    received: items.length,
    recognized: items.filter((item) => item.status !== 'unsupported').length,
    new: count('new'),
    changed: count('changed'),
    same: count('same'),
    needsReview: count('needsReview'),
    conflicts: count('conflict'),
    missingTarget: count('missingTarget'),
    unsupported: count('unsupported'),
    invalid: count('invalid'),
  };
}

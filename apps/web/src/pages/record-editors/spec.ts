/**
 * What a record editor is made of.
 *
 * The assumption collections were edited as raw JSON. That is defensible for a
 * developer and indefensible for an analyst: it asks somebody who knows what a
 * base-year stop is to know what a trailing comma does, and it shows every
 * field of every method at once, so a `fixed_annual` expense displays a monthly
 * schedule it will never read.
 *
 * These specs are the replacement. They are **data**, not components, for two
 * reasons:
 *
 * - "Only show the fields this method uses" becomes a predicate on a field
 *   rather than a branch inside a form, so adding a method is adding a row.
 * - The same spec drives the form, its validation and its help text, so a field
 *   cannot acquire a control without acquiring an explanation.
 *
 * A field's `key` is the **camelCase API field**, dotted for anything nested:
 * `escalation.type` reaches into the record's `escalation` object. That keeps
 * the structured parts — escalations, recoveries, draw schedules — reachable
 * through the same mechanism as a scalar, which is the whole reason the JSON
 * textarea existed.
 */

export type FieldKind =
  | 'text'
  | 'decimal'
  | 'percent'
  | 'integer'
  | 'months'
  | 'date'
  | 'choice'
  | 'boolean'
  | 'curve'
  | 'schedule';

export interface FieldSpec {
  /** camelCase API field. Dots reach into a nested object. */
  key: string;
  label: string;
  kind: FieldKind;
  help?: string;
  /** Required for `choice`. */
  options?: Array<{ value: string; label: string }>;
  /** Shown only when this holds. Absent means always. */
  showWhen?: (record: RecordValues) => boolean;
  required?: boolean;
  placeholder?: string;
  /** Refuses the value with a reason. Runs on save, not on every keystroke. */
  validate?: (value: string, record: RecordValues) => string | undefined;
  /** Read-only once the record exists — a code is referenced by other records. */
  fixedAfterCreate?: boolean;
}

export interface SectionSpec {
  title: string;
  description?: string;
  fields: FieldSpec[];
  /**
   * Renders beside its sibling rather than below it.
   *
   * Renewal and new-lease assumptions are read against each other — "what do I
   * give a tenant to stay versus to arrive" is one question — so they are laid
   * out as a pair rather than as a list you scroll between.
   */
  pairWithNext?: boolean;
  showWhen?: (record: RecordValues) => boolean;
}

export interface RecordSpec {
  /** URL segment, e.g. `expenses`. */
  segment: string;
  /** Singular, for headings: "operating expense". */
  noun: string;
  sections: SectionSpec[];
  /**
   * A compact reading of the record as it currently stands, shown beside the
   * form. Purely derived from the fields in front of the analyst — it never
   * calls the engine, and it says so, because a summary that looked like a
   * calculated result would be trusted like one.
   */
  summary?: (record: RecordValues) => Array<{ label: string; value: string; note?: string }>;
  /** Values a new record starts with. */
  defaults?: RecordValues;
}

export type RecordValues = Record<string, unknown>;

/* -------------------------------------------------------------------------- */

/** Reads a dotted path. */
export function readPath(record: RecordValues, path: string): unknown {
  return path.split('.').reduce<unknown>((value, part) => {
    if (value === null || typeof value !== 'object') return undefined;
    return (value as RecordValues)[part];
  }, record);
}

/** Writes a dotted path, creating intermediate objects, without mutating. */
export function writePath(record: RecordValues, path: string, value: unknown): RecordValues {
  const parts = path.split('.');
  const next: RecordValues = { ...record };
  let cursor = next;
  for (let i = 0; i < parts.length - 1; i += 1) {
    const part = parts[i] as string;
    const existing = cursor[part];
    const child: RecordValues =
      existing !== null && typeof existing === 'object' && !Array.isArray(existing)
        ? { ...(existing as RecordValues) }
        : {};
    cursor[part] = child;
    cursor = child;
  }
  cursor[parts[parts.length - 1] as string] = value;
  return next;
}

/** The value as the form's control wants it: always a string. */
export function fieldText(record: RecordValues, field: FieldSpec): string {
  const raw = readPath(record, field.key);
  if (raw === null || raw === undefined) return '';
  if (typeof raw === 'boolean') return raw ? 'true' : 'false';
  if (Array.isArray(raw)) return raw.join(', ');
  if (field.kind === 'date') return String(raw).slice(0, 10);
  return String(raw);
}

/**
 * Turns a form value back into what the API stores.
 *
 * Numbers stay strings. Every amount and rate in this system is a decimal
 * string end to end so that 1234.55 is not stored as 1234.5499999999999, and
 * parsing here would undo that before the value ever reached the engine.
 * Integers are the exception: a month count is a count, and the API's schema
 * types it as one.
 */
export function fieldValue(text: string, field: FieldSpec): unknown {
  const trimmed = text.trim();
  switch (field.kind) {
    case 'boolean':
      return trimmed === 'true';
    case 'integer':
      return trimmed === '' ? 0 : Number.parseInt(trimmed, 10);
    case 'schedule':
      return trimmed === ''
        ? []
        : trimmed
            .split(/[,\s]+/)
            .map((part) => part.trim())
            .filter(Boolean);
    case 'curve':
    case 'text':
      return trimmed === '' ? null : trimmed;
    case 'date':
      return trimmed === '' ? null : trimmed;
    default:
      // decimal, percent, months: decimal strings, kept exactly as typed.
      return trimmed === '' ? null : trimmed;
  }
}

/** Every field the spec would show for this record, sections flattened. */
export function visibleFields(spec: RecordSpec, record: RecordValues): FieldSpec[] {
  return spec.sections
    .filter((section) => section.showWhen?.(record) ?? true)
    .flatMap((section) => section.fields.filter((field) => field.showWhen?.(record) ?? true));
}

/** Problems that would stop a save, keyed by field. */
export function validate(spec: RecordSpec, record: RecordValues): Record<string, string> {
  const problems: Record<string, string> = {};
  for (const field of visibleFields(spec, record)) {
    const text = fieldText(record, field);
    if (field.required && text.trim() === '') {
      problems[field.key] = `${field.label} is required.`;
      continue;
    }
    if (text.trim() === '') continue;
    const reason = field.validate?.(text, record);
    if (reason) problems[field.key] = reason;
  }
  return problems;
}

/* -------------------------------------------------------------------------- */
/* Validators used across more than one spec                                  */
/* -------------------------------------------------------------------------- */

export const mustBeNumber =
  (options: { min?: number; max?: number; label?: string } = {}) =>
  (value: string): string | undefined => {
    const parsed = Number(value.replace(/[,\s]/g, ''));
    if (!Number.isFinite(parsed)) return `“${value}” is not a number.`;
    if (options.min !== undefined && parsed < options.min) {
      return `${options.label ?? 'This'} cannot be below ${options.min}.`;
    }
    if (options.max !== undefined && parsed > options.max) {
      return `${options.label ?? 'This'} cannot be above ${options.max}.`;
    }
    return undefined;
  };

/**
 * A rate entered as a decimal fraction.
 *
 * Deliberately *not* the grid's forgiving "7 means 7%" rule. A form field has
 * room for a hint saying `0.03 for 3%`, and a record editor is where somebody
 * types a value they have thought about; silently multiplying it by a hundred
 * because it looked large is a worse failure here than a clear refusal.
 */
export const mustBeRate =
  (options: { max?: number } = {}) =>
  (value: string): string | undefined => {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) return `“${value}” is not a rate. Enter 0.03 for 3%.`;
    if (Math.abs(parsed) > (options.max ?? 10)) {
      return `${parsed} is not a fraction. Enter 0.03 for 3%, not 3.`;
    }
    return undefined;
  };

export const mustBeIsoDate = (value: string): string | undefined =>
  /^\d{4}-\d{2}-\d{2}$/.test(value.trim()) ? undefined : 'Enter a date as YYYY-MM-DD.';

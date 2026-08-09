import {
  normalizeDate,
  normalizeNumber,
  normalizeRecoveryMethod,
  normalizeStatus,
} from '@cre/reporting/parsing';

/**
 * What a grid column is.
 *
 * The important field is `parse`. A grid accepts text — typed, or pasted out of
 * somebody's spreadsheet — and something has to decide what `12,500`,
 * `$1,234.50`, `(500)`, `3/4/2026` or `NNN` mean. That decision already exists
 * in the import pipeline and is reused here rather than reimplemented, so a
 * value pasted into a cell and the same value imported from a file are read
 * identically.
 *
 * `parse` returns either a stored value or a reason it was refused. A refusal
 * is shown against the cell; it never silently becomes zero, and it never
 * silently becomes the raw text either. A rent roll where `n/a` quietly parsed
 * to 0 would understate revenue with no evidence anywhere.
 */

export type ParseResult = { ok: true; value: string } | { ok: false; reason: string };

export interface ColumnDef<Row> {
  key: string;
  label: string;
  /** Pixels. The grid uses fixed widths so columns line up while scrolling. */
  width: number;
  /** Right-aligned with tabular figures. */
  numeric?: boolean;
  /** Stays put while the grid scrolls sideways. Only leading columns may. */
  frozen?: boolean;
  /** Off by default, shown from the column menu. */
  hiddenByDefault?: boolean;
  /** Read-only columns are still selectable and copyable. */
  editable?: boolean;
  /** The stored value, as a string. This is what copy puts on the clipboard. */
  value: (row: Row) => string;
  /** How the cell reads when it is not being edited. Defaults to `value`. */
  display?: (row: Row, value: string) => string;
  /** Turns typed or pasted text into a stored value. */
  parse?: (raw: string) => ParseResult;
  /** A fixed set of choices, offered as a dropdown when editing. */
  options?: Array<{ value: string; label: string }>;
  /** Explains the column in a header tooltip. */
  help?: string;
}

/* -------------------------------------------------------------------------- */
/* Parsers, over the import pipeline's normalisers                            */
/* -------------------------------------------------------------------------- */

/** A plain string field. Trimmed, because a pasted cell often carries spaces. */
export const parseText =
  (options: { maxLength?: number } = {}) =>
  (raw: string): ParseResult => {
    const value = raw.trim();
    if (options.maxLength !== undefined && value.length > options.maxLength) {
      return { ok: false, reason: `Longer than ${options.maxLength} characters.` };
    }
    return { ok: true, value };
  };

/**
 * A decimal amount, kept as a string all the way to the engine.
 *
 * Never parsed to a JavaScript number: the engine works in decimal strings
 * precisely so that a rent of 1234.55 is not stored as 1234.5499999999999, and
 * a round trip through a float here would undo that before the value ever
 * reached it.
 */
export const parseDecimal =
  (options: { min?: number; max?: number; label?: string } = {}) =>
  (raw: string): ParseResult => {
    const normalized = normalizeNumber(raw);
    if (normalized === null) {
      return {
        ok: false,
        reason: `“${raw.trim()}” is not a number. Enter a figure such as 12500 or 12,500.`,
      };
    }
    // Compared as a number, never stored as one: a bound check is a comparison
    // and the string is what is kept.
    const asNumber = Number(normalized);
    if (options.min !== undefined && asNumber < options.min) {
      return { ok: false, reason: `${options.label ?? 'This'} cannot be below ${options.min}.` };
    }
    if (options.max !== undefined && asNumber > options.max) {
      return { ok: false, reason: `${options.label ?? 'This'} cannot be above ${options.max}.` };
    }
    return { ok: true, value: normalized };
  };

/**
 * A percentage, entered the way analysts type it.
 *
 * `7%`, `7` and `0.07` all mean seven percent; the stored form is the decimal
 * fraction the engine expects. The rule is that anything above 1 was typed as a
 * percentage — which is safe here because every rate this applies to (renewal
 * probability, growth, vacancy) is a fraction, and a genuine 150% renewal
 * probability is not a thing.
 *
 * The threshold is stated rather than guessed at, and the hint on the column
 * says so, because a silent × 100 is exactly the kind of helpfulness that
 * misstates a valuation.
 */
export const parsePercent =
  (options: { max?: number } = {}) =>
  (raw: string): ParseResult => {
    const text = raw.trim();
    const hadSign = text.endsWith('%');
    const normalized = normalizeNumber(hadSign ? text.slice(0, -1) : text);
    if (normalized === null) {
      return { ok: false, reason: `“${text}” is not a percentage. Enter 7%, 7 or 0.07.` };
    }
    const asNumber = Number(normalized);
    const fraction = hadSign || Math.abs(asNumber) > 1 ? asNumber / 100 : asNumber;
    if (options.max !== undefined && Math.abs(fraction) > options.max) {
      return { ok: false, reason: `That is above the maximum of ${options.max * 100}%.` };
    }
    return { ok: true, value: String(fraction) };
  };

/**
 * A date, in the formats rent rolls actually contain.
 *
 * An all-numeric date that could be read two ways is *refused*, not guessed:
 * reading 03/04/2026 as March rather than April moves a lease expiry by a month
 * and nothing downstream would ever reveal it. The importer resolves the same
 * ambiguity with an explicit user preference; a grid cell has nowhere to put
 * that question, so it asks for an unambiguous form instead.
 */
export const parseDate = (raw: string): ParseResult => {
  const { value, ambiguous } = normalizeDate(raw);
  if (value === null) {
    return { ok: false, reason: `“${raw.trim()}” is not a date. Try 2026-03-04 or 4 Mar 2026.` };
  }
  if (ambiguous) {
    return {
      ok: false,
      reason: `“${raw.trim()}” could be March or April. Enter it as 2026-03-04 to be certain.`,
    };
  }
  return { ok: true, value };
};

/** One of a fixed set. Falls back to the pipeline's own synonym handling. */
export const parseChoice =
  (
    allowed: readonly string[],
    normalise: (raw: string) => string = (raw) => raw.trim().toLowerCase(),
  ) =>
  (raw: string): ParseResult => {
    const value = normalise(raw);
    if (!allowed.includes(value)) {
      return { ok: false, reason: `“${raw.trim()}” is not one of: ${allowed.join(', ')}.` };
    }
    return { ok: true, value };
  };

export const parseLeaseStatus = (allowed: readonly string[]) =>
  parseChoice(allowed, normalizeStatus);
export const parseRecoveryMethod = (allowed: readonly string[]) =>
  parseChoice(allowed, normalizeRecoveryMethod);

/* -------------------------------------------------------------------------- */
/* Column visibility and order                                                */
/* -------------------------------------------------------------------------- */

export interface ColumnLayout {
  /** Column keys in display order. Keys absent from a saved layout are appended. */
  order: string[];
  hidden: string[];
}

/**
 * Reconciles a stored layout with the columns that exist today.
 *
 * A saved view is a statement about the columns that existed when it was saved,
 * so three cases have to be told apart:
 *
 * - **A column the layout mentions** is shown unless it is in `hidden`. That is
 *   the analyst's own choice and it wins.
 * - **A column the layout never mentions** — one added to the product since —
 *   falls back to its *default* visibility rather than being treated as
 *   visible. Otherwise every advanced field added later would erupt into every
 *   view ever saved, and `hiddenByDefault` would mean nothing after the first
 *   release.
 * - **A key the layout names that no longer exists** is dropped.
 *
 * New columns are inserted in their natural position rather than appended: a
 * rent field added between Area and Rent belongs between them, not after Notes.
 */
export function resolveLayout<Row>(
  columns: Array<ColumnDef<Row>>,
  layout: ColumnLayout | null,
): Array<ColumnDef<Row>> {
  const byKey = new Map(columns.map((column) => [column.key, column]));
  const known = new Set(layout?.order ?? []);
  const hidden = new Set(
    layout
      ? [
          ...layout.hidden,
          ...columns
            .filter((column) => !known.has(column.key) && column.hiddenByDefault)
            .map((column) => column.key),
        ]
      : columns.filter((column) => column.hiddenByDefault).map((column) => column.key),
  );

  if (!layout) return columns.filter((column) => !hidden.has(column.key));

  const ordered: Array<ColumnDef<Row>> = [];
  const placed = new Set<string>();
  for (const key of layout.order) {
    const column = byKey.get(key);
    if (column && !placed.has(key)) {
      ordered.push(column);
      placed.add(key);
    }
  }
  // Anything the layout never mentioned — a column added since it was saved —
  // goes back where it naturally sits, not on the end.
  for (const [index, column] of columns.entries()) {
    if (placed.has(column.key)) continue;
    const before = columns
      .slice(0, index)
      .reverse()
      .find((candidate) => placed.has(candidate.key));
    const at = before ? ordered.findIndex((c) => c.key === before.key) + 1 : 0;
    ordered.splice(at, 0, column);
    placed.add(column.key);
  }

  // Frozen columns must stay leading, or they would freeze a gap.
  const frozen = ordered.filter((column) => column.frozen);
  const rest = ordered.filter((column) => !column.frozen);
  return [...frozen, ...rest].filter((column) => !hidden.has(column.key));
}

/** The density presets. Analysts on large monitors want many rows. */
export type Density = 'comfortable' | 'standard' | 'compact';

export const DENSITY_ROW_HEIGHT: Record<Density, number> = {
  comfortable: 40,
  standard: 32,
  compact: 26,
};

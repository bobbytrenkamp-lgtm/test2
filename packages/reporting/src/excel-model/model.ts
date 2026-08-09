import { absoluteRef, rangeTo, refTo, safeDefinedName, safeSheetName } from './refs.js';
import type { Address } from './refs.js';

/**
 * A spreadsheet described as a model, not as a sequence of cell writes.
 *
 * The problem this solves: a workbook built by assigning `sheet.getCell('F17')`
 * all over the codebase is impossible to change and impossible to audit —
 * nothing records that F17 *is* net operating income for period 12, so every
 * formula referring to it has to hard-code the coordinate and every inserted
 * row breaks something silently.
 *
 * Here a cell is registered under a business key (`cashFlow.netOperatingIncome`
 * for period 12), and formulas ask for `ref('cashFlow.netOperatingIncome', 12)`.
 * Layout can move; the formulas do not care.
 *
 * ## Two passes, deliberately
 *
 * Sheets are laid out first, then formulas are resolved. A formula is supplied
 * as a *function* of a resolver rather than as text, so the Summary sheet can
 * reference the Returns sheet even though Returns is built afterwards. Resolving
 * eagerly would force the sheets into dependency order, which is not the order
 * a reader wants them in.
 *
 * ## Coverage
 *
 * Each cell declares what it is. That is what makes it possible to say honestly
 * how much of the workbook is formula-driven, and to fail a test when a
 * calculated cell degrades into a pasted number.
 */

/** What a cell is, which drives both styling and the coverage metric. */
export type CellKind =
  /** A row or column caption. Never a number. */
  | 'label'
  /** A section or column header. */
  | 'header'
  /** An assumption the reader is meant to edit. Static by design. */
  | 'input'
  /** Derived by an Excel formula. */
  | 'formula'
  /**
   * Derived by the engine but written as a number. Every one of these is a gap
   * in formula coverage and is counted as such.
   */
  | 'staticDerived'
  /** Descriptive, not derived: a tenant name, an address, a units caption. */
  | 'metadata';

export type NumberFormatName =
  | 'currency'
  | 'currency0'
  | 'percent'
  | 'percent2'
  | 'multiple'
  | 'area'
  | 'integer'
  | 'date'
  | 'text'
  | 'ratio';

/** Resolves business keys to references. Handed to every formula function. */
export interface RefResolver {
  /** `ref('cashFlow.noi', 12)` → `'Cash Flow'!O24`, relative to the calling sheet. */
  ref(key: string, period?: number): string;
  /** Absolute form, for anchors that must not shift when copied. */
  absRef(key: string, period?: number): string;
  /** A contiguous range across periods on one row. */
  range(key: string, fromPeriod: number, toPeriod: number): string;
  /** A defined name, e.g. `ExitCapRate`. Throws if it was never defined. */
  name(definedName: string): string;
  /** True when a key was registered, for optional sections. */
  has(key: string, period?: number): boolean;
}

export interface CellSpec {
  kind: CellKind;
  /** Literal contents, for every kind except `formula`. */
  value?: string | number | boolean | null;
  /** Formula body without the leading `=`. */
  formula?: (refs: RefResolver) => string;
  /**
   * The engine's value for this cell, stored alongside the formula.
   *
   * Excel shows this until it recalculates, and the reconciliation tests read
   * it to compare the workbook against the engine. The formula always remains
   * authoritative — this is never written *instead of* one.
   */
  cachedValue?: number | string | null;
  format?: NumberFormatName;
  /** Registers an Excel defined name pointing at this cell. */
  definedName?: string;
  note?: string;
  bold?: boolean;
  /** Indent level for the label column, in Excel indent units. */
  indent?: number;
}

interface PlacedCell extends CellSpec {
  sheet: string;
  row: number;
  col: number;
  key?: string;
}

export interface SheetOptions {
  /** Rows above the split, so headers stay visible while scrolling. */
  freezeRows?: number;
  /** Columns left of the split, so labels stay visible. */
  freezeColumns?: number;
  columnWidths?: Array<{ column: number; width: number }>;
  /** Shown under the sheet title. */
  description?: string;
}

export class SheetModel {
  readonly name: string;
  readonly options: SheetOptions;
  readonly cells: PlacedCell[] = [];
  /** Next free row, so builders can append without tracking counters. */
  private cursor = 1;

  constructor(
    name: string,
    private readonly workbook: WorkbookModel,
    options: SheetOptions = {},
  ) {
    this.name = safeSheetName(name);
    this.options = options;
  }

  /** The row a subsequent `at()` would use. */
  get nextRow(): number {
    return this.cursor;
  }

  /** Reserves the next row and returns it. */
  claimRow(): number {
    const row = this.cursor;
    this.cursor += 1;
    return row;
  }

  skipRows(count = 1): void {
    this.cursor += count;
  }

  /** Places a cell. `key` registers it for `refs.ref(key)`. */
  at(row: number, col: number, spec: CellSpec, key?: string): Address {
    const address: Address = { sheet: this.name, row, col };
    const placed: PlacedCell = { ...spec, sheet: this.name, row, col, ...(key ? { key } : {}) };
    this.cells.push(placed);
    if (key !== undefined) this.workbook.register(key, address);
    if (spec.definedName !== undefined) {
      this.workbook.defineName(spec.definedName, address);
    }
    if (this.cursor <= row) this.cursor = row + 1;
    return address;
  }

  /** A left-hand caption. */
  label(row: number, col: number, text: string, options: { bold?: boolean; indent?: number } = {}) {
    return this.at(row, col, {
      kind: 'label',
      value: text,
      format: 'text',
      ...(options.bold === undefined ? {} : { bold: options.bold }),
      ...(options.indent === undefined ? {} : { indent: options.indent }),
    });
  }

  /** A section heading on its own row. */
  section(text: string): number {
    const row = this.claimRow();
    this.at(row, 1, { kind: 'header', value: text, format: 'text', bold: true });
    return row;
  }
}

export class WorkbookModel {
  readonly sheets: SheetModel[] = [];
  private readonly registry = new Map<string, Address>();
  private readonly definedNames = new Map<string, Address>();
  /** Recorded rather than thrown on, so a builder can report them all at once. */
  readonly problems: string[] = [];

  sheet(name: string, options: SheetOptions = {}): SheetModel {
    const created = new SheetModel(name, this, options);
    if (this.sheets.some((existing) => existing.name === created.name)) {
      throw new Error(`Duplicate sheet name "${created.name}".`);
    }
    this.sheets.push(created);
    return created;
  }

  register(key: string, address: Address): void {
    if (this.registry.has(key)) {
      throw new Error(`Cell key "${key}" was registered twice; keys must be unique.`);
    }
    this.registry.set(key, address);
  }

  defineName(name: string, address: Address): void {
    const safe = safeDefinedName(name);
    if (this.definedNames.has(safe)) {
      throw new Error(`Defined name "${safe}" was registered twice.`);
    }
    this.definedNames.set(safe, address);
  }

  get names(): ReadonlyMap<string, Address> {
    return this.definedNames;
  }

  address(key: string, period?: number): Address | undefined {
    return this.registry.get(seriesKey(key, period));
  }

  /** A resolver bound to `fromSheet`, so same-sheet references stay unqualified. */
  resolver(fromSheet: string): RefResolver {
    const find = (key: string, period?: number): Address => {
      const full = seriesKey(key, period);
      const address = this.registry.get(full);
      if (!address) {
        throw new Error(
          `No cell is registered under "${full}". A formula asked for it, so either ` +
            'the key is misspelled or the sheet that defines it was not built.',
        );
      }
      return address;
    };

    return {
      ref: (key, period) => refTo(find(key, period), fromSheet),
      absRef: (key, period) =>
        refTo(find(key, period), fromSheet, { absoluteColumn: true, absoluteRow: true }),
      range: (key, fromPeriod, toPeriod) => {
        if (toPeriod < fromPeriod) {
          throw new Error(`Range for "${key}" runs backwards: ${fromPeriod} to ${toPeriod}.`);
        }
        return rangeTo(find(key, fromPeriod), find(key, toPeriod), fromSheet);
      },
      name: (definedName) => {
        const safe = safeDefinedName(definedName);
        if (!this.definedNames.has(safe)) {
          throw new Error(`Defined name "${safe}" is used by a formula but was never defined.`);
        }
        return safe;
      },
      has: (key, period) => this.registry.has(seriesKey(key, period)),
    };
  }

  /** Every defined name as `name -> 'Sheet'!$A$1`. */
  definedNameEntries(): Array<{ name: string; ref: string }> {
    return [...this.definedNames].map(([name, address]) => ({ name, ref: absoluteRef(address) }));
  }
}

/** `('cashFlow.noi', 12)` → `'cashFlow.noi#12'`; scalars keep their bare key. */
export function seriesKey(key: string, period?: number): string {
  return period === undefined ? key : `${key}#${period}`;
}

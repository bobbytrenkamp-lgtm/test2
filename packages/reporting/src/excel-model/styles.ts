import type { CellKind, NumberFormatName } from './model.js';

/**
 * Workbook presentation, defined once.
 *
 * The convention is the one financial models have used for decades, because an
 * analyst opening the file already knows how to read it: **blue means you may
 * type here**, black means the cell is calculated on its own sheet, green means
 * it is calculated from another sheet. Nothing else needs explaining.
 *
 * Deliberately thin. Formatting is the lowest priority of this feature, and a
 * workbook whose value depended on its borders would be the wrong deliverable.
 */

export const FONT_COLOURS = {
  /** Editable assumption. */
  input: 'FF0000C0',
  /** Calculated on this sheet. */
  formula: 'FF000000',
  /** Pulled from another sheet. */
  crossSheet: 'FF006100',
  /** Derived, but exported as a number rather than a formula. */
  staticDerived: 'FF9C5700',
  label: 'FF000000',
  header: 'FFFFFFFF',
} as const;

export const HEADER_FILL = 'FF1F3548';
export const SECTION_FILL = 'FFEDEFF2';

/**
 * Number formats.
 *
 * Negatives are parenthesised rather than signed, which is the accounting
 * convention and the one every CRE model uses. `percent2` exists for rates
 * where the second decimal is meaningful — a cap rate of 5.25% is a different
 * asset from one at 5.3%.
 */
export const NUMBER_FORMATS: Record<NumberFormatName, string> = {
  currency: '#,##0.00;(#,##0.00)',
  currency0: '#,##0;(#,##0)',
  percent: '0.0%;(0.0%)',
  percent2: '0.00%;(0.00%)',
  multiple: '0.00"x"',
  area: '#,##0',
  integer: '#,##0',
  date: 'yyyy-mm-dd',
  text: '@',
  ratio: '0.00',
};

/**
 * Which colour a cell takes.
 *
 * A formula is green when it names another sheet and black when it does not.
 * Deciding from the formula text rather than from a flag the builder has to
 * remember to set means the colour cannot disagree with the formula.
 */
export function fontColour(kind: CellKind, formula?: string): string {
  switch (kind) {
    case 'input':
      return FONT_COLOURS.input;
    case 'staticDerived':
      return FONT_COLOURS.staticDerived;
    case 'formula':
      return formula !== undefined && /!/.test(formula)
        ? FONT_COLOURS.crossSheet
        : FONT_COLOURS.formula;
    case 'header':
      return FONT_COLOURS.header;
    default:
      return FONT_COLOURS.label;
  }
}

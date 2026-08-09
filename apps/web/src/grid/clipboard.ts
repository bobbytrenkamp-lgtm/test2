import { detectDelimiter, parseCsv } from '@cre/reporting/parsing';
import type { CellRef, Selection } from './selection.js';
import { rect } from './selection.js';

/**
 * Copy and paste between the grid and a spreadsheet.
 *
 * The clipboard is the actual integration surface between this product and
 * Excel, so it has to behave the way Excel does or it is worse than useless.
 *
 * ## Reading
 *
 * Parsing is delegated to the import pipeline (`@cre/reporting/parsing`), which
 * already handles the things clipboard text actually contains: tab or comma
 * delimiters, quoted fields with embedded delimiters and newlines, CRLF, and a
 * leading BOM. A second parser written here would eventually disagree with the
 * importer about the same block of text.
 *
 * ## Writing
 *
 * Tab-separated, because that is what every spreadsheet expects on paste. A
 * value containing a tab, a newline or a quote is quoted and its quotes
 * doubled — the same convention `toCsv` uses, applied with a tab.
 */

/** A single write a paste wants to perform, before any column has parsed it. */
export interface PastePlanEntry {
  ref: CellRef;
  /** The raw clipboard text. The column decides what it means. */
  raw: string;
}

export interface PastePlan {
  entries: PastePlanEntry[];
  /** Rows the clipboard offered that fell past the end of the grid. */
  droppedRows: number;
  /** Columns the clipboard offered that fell past the last column. */
  droppedCols: number;
}

/** Serialises the selected rectangle as the clipboard's tab-separated text. */
export function serialiseRange(selection: Selection, read: (ref: CellRef) => string): string {
  const area = rect(selection);
  const lines: string[] = [];
  for (let row = area.top; row <= area.bottom; row += 1) {
    const cells: string[] = [];
    for (let col = area.left; col <= area.right; col += 1) {
      cells.push(escapeCell(read({ row, col })));
    }
    lines.push(cells.join('\t'));
  }
  return lines.join('\n');
}

function escapeCell(value: string): string {
  return /[\t\n\r"]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

/** Parses clipboard text into a rectangle of raw strings. */
export function parseClipboard(text: string): string[][] {
  if (text === '') return [];
  const rows = parseCsv(text, { delimiter: detectDelimiter(text) });
  /*
   * A trailing newline is normal — Excel puts one on every copy — and it
   * produces a final row of one empty cell. Dropping it stops a paste from
   * blanking the row below the data.
   */
  while (rows.length > 0) {
    const last = rows[rows.length - 1];
    if (last && last.length === 1 && last[0] === '') rows.pop();
    else break;
  }
  return rows;
}

/**
 * Works out what a paste would write, without writing anything.
 *
 * Two behaviours, both taken from what spreadsheets do and what analysts
 * therefore expect:
 *
 * - **A single copied cell fills the whole selection.** Selecting forty rows of
 *   renewal probability and pasting one value sets all forty. This is the same
 *   gesture as fill-down and is how a bulk edit usually actually happens.
 * - **A block anchors at the selection's top-left and extends as far as it
 *   goes**, regardless of how large the selection was. Pasting six rows into a
 *   one-cell selection writes six rows.
 *
 * What it deliberately does *not* do is tile a block to fill a larger
 * selection. Excel does that only for exact multiples and silently refuses
 * otherwise; the rule is hard to predict, and on a rent roll a mistaken tile
 * would write plausible values into leases the analyst never looked at.
 *
 * Anything falling past the last row or column is dropped and counted, so the
 * caller can say "12 rows did not fit" rather than silently losing them.
 */
export function planPaste(
  clip: string[][],
  selection: Selection,
  bounds: { rows: number; cols: number },
): PastePlan {
  const area = rect(selection);
  const entries: PastePlanEntry[] = [];

  const single = clip.length === 1 && clip[0]?.length === 1;
  if (single) {
    const raw = clip[0]?.[0] ?? '';
    for (let row = area.top; row <= Math.min(area.bottom, bounds.rows - 1); row += 1) {
      for (let col = area.left; col <= Math.min(area.right, bounds.cols - 1); col += 1) {
        entries.push({ ref: { row, col }, raw });
      }
    }
    return { entries, droppedRows: 0, droppedCols: 0 };
  }

  let droppedRows = 0;
  let droppedCols = 0;
  for (let r = 0; r < clip.length; r += 1) {
    const row = area.top + r;
    if (row >= bounds.rows) {
      droppedRows += 1;
      continue;
    }
    const cells = clip[r] ?? [];
    for (let c = 0; c < cells.length; c += 1) {
      const col = area.left + c;
      if (col >= bounds.cols) {
        // Counted once per column past the edge, not once per cell, so the
        // message reads "2 columns did not fit" rather than "40".
        if (r === 0) droppedCols += 1;
        continue;
      }
      entries.push({ ref: { row, col }, raw: cells[c] ?? '' });
    }
  }

  return { entries, droppedRows, droppedCols };
}

/**
 * The rectangle a fill-down covers: every row of the selection below its first,
 * taking each column's value from that first row.
 *
 * Returns the source row alongside each target so the caller can copy a value
 * across without re-deriving which row it came from.
 */
export function planFillDown(selection: Selection): Array<{ from: CellRef; to: CellRef }> {
  const area = rect(selection);
  const plan: Array<{ from: CellRef; to: CellRef }> = [];
  for (let col = area.left; col <= area.right; col += 1) {
    for (let row = area.top + 1; row <= area.bottom; row += 1) {
      plan.push({ from: { row: area.top, col }, to: { row, col } });
    }
  }
  return plan;
}

/**
 * The selection model, as pure data.
 *
 * A spreadsheet selection is two cells, not a set: an **anchor** where the
 * selection started and a **focus** where it currently ends. Everything else —
 * which cells are highlighted, what a copy produces, where a paste lands, which
 * cell an arrow key moves — is derived from that pair.
 *
 * Storing it as a set of coordinates would look simpler and would be wrong:
 * shift-clicking above the anchor has to grow the selection upward, and a set
 * has forgotten which end is which. Every rectangle here is therefore derived
 * on demand and normalised at the point of use, never stored pre-sorted.
 *
 * This module is deliberately free of React and of any knowledge of what a cell
 * contains. It is the part of grid behaviour that can be reasoned about, so it
 * is the part that is tested directly.
 */

export interface CellRef {
  row: number;
  col: number;
}

export interface Selection {
  /** Where the selection began. Fixed while the focus moves. */
  anchor: CellRef;
  /** The active cell. This is the one that shows the edit caret. */
  focus: CellRef;
}

/** A selection as a rectangle, with the ends sorted. */
export interface Rect {
  top: number;
  left: number;
  bottom: number;
  right: number;
}

export interface Bounds {
  rows: number;
  cols: number;
}

export function cell(row: number, col: number): CellRef {
  return { row, col };
}

export function single(ref: CellRef): Selection {
  return { anchor: ref, focus: ref };
}

export function sameCell(a: CellRef, b: CellRef): boolean {
  return a.row === b.row && a.col === b.col;
}

/** The selection as a sorted rectangle. */
export function rect(selection: Selection): Rect {
  const { anchor, focus } = selection;
  return {
    top: Math.min(anchor.row, focus.row),
    bottom: Math.max(anchor.row, focus.row),
    left: Math.min(anchor.col, focus.col),
    right: Math.max(anchor.col, focus.col),
  };
}

export function contains(selection: Selection, ref: CellRef): boolean {
  const area = rect(selection);
  return (
    ref.row >= area.top && ref.row <= area.bottom && ref.col >= area.left && ref.col <= area.right
  );
}

/** How many cells the selection covers. Used for "14 records will be updated". */
export function size(selection: Selection): { rows: number; cols: number; cells: number } {
  const area = rect(selection);
  const rows = area.bottom - area.top + 1;
  const cols = area.right - area.left + 1;
  return { rows, cols, cells: rows * cols };
}

/** Every row index the selection touches, in order. */
export function selectedRows(selection: Selection): number[] {
  const area = rect(selection);
  const rows: number[] = [];
  for (let row = area.top; row <= area.bottom; row += 1) rows.push(row);
  return rows;
}

function clamp(value: number, max: number): number {
  if (max <= 0) return 0;
  return Math.min(Math.max(value, 0), max - 1);
}

export function clampRef(ref: CellRef, bounds: Bounds): CellRef {
  return { row: clamp(ref.row, bounds.rows), col: clamp(ref.col, bounds.cols) };
}

export type Direction = 'up' | 'down' | 'left' | 'right';

const DELTAS: Record<Direction, CellRef> = {
  up: { row: -1, col: 0 },
  down: { row: 1, col: 0 },
  left: { row: 0, col: -1 },
  right: { row: 0, col: 1 },
};

/**
 * Moves the focus, optionally extending the selection.
 *
 * Extending moves the focus and leaves the anchor, which is what makes
 * `Shift+Down` grow downward from where the selection started rather than from
 * wherever the focus happens to be. A plain move collapses to a single cell,
 * because that is what an unmodified arrow key means everywhere else.
 */
export function move(
  selection: Selection,
  direction: Direction,
  bounds: Bounds,
  options: { extend?: boolean } = {},
): Selection {
  const delta = DELTAS[direction];
  const focus = clampRef(
    { row: selection.focus.row + delta.row, col: selection.focus.col + delta.col },
    bounds,
  );
  return options.extend ? { anchor: selection.anchor, focus } : single(focus);
}

/**
 * Jumps to an edge, the way Ctrl/Cmd + arrow does in a spreadsheet.
 *
 * There is no "jump to the next populated cell" here. That behaviour depends on
 * the data, and a grid over a rent roll has no blank runs worth skipping — every
 * row is a lease. Jumping to the edge is the part that is genuinely useful for
 * getting from lease 1 to lease 300.
 */
export function moveToEdge(
  selection: Selection,
  direction: Direction,
  bounds: Bounds,
  options: { extend?: boolean } = {},
): Selection {
  const focus: CellRef = { ...selection.focus };
  if (direction === 'up') focus.row = 0;
  if (direction === 'down') focus.row = Math.max(bounds.rows - 1, 0);
  if (direction === 'left') focus.col = 0;
  if (direction === 'right') focus.col = Math.max(bounds.cols - 1, 0);
  return options.extend ? { anchor: selection.anchor, focus } : single(focus);
}

/** Whole rows, from a click on a row header or Shift+Space. */
export function selectRows(from: number, to: number, bounds: Bounds): Selection {
  return {
    anchor: clampRef({ row: from, col: 0 }, bounds),
    focus: clampRef({ row: to, col: bounds.cols - 1 }, bounds),
  };
}

export function selectAll(bounds: Bounds): Selection {
  return {
    anchor: { row: 0, col: 0 },
    focus: clampRef({ row: bounds.rows - 1, col: bounds.cols - 1 }, bounds),
  };
}

/**
 * Advances after a committed edit.
 *
 * `Enter` goes down a row and returns to the column the entry started in;
 * `Tab` goes right and wraps to the next row. Both are what a spreadsheet does,
 * and both matter more than they look: typing a column of rents is `value Enter
 * value Enter`, and having the caret land anywhere else makes the grid unusable
 * for the job it exists to do.
 *
 * Neither wraps past the end of the grid. Running off the bottom of a rent roll
 * and reappearing at the top would silently move an analyst to a different
 * lease than the one they think they are typing into.
 */
export function advance(
  selection: Selection,
  key: 'enter' | 'tab',
  bounds: Bounds,
  options: { backwards?: boolean } = {},
): Selection {
  const back = options.backwards === true;
  const { row, col } = selection.focus;

  if (key === 'enter') {
    const next = back ? row - 1 : row + 1;
    if (next < 0 || next >= bounds.rows) return selection;
    return single({ row: next, col });
  }

  const nextCol = back ? col - 1 : col + 1;
  if (nextCol >= 0 && nextCol < bounds.cols) return single({ row, col: nextCol });

  // Wrapped off the end of the row: step to the next row's far side.
  const nextRow = back ? row - 1 : row + 1;
  if (nextRow < 0 || nextRow >= bounds.rows) return selection;
  return single({ row: nextRow, col: back ? bounds.cols - 1 : 0 });
}

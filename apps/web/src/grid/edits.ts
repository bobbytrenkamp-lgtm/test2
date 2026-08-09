/**
 * Pending edits, and undo over them.
 *
 * ## Why edits are held before they are written
 *
 * A lease is validated as a whole: its dates, area and rent have to agree with
 * one another, and the rent roll has always saved one whole record or nothing.
 * A grid, meanwhile, edits one cell at a time. Writing each keystroke straight
 * through would mean a lease briefly expiring before it commences every time
 * someone edits a term, and a server round trip per cell.
 *
 * So the grid keeps a **pending layer** over the loaded rows. Edits accumulate
 * against it, the grid shows what has changed and how many, and saving sends
 * each touched row through the existing whole-record endpoint with its
 * whole-record validation intact. Cell editing becomes the input method; the
 * record is still the unit of truth.
 *
 * ## What undo actually restores
 *
 * Because nothing is written until save, undo is not a visual trick: it removes
 * an edit from the layer, so the value reverts to what the model holds. Undo
 * after a save is a new edit that puts the old value back, which the analyst
 * then saves — there is no pretending a written version can be un-written, and
 * the model's own versioning is what covers that case.
 *
 * History is bounded. An analyst pasting a thousand-row rent roll should not be
 * able to make the tab consume unbounded memory, and nobody has ever wanted the
 * two-hundredth undo.
 */

/** One field of one row, changed. */
export interface CellEdit {
  /** Stable row identity — a lease code, not a row index, which sorting moves. */
  rowId: string;
  field: string;
  /** The value before this edit. `null` means "no pending edit existed". */
  before: string | null;
  after: string;
}

/**
 * A group of edits applied together and undone together.
 *
 * A paste of forty cells is one thing the analyst did, so it is one thing undo
 * takes back. Typing forty values one at a time is forty.
 */
export interface EditBatch {
  /** Shown in the undo tooltip: "Undo paste of 40 cells". */
  label: string;
  edits: CellEdit[];
}

export type PendingEdits = Record<string, Record<string, string>>;

export const HISTORY_LIMIT = 100;

export interface EditState {
  pending: PendingEdits;
  past: EditBatch[];
  future: EditBatch[];
}

export function emptyEditState(): EditState {
  return { pending: {}, past: [], future: [] };
}

/** The pending value for a field, or undefined when the row is untouched. */
export function pendingValue(state: EditState, rowId: string, field: string): string | undefined {
  return state.pending[rowId]?.[field];
}

export function isDirty(state: EditState): boolean {
  return Object.keys(state.pending).length > 0;
}

/** Row ids with at least one pending change, in insertion order. */
export function dirtyRowIds(state: EditState): string[] {
  return Object.keys(state.pending);
}

export function changeCount(state: EditState): number {
  return Object.values(state.pending).reduce((total, row) => total + Object.keys(row).length, 0);
}

function withEdits(pending: PendingEdits, edits: CellEdit[]): PendingEdits {
  const next: PendingEdits = {};
  for (const [rowId, fields] of Object.entries(pending)) next[rowId] = { ...fields };

  for (const edit of edits) {
    const row = next[edit.rowId] ?? {};
    row[edit.field] = edit.after;
    next[edit.rowId] = row;
  }
  return next;
}

function reverting(pending: PendingEdits, edits: CellEdit[]): PendingEdits {
  const next: PendingEdits = {};
  for (const [rowId, fields] of Object.entries(pending)) next[rowId] = { ...fields };

  // Reversed, so that two edits to the same cell in one batch unwind in the
  // order they were applied and the earliest `before` is the one that lands.
  for (const edit of [...edits].reverse()) {
    const row = next[edit.rowId];
    if (!row) continue;
    if (edit.before === null) delete row[edit.field];
    else row[edit.field] = edit.before;
    // A row with nothing pending is removed rather than left as an empty
    // object, so "3 unsaved changes" never counts a row back to clean.
    if (Object.keys(row).length === 0) delete next[edit.rowId];
    else next[edit.rowId] = row;
  }
  return next;
}

/**
 * Applies a batch and records it.
 *
 * Edits that change nothing are dropped first: pasting a column of values that
 * happen to match, or filling a value down over itself, should not leave the
 * model looking modified or put a no-op on the undo stack.
 */
export function apply(state: EditState, batch: EditBatch): EditState {
  const edits = batch.edits.filter((edit) => {
    const current = state.pending[edit.rowId]?.[edit.field];
    return (current ?? null) !== edit.after;
  });
  if (edits.length === 0) return state;

  const past = [...state.past, { ...batch, edits }];
  return {
    pending: withEdits(state.pending, edits),
    // Trimmed from the front: the oldest history is the least valuable.
    past: past.length > HISTORY_LIMIT ? past.slice(past.length - HISTORY_LIMIT) : past,
    // A new edit after undoing discards the redo branch, as every editor does.
    future: [],
  };
}

export function undo(state: EditState): EditState {
  const batch = state.past[state.past.length - 1];
  if (!batch) return state;
  return {
    pending: reverting(state.pending, batch.edits),
    past: state.past.slice(0, -1),
    future: [batch, ...state.future],
  };
}

export function redo(state: EditState): EditState {
  const batch = state.future[0];
  if (!batch) return state;
  return {
    pending: withEdits(state.pending, batch.edits),
    past: [...state.past, batch],
    future: state.future.slice(1),
  };
}

export function canUndo(state: EditState): boolean {
  return state.past.length > 0;
}

export function canRedo(state: EditState): boolean {
  return state.future.length > 0;
}

/**
 * Clears the pending layer after a successful save.
 *
 * History goes with it. Once the values are in the model, an undo stack whose
 * `before` values describe a state the server no longer holds would restore
 * figures that are no longer anybody's, so it is discarded rather than left to
 * look usable.
 */
export function committed(): EditState {
  return emptyEditState();
}

/** Builds the batch a set of writes implies, given what each cell holds now. */
export function batchFrom(
  label: string,
  writes: Array<{ rowId: string; field: string; value: string }>,
  currentPending: (rowId: string, field: string) => string | undefined,
): EditBatch {
  return {
    label,
    edits: writes.map((write) => ({
      rowId: write.rowId,
      field: write.field,
      before: currentPending(write.rowId, write.field) ?? null,
      after: write.value,
    })),
  };
}

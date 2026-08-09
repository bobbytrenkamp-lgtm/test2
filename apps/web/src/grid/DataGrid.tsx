import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { parseClipboard, planFillDown, planPaste, serialiseRange } from './clipboard.js';
import { DENSITY_ROW_HEIGHT, type ColumnDef, type Density } from './columns.js';
import {
  advance,
  cell,
  contains,
  move,
  moveToEdge,
  rect,
  sameCell,
  selectAll,
  single,
  size,
  type CellRef,
  type Direction,
  type Selection,
} from './selection.js';

/**
 * A spreadsheet-grade grid.
 *
 * The interaction model is Excel's, because that is the one every analyst using
 * this already has in their fingers: a selection that extends from an anchor,
 * arrow keys that move it, typing that replaces, Enter that goes down, Tab that
 * goes across, and a clipboard that talks to real spreadsheets.
 *
 * ## What it does and does not own
 *
 * It owns *interaction*: selection, the caret, the clipboard, fill-down and the
 * keyboard. It owns nothing about persistence — values come in through
 * `valueFor` and changes go out through `onEdit`, so the same grid serves a rent
 * roll, an expense schedule or a debt table without knowing what any of them
 * mean. Parsing is the column's job (`ColumnDef.parse`), which is what keeps the
 * import pipeline's rules in one place.
 *
 * ## Accessibility
 *
 * A `role="grid"` with one tab stop, which is the pattern assistive technology
 * expects of a spreadsheet: Tab enters and leaves, arrows move within. Every
 * cell carries `aria-selected` and the active one gets focus, so a screen
 * reader announces the move rather than the whole table. Every mouse gesture
 * here has a keyboard equivalent, and the toolbar states the shortcut on each
 * button rather than assuming it is known.
 */

export interface DataGridProps<Row> {
  rows: Row[];
  columns: Array<ColumnDef<Row>>;
  /** Stable identity per row — a lease code, not an index, which sorting moves. */
  rowId: (row: Row) => string;
  /** The value to show, after any pending edit. */
  valueFor: (row: Row, column: ColumnDef<Row>) => string;
  /** True when this cell carries an unsaved change. */
  isEdited?: (row: Row, column: ColumnDef<Row>) => boolean;
  /** A per-cell problem to surface, e.g. a value the column refused. */
  problemFor?: (row: Row, column: ColumnDef<Row>) => string | undefined;
  /** Applies a set of writes as one undoable action. */
  onEdit: (writes: Array<{ rowId: string; field: string; value: string }>, label: string) => void;
  /** Reports a refusal, so the page can show it once rather than per cell. */
  onRejected?: (problems: Array<{ rowId: string; field: string; reason: string }>) => void;
  editable?: boolean;
  density?: Density;
  /**
   * The row the caret is on, reported as it moves.
   *
   * Lets the page offer an action against what the analyst is actually looking
   * at — "Edit lease OFF-101" rather than a button that guesses at the first
   * row — without the grid knowing what that action is.
   */
  onFocusedRowChange?: (row: Row | null) => void;
  /**
   * Which column the rows are ordered by, so the header can say so.
   *
   * The grid does not sort — the page does, because only it knows how a lease
   * code compares to a date. But `aria-sort` has to live on the header, so the
   * state is passed down rather than the behaviour passed up.
   */
  sortedBy?: { columnKey: string; ascending: boolean };
  /** Announced to assistive technology; also the table's caption. */
  label: string;
  /** Rendered to the right of the built-in toolbar buttons. */
  toolbar?: React.ReactNode;
  emptyState?: React.ReactNode;
}

interface EditingState {
  ref: CellRef;
  /** What the user has typed so far. */
  draft: string;
}

export function DataGrid<Row>({
  rows,
  columns,
  rowId,
  valueFor,
  isEdited,
  problemFor,
  onEdit,
  onRejected,
  editable = true,
  density = 'standard',
  onFocusedRowChange,
  sortedBy,
  label,
  toolbar,
  emptyState,
}: DataGridProps<Row>): JSX.Element {
  const [selection, setSelection] = useState<Selection>(() => single(cell(0, 0)));
  const [editing, setEditing] = useState<EditingState | null>(null);
  const [dragging, setDragging] = useState(false);
  const [status, setStatus] = useState<string>('');
  const gridRef = useRef<HTMLTableElement>(null);
  const editorRef = useRef<HTMLInputElement | HTMLSelectElement>(null);

  const bounds = useMemo(
    () => ({ rows: rows.length, cols: columns.length }),
    [rows.length, columns.length],
  );

  /*
   * Keep the selection inside the grid when the data underneath changes — a
   * filter that removes rows must not leave the caret pointing past the end,
   * where every subsequent keystroke would read `undefined`.
   */
  useEffect(() => {
    setSelection((current) => {
      const focus = {
        row: Math.min(current.focus.row, Math.max(bounds.rows - 1, 0)),
        col: Math.min(current.focus.col, Math.max(bounds.cols - 1, 0)),
      };
      const anchor = {
        row: Math.min(current.anchor.row, Math.max(bounds.rows - 1, 0)),
        col: Math.min(current.anchor.col, Math.max(bounds.cols - 1, 0)),
      };
      if (sameCell(focus, current.focus) && sameCell(anchor, current.anchor)) return current;
      return { anchor, focus };
    });
  }, [bounds.rows, bounds.cols]);

  useEffect(() => {
    if (editing) editorRef.current?.focus();
  }, [editing]);

  useEffect(() => {
    onFocusedRowChange?.(rows[selection.focus.row] ?? null);
  }, [rows, selection.focus.row, onFocusedRowChange]);

  const columnAt = useCallback((index: number) => columns[index], [columns]);
  const rowAt = useCallback((index: number) => rows[index], [rows]);

  const readCell = useCallback(
    (ref: CellRef): string => {
      const row = rowAt(ref.row);
      const column = columnAt(ref.col);
      if (!row || !column) return '';
      return valueFor(row, column);
    },
    [rowAt, columnAt, valueFor],
  );

  /** Turns raw text into writes, collecting whatever each column refuses. */
  const commitRaw = useCallback(
    (entries: Array<{ ref: CellRef; raw: string }>, label: string) => {
      if (!editable) return;
      const writes: Array<{ rowId: string; field: string; value: string }> = [];
      const problems: Array<{ rowId: string; field: string; reason: string }> = [];

      for (const entry of entries) {
        const row = rowAt(entry.ref.row);
        const column = columnAt(entry.ref.col);
        if (!row || !column || column.editable === false) continue;
        const id = rowId(row);
        const parsed = column.parse
          ? column.parse(entry.raw)
          : { ok: true as const, value: entry.raw };
        if (parsed.ok) writes.push({ rowId: id, field: column.key, value: parsed.value });
        else problems.push({ rowId: id, field: column.key, reason: parsed.reason });
      }

      if (writes.length > 0) onEdit(writes, label);
      if (problems.length > 0) onRejected?.(problems);
      return { written: writes.length, refused: problems.length };
    },
    [editable, rowAt, columnAt, rowId, onEdit, onRejected],
  );

  const copy = useCallback(async (): Promise<void> => {
    const text = serialiseRange(selection, readCell);
    try {
      await navigator.clipboard.writeText(text);
      const { cells } = size(selection);
      setStatus(`Copied ${cells} cell${cells === 1 ? '' : 's'}.`);
    } catch {
      // Denied clipboard permission is not an error worth interrupting for;
      // the keyboard's own copy will still have fired in most browsers.
      setStatus('Could not reach the clipboard.');
    }
  }, [selection, readCell]);

  const paste = useCallback(
    (text: string): void => {
      const clip = parseClipboard(text);
      if (clip.length === 0) return;
      const plan = planPaste(clip, selection, bounds);
      const result = commitRaw(plan.entries, `paste of ${plan.entries.length} cells`);

      const notes: string[] = [];
      if (result) notes.push(`Pasted ${result.written} cell${result.written === 1 ? '' : 's'}.`);
      if (plan.droppedRows > 0) notes.push(`${plan.droppedRows} row(s) did not fit.`);
      if (plan.droppedCols > 0) notes.push(`${plan.droppedCols} column(s) did not fit.`);
      if (result && result.refused > 0) notes.push(`${result.refused} value(s) refused.`);
      setStatus(notes.join(' '));
    },
    [selection, bounds, commitRaw],
  );

  const fillDown = useCallback((): void => {
    const plan = planFillDown(selection);
    if (plan.length === 0) {
      setStatus('Select more than one row to fill down.');
      return;
    }
    const entries = plan.map((step) => ({ ref: step.to, raw: readCell(step.from) }));
    const result = commitRaw(entries, `fill down ${plan.length} cells`);
    setStatus(`Filled ${result?.written ?? 0} cell${result?.written === 1 ? '' : 's'} down.`);
  }, [selection, readCell, commitRaw]);

  const clearSelection = useCallback((): void => {
    const area = rect(selection);
    const entries: Array<{ ref: CellRef; raw: string }> = [];
    for (let row = area.top; row <= area.bottom; row += 1) {
      for (let col = area.left; col <= area.right; col += 1)
        entries.push({ ref: { row, col }, raw: '' });
    }
    commitRaw(entries, `clear ${entries.length} cells`);
  }, [selection, commitRaw]);

  const beginEdit = useCallback(
    (ref: CellRef, initial?: string) => {
      if (!editable) return;
      const column = columnAt(ref.col);
      if (!column || column.editable === false) return;
      setEditing({ ref, draft: initial ?? readCell(ref) });
    },
    [editable, columnAt, readCell],
  );

  const commitEdit = useCallback(
    (next?: Selection) => {
      if (!editing) return;
      commitRaw([{ ref: editing.ref, raw: editing.draft }], 'edit');
      setEditing(null);
      if (next) setSelection(next);
      gridRef.current?.focus();
    },
    [editing, commitRaw],
  );

  const cancelEdit = useCallback(() => {
    setEditing(null);
    gridRef.current?.focus();
  }, []);

  /* ------------------------------------------------------------------ */
  /* Keyboard                                                            */
  /* ------------------------------------------------------------------ */

  const onKeyDown = useCallback(
    (event: React.KeyboardEvent): void => {
      if (editing) return;
      const meta = event.metaKey || event.ctrlKey;
      const key = event.key;

      const arrows: Record<string, Direction> = {
        ArrowUp: 'up',
        ArrowDown: 'down',
        ArrowLeft: 'left',
        ArrowRight: 'right',
      };
      const direction = arrows[key];
      if (direction) {
        event.preventDefault();
        setSelection((current) =>
          meta
            ? moveToEdge(current, direction, bounds, { extend: event.shiftKey })
            : move(current, direction, bounds, { extend: event.shiftKey }),
        );
        return;
      }

      if (key === 'Enter' && !meta) {
        event.preventDefault();
        // Enter opens the editor; Enter again commits and steps down. That is
        // F2-then-Enter in a spreadsheet, collapsed into one key because
        // nobody outside Excel knows what F2 does.
        beginEdit(selection.focus);
        return;
      }
      if (key === 'Tab') {
        event.preventDefault();
        setSelection((current) => advance(current, 'tab', bounds, { backwards: event.shiftKey }));
        return;
      }
      if (key === 'F2') {
        event.preventDefault();
        beginEdit(selection.focus);
        return;
      }
      if (key === 'Escape') {
        setSelection((current) => single(current.focus));
        return;
      }
      if ((key === 'Delete' || key === 'Backspace') && editable) {
        event.preventDefault();
        clearSelection();
        return;
      }
      if (meta && key.toLowerCase() === 'a') {
        event.preventDefault();
        setSelection(selectAll(bounds));
        return;
      }
      if (meta && key.toLowerCase() === 'c') {
        event.preventDefault();
        void copy();
        return;
      }
      if (meta && key.toLowerCase() === 'd' && editable) {
        event.preventDefault();
        fillDown();
        return;
      }
      /*
       * Any printable character starts an edit with that character, replacing
       * what was there. This is the single most-used gesture in a spreadsheet:
       * select a cell, type, move on. Modifier combinations are excluded so
       * Cmd+Z still reaches the page's undo.
       */
      if (!meta && !event.altKey && key.length === 1 && editable) {
        event.preventDefault();
        beginEdit(selection.focus, key);
      }
    },
    [editing, bounds, selection.focus, beginEdit, clearSelection, copy, fillDown, editable],
  );

  const onPaste = useCallback(
    (event: React.ClipboardEvent): void => {
      if (editing || !editable) return;
      const text = event.clipboardData.getData('text/plain');
      if (!text) return;
      event.preventDefault();
      paste(text);
    },
    [editing, editable, paste],
  );

  const onCopyEvent = useCallback(
    (event: React.ClipboardEvent): void => {
      if (editing) return;
      event.preventDefault();
      event.clipboardData.setData('text/plain', serialiseRange(selection, readCell));
      const { cells } = size(selection);
      setStatus(`Copied ${cells} cell${cells === 1 ? '' : 's'}.`);
    },
    [editing, selection, readCell],
  );

  /* ------------------------------------------------------------------ */
  /* Mouse                                                               */
  /* ------------------------------------------------------------------ */

  useEffect(() => {
    if (!dragging) return;
    const stop = (): void => setDragging(false);
    window.addEventListener('mouseup', stop);
    return () => window.removeEventListener('mouseup', stop);
  }, [dragging]);

  const onCellMouseDown = (ref: CellRef, event: React.MouseEvent): void => {
    if (event.button !== 0) return;
    gridRef.current?.focus();
    if (event.shiftKey) setSelection((current) => ({ anchor: current.anchor, focus: ref }));
    else {
      setSelection(single(ref));
      setDragging(true);
    }
  };

  const onCellMouseEnter = (ref: CellRef): void => {
    if (dragging) setSelection((current) => ({ anchor: current.anchor, focus: ref }));
  };

  const selectionSize = size(selection);
  const rowHeight = DENSITY_ROW_HEIGHT[density];

  /* Frozen columns need their cumulative offset to stick at. */
  const frozenOffsets = useMemo(() => {
    const offsets: number[] = [];
    let running = 0;
    for (const column of columns) {
      offsets.push(running);
      if (column.frozen) running += column.width;
    }
    return offsets;
  }, [columns]);

  if (rows.length === 0 && emptyState) return <>{emptyState}</>;

  return (
    <div className="grid-shell">
      <div className="grid-toolbar row" role="toolbar" aria-label={`${label} actions`}>
        {editable && (
          <>
            <button
              type="button"
              className="subtle"
              onClick={fillDown}
              disabled={selectionSize.rows < 2}
              title="Fill the top row's values down through the selection (Ctrl/Cmd + D)"
            >
              Fill down
            </button>
            <button
              type="button"
              className="subtle"
              onClick={() => void copy()}
              title="Copy the selection (Ctrl/Cmd + C)"
            >
              Copy
            </button>
          </>
        )}
        <span className="field-hint" aria-hidden="true">
          {selectionSize.cells > 1
            ? `${selectionSize.rows} × ${selectionSize.cols} selected`
            : 'Type to edit · Enter to confirm · Ctrl/Cmd+D fills down'}
        </span>
        <div className="spacer" />
        {toolbar}
      </div>

      {/* Announced politely so a screen reader hears the outcome of a paste or
          a fill without being interrupted mid-navigation. */}
      <p className="visually-hidden" role="status" aria-live="polite">
        {status}
      </p>

      {/*
       * `role="grid"` sits on the table, not on the scroll container.
       *
       * A grid must contain rows, and the container's only child is the table
       * element itself — so putting the role outside produced a critical
       * `aria-required-children` violation. On the table, `thead`/`tbody` map to
       * `rowgroup` and `tr`/`td` to `row`/`gridcell` implicitly, which is the
       * structure the role promises. The table is also the tab stop, because
       * that is the thing being operated.
       */}
      <div className="grid-scroll">
        <table
          className="grid-table"
          ref={gridRef}
          role="grid"
          aria-label={label}
          aria-rowcount={rows.length + 1}
          aria-colcount={columns.length}
          aria-multiselectable="true"
          tabIndex={0}
          onKeyDown={onKeyDown}
          onPaste={onPaste}
          onCopy={onCopyEvent}
          style={{ ['--grid-row-height' as string]: `${rowHeight}px` }}
        >
          <caption className="visually-hidden">{label}</caption>
          <thead>
            <tr>
              {columns.map((column, index) => (
                <th
                  key={column.key}
                  scope="col"
                  aria-sort={
                    sortedBy?.columnKey === column.key
                      ? sortedBy.ascending
                        ? 'ascending'
                        : 'descending'
                      : undefined
                  }
                  className={[column.numeric ? 'numeric' : '', column.frozen ? 'grid-frozen' : '']
                    .filter(Boolean)
                    .join(' ')}
                  style={{
                    width: column.width,
                    minWidth: column.width,
                    ...(column.frozen ? { left: frozenOffsets[index] } : {}),
                  }}
                  {...(column.help ? { title: column.help } : {})}
                >
                  {column.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row, rowIndex) => (
              <tr key={rowId(row)}>
                {columns.map((column, colIndex) => {
                  const ref = cell(rowIndex, colIndex);
                  const selected = contains(selection, ref);
                  const active = sameCell(selection.focus, ref);
                  const editingHere = editing !== null && sameCell(editing.ref, ref);
                  const problem = problemFor?.(row, column);
                  const edited = isEdited?.(row, column) ?? false;
                  const value = valueFor(row, column);

                  return (
                    <td
                      key={column.key}
                      role="gridcell"
                      aria-selected={selected}
                      aria-readonly={column.editable === false || !editable}
                      {...(problem ? { 'aria-invalid': true, title: problem } : {})}
                      className={[
                        column.numeric ? 'numeric' : '',
                        column.frozen ? 'grid-frozen' : '',
                        selected ? 'is-selected' : '',
                        active ? 'is-active' : '',
                        edited ? 'is-edited' : '',
                        problem ? 'is-invalid' : '',
                      ]
                        .filter(Boolean)
                        .join(' ')}
                      style={{
                        width: column.width,
                        minWidth: column.width,
                        ...(column.frozen ? { left: frozenOffsets[colIndex] } : {}),
                      }}
                      onMouseDown={(event) => onCellMouseDown(ref, event)}
                      onMouseEnter={() => onCellMouseEnter(ref)}
                      onDoubleClick={() => beginEdit(ref)}
                    >
                      {editingHere ? (
                        <CellEditor
                          column={column}
                          draft={editing.draft}
                          inputRef={editorRef}
                          onChange={(draft) => setEditing({ ref, draft })}
                          onCommit={(next) => commitEdit(next)}
                          onCancel={cancelEdit}
                          bounds={bounds}
                          selection={selection}
                        />
                      ) : (
                        <span className="grid-value">
                          {column.display ? column.display(row, value) : value}
                        </span>
                      )}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function CellEditor<Row>({
  column,
  draft,
  inputRef,
  onChange,
  onCommit,
  onCancel,
  bounds,
  selection,
}: {
  column: ColumnDef<Row>;
  draft: string;
  inputRef: React.RefObject<HTMLInputElement | HTMLSelectElement>;
  onChange: (draft: string) => void;
  onCommit: (next?: Selection) => void;
  onCancel: () => void;
  bounds: { rows: number; cols: number };
  selection: Selection;
}): JSX.Element {
  const handleKey = (event: React.KeyboardEvent): void => {
    if (event.key === 'Enter') {
      event.preventDefault();
      onCommit(advance(selection, 'enter', bounds, { backwards: event.shiftKey }));
      return;
    }
    if (event.key === 'Tab') {
      event.preventDefault();
      onCommit(advance(selection, 'tab', bounds, { backwards: event.shiftKey }));
      return;
    }
    if (event.key === 'Escape') {
      event.preventDefault();
      onCancel();
    }
  };

  if (column.options) {
    return (
      <select
        ref={inputRef as React.RefObject<HTMLSelectElement>}
        className="grid-editor"
        aria-label={column.label}
        value={draft}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={handleKey}
        onBlur={() => onCommit()}
      >
        {column.options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    );
  }

  return (
    <input
      ref={inputRef as React.RefObject<HTMLInputElement>}
      className="grid-editor"
      aria-label={column.label}
      value={draft}
      // Selected on focus so typing replaces, which is what a spreadsheet does
      // when you type over a cell rather than double-clicking into it.
      onFocus={(event) => event.target.select()}
      onChange={(event) => onChange(event.target.value)}
      onKeyDown={handleKey}
      onBlur={() => onCommit()}
    />
  );
}

import { useCallback, useMemo, useState } from 'react';
import { ApiError } from '../api.js';
import { useEditShortcut, useLocalState, useUnsavedChangesWarning } from '../hooks.js';
import { DataGrid } from './DataGrid.js';
import { ColumnMenu, DensityMenu } from './GridControls.js';
import { resolveLayout, type ColumnDef, type ColumnLayout, type Density } from './columns.js';
import {
  apply as applyEdits,
  batchFrom,
  canRedo,
  canUndo,
  changeCount,
  committed,
  dirtyRowIds,
  emptyEditState,
  isDirty,
  pendingValue,
  redo as redoEdits,
  undo as undoEdits,
  type EditState,
} from './edits.js';

/**
 * A grid plus everything that has to surround one to be safe.
 *
 * The `DataGrid` owns interaction. This owns the *consequences* of interaction:
 * the pending layer, the count of unsaved changes, undo and redo, discard, the
 * save, and the column and density preferences. Every table that becomes
 * editable needs all of it, and reimplementing the change bar per table is how
 * one of them ends up silently writing on every keystroke.
 *
 * The caller supplies only what is specific to its data: the rows, the columns,
 * how to identify a row, how to merge a pending edit into one for display, and
 * how to save a set of changes.
 */

export interface EditableGridProps<Row> {
  rows: Row[];
  columns: Array<ColumnDef<Row>>;
  rowId: (row: Row) => string;
  /** Applies the pending fields to a row so the grid and any totals agree. */
  merge: (row: Row, pending: Record<string, string> | undefined) => Row;
  /**
   * Writes the changes. Resolves on success; the pending layer is cleared only
   * then, so a failed save leaves the analyst's work in front of them.
   */
  save: (changes: Array<{ rowId: string; fields: Record<string, string> }>) => Promise<void>;
  editable?: boolean;
  label: string;
  /** Distinguishes stored preferences, e.g. `expenses.<modelId>`. */
  preferenceKey: string;
  toolbar?: React.ReactNode;
  emptyState?: React.ReactNode;
  sortedBy?: { columnKey: string; ascending: boolean };
  onFocusedRowChange?: (row: Row | null) => void;
  /** Called after a successful save, to reload and recalculate. */
  onSaved?: () => void;
}

export function EditableGrid<Row>({
  rows,
  columns,
  rowId,
  merge,
  save,
  editable = true,
  label,
  preferenceKey,
  toolbar,
  emptyState,
  sortedBy,
  onFocusedRowChange,
  onSaved,
}: EditableGridProps<Row>): JSX.Element {
  const [layout, setLayout] = useLocalState<ColumnLayout | null>(
    `grid.layout.${preferenceKey}`,
    null,
  );
  const [density, setDensity] = useLocalState<Density>(`grid.density.${preferenceKey}`, 'standard');

  const [edits, setEdits] = useState<EditState>(emptyEditState);
  const [refusals, setRefusals] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);

  const shown = useMemo(() => resolveLayout(columns, layout), [columns, layout]);
  const merged = useMemo(
    () => rows.map((row) => merge(row, edits.pending[rowId(row)])),
    [rows, edits.pending, merge, rowId],
  );

  const dirty = isDirty(edits);
  const pendingCount = changeCount(edits);
  useUnsavedChangesWarning(dirty);

  const applyWrites = useCallback(
    (writes: Array<{ rowId: string; field: string; value: string }>, batchLabel: string) => {
      setRefusals([]);
      setError(null);
      setEdits((current) =>
        applyEdits(
          current,
          batchFrom(batchLabel, writes, (id, field) => pendingValue(current, id, field)),
        ),
      );
    },
    [],
  );

  const discard = useCallback(() => {
    setEdits(emptyEditState());
    setRefusals([]);
    setError(null);
  }, []);

  const commit = useCallback(async () => {
    const changes = dirtyRowIds(edits).flatMap((id) => {
      const fields = edits.pending[id];
      return fields && Object.keys(fields).length > 0 ? [{ rowId: id, fields }] : [];
    });
    if (changes.length === 0) return;
    setSaving(true);
    setError(null);
    try {
      await save(changes);
      setEdits(committed());
      onSaved?.();
    } catch (cause) {
      setError(
        cause instanceof ApiError
          ? cause
          : new ApiError(0, 'NETWORK_ERROR', 'The server could not be reached.'),
      );
    } finally {
      setSaving(false);
    }
  }, [edits, save, onSaved]);

  useEditShortcut('z', (event) => {
    if (!editable) return;
    setEdits((current) => (event.shiftKey ? redoEdits(current) : undoEdits(current)));
  });
  useEditShortcut('y', () => {
    if (editable) setEdits((current) => redoEdits(current));
  });

  return (
    <>
      {dirty && (
        <div className="message warning" role="status" aria-label={`Unsaved changes in ${label}`}>
          <div className="row">
            <strong>
              {pendingCount} unsaved change{pendingCount === 1 ? '' : 's'} across{' '}
              {dirtyRowIds(edits).length} row{dirtyRowIds(edits).length === 1 ? '' : 's'}
            </strong>
            <div className="spacer" />
            <button
              type="button"
              className="subtle"
              onClick={() => setEdits((current) => undoEdits(current))}
              disabled={!canUndo(edits)}
              title="Undo the last change (Ctrl/Cmd + Z)"
            >
              Undo
            </button>
            <button
              type="button"
              className="subtle"
              onClick={() => setEdits((current) => redoEdits(current))}
              disabled={!canRedo(edits)}
              title="Redo (Ctrl/Cmd + Shift + Z)"
            >
              Redo
            </button>
            <button type="button" onClick={discard} disabled={saving}>
              Discard all
            </button>
            <button
              type="button"
              className="primary"
              disabled={saving}
              onClick={() => void commit()}
            >
              {saving ? 'Saving…' : `Save ${pendingCount} change(s)`}
            </button>
          </div>
        </div>
      )}

      {error && (
        <div className="message error" role="alert">
          <strong>{error.message}</strong>
          <p style={{ marginBottom: 0 }}>
            {error.status === 409
              ? 'Nothing was saved. Reload to see the other change, then reapply yours.'
              : 'Nothing was saved, so your edits are still here. Correct the value and try again.'}
          </p>
        </div>
      )}

      {refusals.length > 0 && (
        <div className="message warning" role="alert">
          <strong>
            {refusals.length} value{refusals.length === 1 ? '' : 's'} could not be read
          </strong>
          <ul style={{ margin: '4px 0 0', paddingLeft: 18 }}>
            {refusals.slice(0, 6).map((reason, index) => (
              <li key={index}>{reason}</li>
            ))}
          </ul>
        </div>
      )}

      <DataGrid
        rows={merged}
        columns={shown}
        rowId={rowId}
        valueFor={(row, column) => column.value(row)}
        isEdited={(row, column) => pendingValue(edits, rowId(row), column.key) !== undefined}
        onEdit={applyWrites}
        onRejected={(problems) =>
          setRefusals(problems.map((problem) => `${problem.rowId}: ${problem.reason}`))
        }
        editable={editable}
        density={density}
        label={label}
        {...(sortedBy ? { sortedBy } : {})}
        {...(onFocusedRowChange ? { onFocusedRowChange } : {})}
        {...(emptyState ? { emptyState } : {})}
        toolbar={
          <>
            {toolbar}
            <ColumnMenu columns={columns} layout={layout} shown={shown} onChange={setLayout} />
            <DensityMenu density={density} onChange={setDensity} />
          </>
        }
      />
    </>
  );
}

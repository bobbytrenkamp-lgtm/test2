import { useEffect, useId, useRef, useState } from 'react';
import type { ColumnDef, ColumnLayout, Density } from './columns.js';

/**
 * The controls that sit above a grid: which columns show, in what order, and
 * how tightly the rows are packed.
 *
 * Both are disclosure menus rather than modal dialogs. Choosing columns is
 * something an analyst does *while* looking at the grid — to see whether the
 * one they just revealed is the one they wanted — and a modal that covers the
 * table makes that a guess followed by a second attempt.
 *
 * Reordering is done with buttons rather than drag-and-drop. Drag is faster
 * once you know it exists, but it is invisible, it is fiddly at this row
 * height, and it is unusable from a keyboard without building a parallel
 * interaction anyway. Buttons are the one implementation that serves everyone,
 * so they are what exists; a drag affordance can be added on top later without
 * changing the underlying layout model.
 */

function useDismissable(onClose: () => void): React.RefObject<HTMLDivElement> {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose();
    };
    const onClick = (event: MouseEvent): void => {
      if (!ref.current?.contains(event.target as Node)) onClose();
    };
    window.addEventListener('keydown', onKey);
    window.addEventListener('mousedown', onClick);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('mousedown', onClick);
    };
  }, [onClose]);
  return ref;
}

export function ColumnMenu<Row>({
  columns,
  layout,
  shown,
  onChange,
}: {
  columns: Array<ColumnDef<Row>>;
  layout: ColumnLayout | null;
  shown: Array<ColumnDef<Row>>;
  onChange: (layout: ColumnLayout) => void;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  const ref = useDismissable(() => setOpen(false));
  const id = useId();

  const hidden = new Set(
    columns.filter((c) => !shown.some((s) => s.key === c.key)).map((c) => c.key),
  );
  /* The current order as the analyst sees it, with hidden columns kept in place
     so toggling one back on does not move it to the end. */
  const order = layout?.order.filter((key) => columns.some((c) => c.key === key)) ?? [];
  const fullOrder = [...order, ...columns.filter((c) => !order.includes(c.key)).map((c) => c.key)];

  const emit = (nextOrder: string[], nextHidden: Set<string>): void =>
    onChange({ order: nextOrder, hidden: [...nextHidden] });

  const toggle = (key: string): void => {
    const next = new Set(hidden);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    emit(fullOrder, next);
  };

  const shift = (key: string, by: -1 | 1): void => {
    const from = fullOrder.indexOf(key);
    const to = from + by;
    if (from < 0 || to < 0 || to >= fullOrder.length) return;
    const next = [...fullOrder];
    const [moved] = next.splice(from, 1);
    if (moved !== undefined) next.splice(to, 0, moved);
    emit(next, hidden);
  };

  return (
    <div className="grid-menu" ref={ref}>
      <button
        type="button"
        className="subtle"
        aria-expanded={open}
        aria-controls={id}
        onClick={() => setOpen((value) => !value)}
      >
        Columns ({shown.length}/{columns.length})
      </button>
      {open && (
        <div className="grid-menu-panel" id={id} role="group" aria-label="Choose and order columns">
          <ul className="grid-menu-list">
            {fullOrder.map((key, index) => {
              const column = columns.find((c) => c.key === key);
              if (!column) return null;
              const visible = !hidden.has(key);
              return (
                <li key={key}>
                  <label>
                    <input type="checkbox" checked={visible} onChange={() => toggle(key)} />
                    <span>{column.label}</span>
                  </label>
                  <span className="grid-menu-actions">
                    <button
                      type="button"
                      className="subtle"
                      aria-label={`Move ${column.label} earlier`}
                      disabled={index === 0 || column.frozen}
                      onClick={() => shift(key, -1)}
                    >
                      ↑
                    </button>
                    <button
                      type="button"
                      className="subtle"
                      aria-label={`Move ${column.label} later`}
                      disabled={index === fullOrder.length - 1 || column.frozen}
                      onClick={() => shift(key, 1)}
                    >
                      ↓
                    </button>
                  </span>
                </li>
              );
            })}
          </ul>
          <p className="field-hint" style={{ margin: '8px 0 0' }}>
            Frozen columns stay leading, so they cannot be reordered past one another.
          </p>
          <button
            type="button"
            className="subtle"
            onClick={() => onChange({ order: columns.map((c) => c.key), hidden: [] })}
          >
            Show every column
          </button>
        </div>
      )}
    </div>
  );
}

const DENSITIES: Array<{ value: Density; label: string }> = [
  { value: 'comfortable', label: 'Comfortable' },
  { value: 'standard', label: 'Standard' },
  { value: 'compact', label: 'Compact' },
];

export function DensityMenu({
  density,
  onChange,
}: {
  density: Density;
  onChange: (density: Density) => void;
}): JSX.Element {
  const id = useId();
  return (
    <span className="row" style={{ gap: 4 }}>
      <label className="visually-hidden" htmlFor={id}>
        Row density
      </label>
      <select
        id={id}
        value={density}
        onChange={(event) => onChange(event.target.value as Density)}
        style={{ width: 'auto' }}
        title="How tightly rows are packed"
      >
        {DENSITIES.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </span>
  );
}

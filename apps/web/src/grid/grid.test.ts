import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  advance,
  cell,
  contains,
  move,
  moveToEdge,
  rect,
  selectAll,
  selectRows,
  single,
  size,
} from './selection.js';
import { parseClipboard, planFillDown, planPaste, serialiseRange } from './clipboard.js';
import {
  apply,
  batchFrom,
  canRedo,
  canUndo,
  changeCount,
  dirtyRowIds,
  emptyEditState,
  HISTORY_LIMIT,
  isDirty,
  pendingValue,
  redo,
  settled,
  undo,
} from './edits.js';
import {
  parseDate,
  parseDecimal,
  parsePercent,
  parseText,
  resolveLayout,
  type ColumnDef,
} from './columns.js';

/**
 * The grid's behaviour, tested where it can be reasoned about.
 *
 * Selection, clipboard and the edit layer are pure data, so they are tested
 * directly rather than through a rendered table. The component that draws them
 * is covered by the browser suite, where the thing worth checking is that a
 * keystroke reaches the model at all.
 */

const BOUNDS = { rows: 5, cols: 4 };

describe('selection', () => {
  it('normalises a rectangle dragged in any direction', () => {
    // Dragged up and to the left: the anchor is below-right of the focus, and
    // the rectangle still has to come out sorted.
    const upLeft = { anchor: cell(3, 3), focus: cell(1, 1) };
    expect(rect(upLeft)).toEqual({ top: 1, left: 1, bottom: 3, right: 3 });
    expect(size(upLeft)).toEqual({ rows: 3, cols: 3, cells: 9 });
    expect(contains(upLeft, cell(2, 2))).toBe(true);
    expect(contains(upLeft, cell(0, 2))).toBe(false);
  });

  it('extends from the anchor, not from the focus', () => {
    /*
     * The reason a selection is a pair rather than a set. Starting at row 2 and
     * shift-arrowing up twice must select rows 0 to 2 — if extension worked
     * from the focus, the second press would collapse the range instead of
     * growing it.
     */
    let selection = single(cell(2, 1));
    selection = move(selection, 'up', BOUNDS, { extend: true });
    selection = move(selection, 'up', BOUNDS, { extend: true });
    expect(rect(selection)).toEqual({ top: 0, left: 1, bottom: 2, right: 1 });
    expect(selection.anchor).toEqual(cell(2, 1));
  });

  it('collapses to one cell on an unmodified arrow key', () => {
    const extended = { anchor: cell(0, 0), focus: cell(3, 3) };
    const moved = move(extended, 'down', BOUNDS);
    expect(size(moved).cells).toBe(1);
    expect(moved.focus).toEqual(cell(4, 3));
  });

  it('stops at the edges rather than wrapping', () => {
    // Wrapping would move the analyst to a different lease than the one they
    // think they are on.
    expect(move(single(cell(0, 0)), 'up', BOUNDS).focus).toEqual(cell(0, 0));
    expect(move(single(cell(4, 3)), 'down', BOUNDS).focus).toEqual(cell(4, 3));
    expect(move(single(cell(0, 0)), 'left', BOUNDS).focus).toEqual(cell(0, 0));
  });

  it('jumps to an edge and can extend to it', () => {
    expect(moveToEdge(single(cell(2, 1)), 'down', BOUNDS).focus).toEqual(cell(4, 1));
    const extended = moveToEdge(single(cell(2, 1)), 'down', BOUNDS, { extend: true });
    expect(rect(extended)).toEqual({ top: 2, left: 1, bottom: 4, right: 1 });
  });

  it('selects whole rows and the whole grid', () => {
    expect(rect(selectRows(1, 3, BOUNDS))).toEqual({ top: 1, left: 0, bottom: 3, right: 3 });
    expect(size(selectAll(BOUNDS)).cells).toBe(20);
  });

  it('advances down on Enter, keeping the column', () => {
    // Typing a column of rents is value-Enter-value-Enter. Landing anywhere
    // else makes the grid useless for the job it exists for.
    const next = advance(single(cell(1, 2)), 'enter', BOUNDS);
    expect(next.focus).toEqual(cell(2, 2));
  });

  it('advances right on Tab and wraps to the next row', () => {
    expect(advance(single(cell(1, 2)), 'tab', BOUNDS).focus).toEqual(cell(1, 3));
    expect(advance(single(cell(1, 3)), 'tab', BOUNDS).focus).toEqual(cell(2, 0));
    expect(advance(single(cell(1, 0)), 'tab', BOUNDS, { backwards: true }).focus).toEqual(
      cell(0, 3),
    );
  });

  it('refuses to advance off the end of the grid', () => {
    const last = single(cell(4, 3));
    expect(advance(last, 'enter', BOUNDS).focus).toEqual(cell(4, 3));
    expect(advance(last, 'tab', BOUNDS).focus).toEqual(cell(4, 3));
  });
});

describe('clipboard', () => {
  const read = ({ row, col }: { row: number; col: number }): string => `r${row}c${col}`;

  it('serialises a rectangle as tab-separated rows', () => {
    const text = serialiseRange({ anchor: cell(0, 0), focus: cell(1, 1) }, read);
    expect(text).toBe('r0c0\tr0c1\nr1c0\tr1c1');
  });

  it('quotes a value that would otherwise break the format', () => {
    const text = serialiseRange(single(cell(0, 0)), () => 'Smith\tJones "and" Co');
    expect(text).toBe('"Smith\tJones ""and"" Co"');
    // And it survives the round trip back through the parser.
    expect(parseClipboard(text)[0]?.[0]).toBe('Smith\tJones "and" Co');
  });

  it('reads what a spreadsheet actually puts on the clipboard', () => {
    // Tabs, CRLF, and the trailing newline Excel always adds.
    const rows = parseClipboard('Suite\tArea\r\n101\t12,500\r\n');
    expect(rows).toEqual([
      ['Suite', 'Area'],
      ['101', '12,500'],
    ]);
  });

  it('does not blank the row below the data', () => {
    // The trailing newline must not become an empty row that a paste writes.
    expect(parseClipboard('a\nb\n')).toEqual([['a'], ['b']]);
  });

  it('fills the whole selection from a single copied cell', () => {
    // Selecting forty rows and pasting one value is how a bulk edit usually
    // actually happens.
    const plan = planPaste([['0.7']], { anchor: cell(1, 2), focus: cell(3, 2) }, BOUNDS);
    expect(plan.entries).toHaveLength(3);
    expect(plan.entries.every((entry) => entry.raw === '0.7')).toBe(true);
    expect(plan.entries.map((entry) => entry.ref.row)).toEqual([1, 2, 3]);
  });

  it('anchors a block at the top-left and extends past the selection', () => {
    // Pasting six rows into a one-cell selection writes six rows.
    const clip = [
      ['a', 'b'],
      ['c', 'd'],
      ['e', 'f'],
    ];
    const plan = planPaste(clip, single(cell(0, 0)), BOUNDS);
    expect(plan.entries).toHaveLength(6);
    expect(plan.entries[5]).toEqual({ ref: cell(2, 1), raw: 'f' });
  });

  it('drops what does not fit and says how much', () => {
    // Silently losing rows off the bottom of a rent roll is how a lease goes
    // missing, so the overflow is counted and reported.
    const clip = [['a', 'b', 'c', 'd', 'e', 'f']];
    const plan = planPaste(clip, single(cell(4, 2)), BOUNDS);
    expect(plan.entries).toHaveLength(2);
    expect(plan.droppedCols).toBe(4);

    const tall = [['a'], ['b'], ['c']];
    expect(planPaste(tall, single(cell(4, 0)), BOUNDS).droppedRows).toBe(2);
  });

  it('fills every selected column down from its first row', () => {
    const plan = planFillDown({ anchor: cell(1, 1), focus: cell(3, 2) });
    expect(plan).toHaveLength(4);
    expect(plan[0]).toEqual({ from: cell(1, 1), to: cell(2, 1) });
    expect(plan.every((entry) => entry.from.row === 1)).toBe(true);
  });

  it('fills nothing from a single row', () => {
    expect(planFillDown(single(cell(2, 1)))).toEqual([]);
  });
});

describe('the pending edit layer', () => {
  const write = (rowId: string, field: string, value: string) => ({ rowId, field, value });

  it('holds an edit without writing it, and counts it', () => {
    let state = emptyEditState();
    expect(isDirty(state)).toBe(false);

    state = apply(
      state,
      batchFrom('type', [write('L1', 'area', '5000')], () => undefined),
    );
    expect(isDirty(state)).toBe(true);
    expect(changeCount(state)).toBe(1);
    expect(pendingValue(state, 'L1', 'area')).toBe('5000');
    expect(pendingValue(state, 'L1', 'baseRent')).toBeUndefined();
    expect(dirtyRowIds(state)).toEqual(['L1']);
  });

  it('undoes back to no pending edit, not to an empty string', () => {
    /*
     * The distinction that matters: undoing the only edit on a cell must leave
     * the row untouched so the grid falls through to the model's own value. An
     * undo that wrote "" would blank the lease.
     */
    let state = emptyEditState();
    state = apply(
      state,
      batchFrom('type', [write('L1', 'area', '5000')], () => undefined),
    );
    state = undo(state);
    expect(pendingValue(state, 'L1', 'area')).toBeUndefined();
    expect(isDirty(state)).toBe(false);
    expect(changeCount(state)).toBe(0);
  });

  it('undoes a paste as one action, not forty', () => {
    let state = emptyEditState();
    const writes = Array.from({ length: 40 }, (_, i) => write(`L${i}`, 'renewal', '0.7'));
    state = apply(
      state,
      batchFrom('paste', writes, () => undefined),
    );
    expect(changeCount(state)).toBe(40);

    state = undo(state);
    expect(isDirty(state)).toBe(false);
    expect(canRedo(state)).toBe(true);

    state = redo(state);
    expect(changeCount(state)).toBe(40);
  });

  it('restores the earlier value when a cell is edited twice', () => {
    let state = emptyEditState();
    const current = (rowId: string, field: string) => pendingValue(state, rowId, field);
    state = apply(state, batchFrom('a', [write('L1', 'area', '5000')], current));
    state = apply(state, batchFrom('b', [write('L1', 'area', '6000')], current));
    expect(pendingValue(state, 'L1', 'area')).toBe('6000');

    state = undo(state);
    expect(pendingValue(state, 'L1', 'area')).toBe('5000');
    state = undo(state);
    expect(pendingValue(state, 'L1', 'area')).toBeUndefined();
  });

  it('unwinds two edits to one cell inside a single batch', () => {
    // A paste can legitimately hit the same cell twice. Undo has to land on the
    // value from before the batch, not on the one from halfway through it.
    let state = emptyEditState();
    state = apply(
      state,
      batchFrom('seed', [write('L1', 'area', '100')], () => undefined),
    );
    const current = (rowId: string, field: string) => pendingValue(state, rowId, field);
    state = apply(state, {
      label: 'paste',
      edits: [
        { rowId: 'L1', field: 'area', before: current('L1', 'area') ?? null, after: '200' },
        { rowId: 'L1', field: 'area', before: '200', after: '300' },
      ],
    });
    expect(pendingValue(state, 'L1', 'area')).toBe('300');
    state = undo(state);
    expect(pendingValue(state, 'L1', 'area')).toBe('100');
  });

  it('drops a no-op rather than dirtying the model', () => {
    // Pasting values that happen to match must not leave "1 unsaved change".
    let state = emptyEditState();
    const current = (rowId: string, field: string) => pendingValue(state, rowId, field);
    state = apply(state, batchFrom('a', [write('L1', 'area', '5000')], current));
    const before = state;
    state = apply(state, batchFrom('b', [write('L1', 'area', '5000')], current));
    expect(state).toBe(before);
    expect(canUndo(state)).toBe(true);
    state = undo(state);
    expect(isDirty(state)).toBe(false);
  });

  it('discards the redo branch once a new edit lands', () => {
    let state = emptyEditState();
    const current = (rowId: string, field: string) => pendingValue(state, rowId, field);
    state = apply(state, batchFrom('a', [write('L1', 'area', '1')], current));
    state = undo(state);
    expect(canRedo(state)).toBe(true);
    state = apply(state, batchFrom('b', [write('L1', 'area', '2')], current));
    expect(canRedo(state)).toBe(false);
  });

  it('bounds history so a large paste cannot grow without limit', () => {
    let state = emptyEditState();
    for (let i = 0; i < HISTORY_LIMIT + 25; i += 1) {
      state = apply(
        state,
        batchFrom(`e${i}`, [write('L1', 'area', String(i))], () => undefined),
      );
    }
    expect(state.past).toHaveLength(HISTORY_LIMIT);
    // The oldest went, so the earliest reachable value is not the very first.
    expect(state.past[0]?.label).toBe('e25');
  });

  it('clears the layer and the history once every pending field is saved', () => {
    let state = emptyEditState();
    state = apply(
      state,
      batchFrom('a', [write('L1', 'area', '1')], () => undefined),
    );
    state = settled(state, [{ rowId: 'L1', fields: { area: '1' } }]);
    expect(isDirty(state)).toBe(false);
    expect(canUndo(state)).toBe(false);
  });

  it('keeps an edit typed while the save was in flight, instead of discarding it', () => {
    // The grid stays editable during a save. If the analyst edits L1's rent
    // after the save request went out but before its response came back,
    // that edit must survive the response -- it was never part of what was
    // sent, so it was never written anywhere.
    let state = emptyEditState();
    const current = (rowId: string, field: string) => pendingValue(state, rowId, field);
    state = apply(state, batchFrom('a', [write('L1', 'baseRent', '1000')], current));
    // What actually went out over the wire, snapshotted at the moment save()
    // was called -- exactly what EditableGrid's commit() does.
    const sent = [{ rowId: 'L1', fields: { baseRent: '1000' } }];
    // ...and then, before the response lands, a second, unrelated edit.
    state = apply(state, batchFrom('b', [write('L1', 'area', '5000')], current));

    state = settled(state, sent);
    expect(pendingValue(state, 'L1', 'baseRent')).toBeUndefined();
    expect(pendingValue(state, 'L1', 'area')).toBe('5000');
    expect(isDirty(state)).toBe(true);
    expect(changeCount(state)).toBe(1);
  });

  it('keeps the newer value when the same cell is edited again mid-save, rather than the one just sent', () => {
    let state = emptyEditState();
    const current = (rowId: string, field: string) => pendingValue(state, rowId, field);
    state = apply(state, batchFrom('a', [write('L1', 'area', '5000')], current));
    const sent = [{ rowId: 'L1', fields: { area: '5000' } }];
    // The analyst changes their mind again before the first save returns.
    state = apply(state, batchFrom('b', [write('L1', 'area', '6000')], current));

    state = settled(state, sent);
    // '5000' was what was sent, but '6000' is what the cell holds now and was
    // never saved -- clearing it here would silently revert the analyst's
    // most recent value to whatever the reload brings back.
    expect(pendingValue(state, 'L1', 'area')).toBe('6000');
    expect(isDirty(state)).toBe(true);
  });
});

describe('column parsers', () => {
  it('reads the number formats a rent roll actually contains', () => {
    const decimal = parseDecimal();
    expect(decimal('12,500')).toEqual({ ok: true, value: '12500' });
    expect(decimal('$1,234.50')).toEqual({ ok: true, value: '1234.50' });
    expect(decimal('(500)')).toEqual({ ok: true, value: '-500' });
    expect(decimal('n/a').ok).toBe(false);
  });

  it('refuses a non-number instead of quietly making it zero', () => {
    // A rent roll where "tbd" became 0 would understate revenue with no
    // evidence anywhere in the model.
    const result = parseDecimal()('tbd');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain('is not a number');
  });

  it('enforces bounds without ever turning the value into a float', () => {
    const area = parseDecimal({ min: 0, label: 'Area' });
    expect(area('-5').ok).toBe(false);
    // Precision that a float would lose survives, because the string is kept.
    expect(area('12345678901234.55')).toEqual({ ok: true, value: '12345678901234.55' });
  });

  it('reads a percentage the three ways analysts type it', () => {
    const percent = parsePercent({ max: 1 });
    expect(percent('7%')).toEqual({ ok: true, value: '0.07' });
    expect(percent('7')).toEqual({ ok: true, value: '0.07' });
    expect(percent('0.07')).toEqual({ ok: true, value: '0.07' });
    expect(percent('150').ok).toBe(false);
  });

  it('refuses an ambiguous date rather than guessing a month', () => {
    /*
     * Reading 03/04/2026 as March rather than April moves a lease expiry by a
     * month and nothing downstream would ever show it. The importer resolves
     * this with an explicit preference; a cell has nowhere to ask, so it says
     * so instead.
     */
    expect(parseDate('2026-03-04')).toEqual({ ok: true, value: '2026-03-04' });
    const ambiguous = parseDate('03/04/2026');
    expect(ambiguous.ok).toBe(false);
    if (!ambiguous.ok) expect(ambiguous.reason).toContain('March or April');
  });

  it('trims a pasted string', () => {
    expect(parseText()('  Starbucks  ')).toEqual({ ok: true, value: 'Starbucks' });
    expect(parseText({ maxLength: 3 })('abcd').ok).toBe(false);
  });
});

describe('column layout', () => {
  const columns: Array<ColumnDef<unknown>> = [
    { key: 'tenant', label: 'Tenant', width: 100, frozen: true, value: () => '' },
    { key: 'suite', label: 'Suite', width: 80, frozen: true, value: () => '' },
    { key: 'area', label: 'Area', width: 80, value: () => '' },
    { key: 'rent', label: 'Rent', width: 80, value: () => '' },
    { key: 'notes', label: 'Notes', width: 80, hiddenByDefault: true, value: () => '' },
  ];

  it('hides the advanced columns until asked for', () => {
    expect(resolveLayout(columns, null).map((c) => c.key)).toEqual([
      'tenant',
      'suite',
      'area',
      'rent',
    ]);
  });

  it('honours a saved order and hidden set', () => {
    const layout = { order: ['tenant', 'suite', 'rent', 'area'], hidden: ['area'] };
    expect(resolveLayout(columns, layout).map((c) => c.key)).toEqual(['tenant', 'suite', 'rent']);
  });

  it('shows a column added after the view was saved, in its natural place', () => {
    /*
     * A saved view written before a column existed must not hide it forever,
     * and appending it to the end would put a new rent field after Notes. It
     * goes back where it sits in the source order.
     */
    const layout = { order: ['tenant', 'suite', 'area', 'notes'], hidden: [] };
    expect(resolveLayout(columns, layout).map((c) => c.key)).toEqual([
      'tenant',
      'suite',
      'area',
      'rent',
      'notes',
    ]);
  });

  it('leaves a newly added advanced column hidden in an older view', () => {
    /*
     * The other half of the rule above, and the one that keeps
     * `hiddenByDefault` meaningful past the first release. A view saved before
     * Notes existed does not mention it, so Notes falls back to its own default
     * — hidden — rather than erupting into every saved view in the product.
     */
    const layout = { order: ['tenant', 'suite', 'area', 'rent'], hidden: [] };
    expect(resolveLayout(columns, layout).map((c) => c.key)).not.toContain('notes');
  });

  it('ignores a column the saved view names but the grid no longer has', () => {
    const layout = { order: ['tenant', 'removed', 'area'], hidden: [] };
    expect(resolveLayout(columns, layout).map((c) => c.key)).not.toContain('removed');
  });

  it('keeps frozen columns leading whatever the saved order says', () => {
    // A frozen column that is not leading freezes a gap.
    const layout = { order: ['area', 'tenant', 'rent', 'suite'], hidden: [] };
    const resolved = resolveLayout(columns, layout).map((c) => c.key);
    expect(resolved.slice(0, 2)).toEqual(['tenant', 'suite']);
  });
});

describe('the browser parsing entry point', () => {
  it('pulls in no dependencies, so ExcelJS stays out of the bundle', () => {
    /*
     * `@cre/reporting` proper imports ExcelJS. The grid needs that package's
     * normalisers and nothing else, so it imports a subpath whose modules are
     * dependency-free. If someone adds an import to one of them, a megabyte of
     * workbook writer starts shipping to the browser silently — so it is
     * checked here rather than noticed in a bundle report later.
     */
    const modules = [
      'packages/reporting/src/parsing.ts',
      'packages/reporting/src/csv.ts',
      'packages/reporting/src/rent-roll-import.ts',
    ];
    for (const path of modules) {
      const source = readFileSync(new URL(`../../../../${path}`, import.meta.url), 'utf8');
      const imports = [...source.matchAll(/^\s*import\s.*?from\s+'([^']+)'/gm)].map(
        (match) => match[1] ?? '',
      );
      const external = imports.filter(
        (specifier) => !specifier.startsWith('./') && !specifier.startsWith('../'),
      );
      expect(external, `${path} imports ${external.join(', ')}`).toEqual([]);
    }
  });
});

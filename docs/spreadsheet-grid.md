# The spreadsheet grid

What an analyst actually does all day is type numbers into rows. This is the
surface that makes that fast, and the reasoning behind the parts of it that are
not obvious.

## Status, stated plainly

**Built, tested, and wired to every table that can carry one.**

`apps/web/src/grid` is a general primitive with six consumers: the rent roll,
and the five assumption collections whose fields are values — operating
expenses, other property revenue, capital, debt facilities and market leasing
assumptions.

Growth curves are deliberately **not** a grid. A curve's meaning is its per-year
rate list, and offering a single editable "default rate" column would let an
analyst change the fallback while the years that actually apply sat out of
sight. It stays a reading surface with a record editor, and a browser test pins
that so a later refactor cannot quietly grid it.

Structured parts of a record — a custom monthly schedule, a draw schedule, an
escalation, a recovery structure, lease options — are still edited as JSON
through "Edit in full" beside each grid. None of them is a value, so none
belongs in a cell; purpose-built editors for them are the next piece of work.

| Capability | State |
| --- | --- |
| Multi-cell selection: click, drag, Shift+click, Shift+arrows | Built |
| Keyboard navigation, Ctrl/Cmd+arrow to an edge, Ctrl/Cmd+A | Built |
| Type-to-edit, Enter down, Tab across, Escape to cancel, F2 | Built |
| Copy to the clipboard as TSV; paste from Excel or Google Sheets | Built |
| Fill down (Ctrl/Cmd+D and a visible button) | Built |
| Undo / redo (Ctrl/Cmd+Z, Ctrl/Cmd+Shift+Z, and buttons) | Built |
| Delete clears the selection | Built |
| Column show / hide / reorder, persisted per model | Built |
| Frozen identifier columns | Built |
| Density: comfortable / standard / compact, persisted per model | Built |
| Unsaved-change indicator, per cell and in total | Built |
| Batched, transactional save | Built |
| Named, shareable saved views | **Not built** — layout persists, but is unnamed and local |
| Drag-to-reorder columns, drag-fill handle | **Not built** — reordering is button-driven |
| An explicit "apply to N selected records" dialog | **Not built** — fill-down and paste-one-value cover the same ground |

## The central decision: cells are the input method, records are the truth

A lease is validated as a whole. Its dates, area and rent have to agree with one
another, and the rent roll has always saved one entire record or nothing,
because a half-saved lease produces a cash flow nobody can defend.

A grid edits one cell at a time. Writing each keystroke straight through would
mean a lease briefly expiring before it commences every time somebody edits a
term, plus a server round trip per cell.

So edits land in a **pending layer** over the loaded rows:

```
loaded lease  →  pending edits  →  what the grid shows
                       ↓
              batched save  →  server merges each change onto the stored
                               record  →  same whole-record validation
```

The consequences are all ones worth having:

- **Validation is not weakened.** The server merges the changed fields onto the
  stored lease and runs the same checks a single-record save runs. A term is
  still checked as a pair, even when the analyst only touched one date.
- **Undo restores real values, not browser state.** Nothing was written, so
  undoing removes the edit and the cell falls back to what the model holds.
- **The analyst can always see what is unsaved**, per cell and as a count, and
  can discard it.
- **Fields with no column are safe.** Escalations, recoveries, rent steps and
  options are carried across untouched by the merge. A test asserts this
  specifically, because a cell edit that silently cleared a recovery structure
  would be far worse than the edit was useful.

Undo *after* a save is a new edit that puts the old value back, which the
analyst then saves. There is no pretence that a written version can be
un-written; the model's own versioning covers that.

## Why the save is one request

Filling a value down forty rows is one thing the analyst did. Sent as forty
requests it could half-succeed, leaving a rent roll in a state nobody chose and
no single audit entry describing it.

`PATCH /api/v1/models/:id/leases` takes the whole set, validates all of it,
applies it in one transaction, and writes one audit entry naming the leases and
the fields. Optimistic concurrency is preserved per lease: each carries the
version the grid loaded, and one stale row rejects the batch rather than
silently overwriting somebody else's edit.

Two properties are worth separating, because a test that conflates them proves
less than it looks:

- **Pre-flight validation.** Every row is checked before the transaction opens.
  Removing the transaction entirely leaves that test passing.
- **Rollback.** A version conflict can only be discovered mid-write, so the
  stale-version test is the one that actually proves the transaction. It is
  written with the *good* row first for that reason, and verified by removing
  `db.begin` from the route and watching only that test fail.

### A trap worth recording

`upsertLease` opens its own transaction. postgres.js does not expose `begin` on
a transaction handle — only `savepoint` — so calling it inside an open
transaction throws at runtime while typechecking perfectly. That is exactly how
the batch endpoint first failed, with every request returning 500.

The fix is `upsertLeaseWithin`, the same write against a caller-supplied handle.
Two names rather than one clever function, because no type can catch the
mistake.

## Parsing is the import pipeline's, not a second copy

A grid accepts text: typed, or pasted out of somebody's spreadsheet. Something
has to decide what `12,500`, `$1,234.50`, `(500)`, `3/4/2026` and `NNN` mean.

That decision already exists in the rent-roll importer, and the grid reuses it
through a dedicated entry point, `@cre/reporting/parsing`. A value pasted into a
cell and the same value imported from a file are therefore read identically.

The entry point exists separately from the package's main export because that
one pulls in ExcelJS, and a megabyte of workbook writer has no business in a
browser bundle that wants to read a tab-separated string. **A test asserts that
every module behind `parsing` has no imports at all**, so adding one fails
rather than quietly inflating the bundle. The built bundle contains zero
occurrences of ExcelJS.

### Where the grid is stricter than the importer

**An ambiguous date is refused, not guessed.** `03/04/2026` could be March or
April. The importer resolves this with an explicit user preference set in the
wizard; a single cell has nowhere to ask, so it says so and asks for
`2026-03-04`. Reading it wrong moves a lease expiry by a month and nothing
downstream would ever reveal it.

**A value that cannot be read is refused, not zeroed.** `tbd` in a rent column
produces a visible refusal and leaves the cell alone. A rent roll where `n/a`
quietly became 0 would understate revenue with no evidence anywhere in the
model.

**A percentage is read the three ways analysts type it** — `7%`, `7` and `0.07`
all mean seven percent — with the rule that anything above 1 was typed as a
percentage. Safe because every rate it applies to is a fraction, and stated on
the column's tooltip rather than left as a surprise.

## Paste semantics

Taken from what spreadsheets do, because that is what analysts expect:

- **One copied cell fills the whole selection.** Select forty rows, paste one
  value, forty change. This is how a bulk edit usually actually happens.
- **A block anchors at the selection's top-left and extends as far as it goes**,
  regardless of the selection's size. Six rows into a one-cell selection writes
  six rows.
- **Anything past the last row or column is dropped and counted**, so the grid
  can say "12 rows did not fit" rather than silently losing them.

What it deliberately does *not* do is **tile** a block to fill a larger
selection. Excel does that only for exact multiples and refuses otherwise; the
rule is hard to predict, and on a rent roll a mistaken tile would write
plausible values into leases nobody looked at.

## Accessibility

`role="grid"` sits on the `<table>`, not on the scrolling container. A grid must
contain rows, and the container's only child is the table element — putting the
role outside produced a **critical** `aria-required-children` violation, which
the existing axe suite caught before this shipped. On the table, `thead`/`tbody`
map to `rowgroup` and `tr`/`td` to `row`/`gridcell` implicitly.

The table is a single tab stop with arrow-key navigation inside it, which is the
pattern assistive technology expects of a spreadsheet. Cells carry
`aria-selected`; the outcome of a paste or a fill is announced through a polite
live region; `aria-sort` stays on the header.

Sorting moved off the column headers onto a toolbar control, because in a
spreadsheet a click on a header selects the column and a sort button there would
fight the selection. Column reordering is button-driven rather than
drag-and-drop: drag is faster once you know it exists, but it is invisible,
fiddly at this row height, and unusable from a keyboard without building a
parallel interaction anyway.

Every gesture has a keyboard equivalent, and the browser suite drives all nine
of its tests from the keyboard.

## What the tests prove, and what they do not

| Layer | Where | What it establishes |
| --- | --- | --- |
| Selection, clipboard, edit layer, parsers | `apps/web/src/grid/grid.test.ts` (40) | The rules, as pure data |
| Batch write, leases | `tests/lease-batch.test.ts` (8) | Merge safety, whole-record validation, rollback, audit |
| Batch write, collections | `tests/assumption-batch.test.ts` (9) | That a cell edit cannot destroy a schedule, a draw list or a covenant |
| The analyst's workflow | `e2e/rent-roll-grid.spec.ts` (11) | That a keystroke reaches the engine |
| The collections in the browser | `e2e/assumption-grid.spec.ts` (7) | That an expense edit moves NOI, and that growth curves stay a table |

The one that matters most is `saves a grid edit and the calculation moves with
it`: it changes a rent in a cell, saves, recalculates, and requires the model's
own NOI to differ. Without it, everything else would be consistent with a grid
wired to a local array.

### A defect this found

The cell editor selected its contents on focus unconditionally, so opening it by
typing `4500` put `4` in the draft, selected it, and let the `5` replace it —
saving 500. An order of magnitude, entered by an analyst who watched themselves
type it correctly, with nothing anywhere to reveal it.

Selecting is right when the editor is opened *into* an existing value with F2 or
a double-click, and wrong when the draft is already the first keystroke. Both
halves are now pinned by a browser test.

**Not covered:** the grid has never been driven with a real screen reader, and
the accessibility work above is machine-checked plus reasoned, not audited.
Clipboard behaviour is tested through the DOM paste event and the pure parser,
not against a real system clipboard in every browser.

## Adding the grid to another table

`EditableGrid` owns the pending layer, the change bar, undo, discard, save and
the column and density preferences, so a new consumer needs only two things:

1. **Columns** — a `ColumnDef[]` saying what each field is, how wide, whether it
   is numeric, frozen or hidden by default, and a `parse` for anything editable.
   Follow `apps/web/src/pages/rent-roll-columns.ts` or
   `apps/web/src/pages/assumption-columns.ts`; both are separate files because
   the column list is the whole statement of what an analyst may edit.
2. **A `save`** that turns the pending fields into a request. For a
   model-scoped collection that is already built: `PATCH /models/:id/<segment>`
   merges changed fields onto the stored row and applies the set in one
   transaction.

### Two shapes of batch endpoint

The rent roll's **enumerates** the fields it accepts, because a lease has one
shape and the term has to be validated across a pair.

The collections' **passes fields through** and lets each collection's own
`upsert` be the schema, because six collections do not share a field set. The
merge is what makes that safe: the stored row first, changed fields over it, so
a custom monthly schedule, a draw schedule or a covenant that has no column
survives an edit to the cell beside it. Three tests assert exactly that, and
each fails when the merge is replaced with a rebuild-from-defaults.

The rule to keep: **a field belongs in a cell only if its meaning is complete in
one value.** Escalations, recoveries and rent steps are structured records —
an escalation has a type, a rate, a frequency and a compounding rule that only
make sense together — and flattening one into a cell would either lose part of
it or invent a syntax for typing it. Those stay in their record editors, and the
column list says so rather than leaving an analyst to discover that a column
they expected is missing.

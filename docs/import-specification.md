# Import specification

## Principles

**Deterministic first.** Every rule is pattern matching and normalisation a user
can see and correct. Nothing is inferred by a model.

**Nothing leaves the deployment.** Uploaded financial documents are parsed
in-process and contact no external service. Any future AI-assisted mapping is a
separate, explicitly enabled, provider-abstracted path — never the default.

**Never guess silently.** An ambiguous date is imported *and flagged*. An
unreadable number is an error, not a zero.

## The pipeline

```
upload → analyse → map → validate → commit → audit
```

Each step is a separate API call, so a mapping can be corrected before anything
is written.

### 1. Analyse — `POST /models/:id/imports/analyze`

Parses the file, locates the header row, and proposes a mapping.

**Delimiter detection** scores `,` `;` tab `|` on which produces the most
consistent column count across the first 20 lines.

**Header detection** scores each of the first 25 rows on `recognisedColumns × 3
+ filledCells`. Rent rolls routinely carry a title block, a logo row and a date
stamp above the real headers, so the first row is rarely the header.

**Mapping suggestion** matches each header against field synonyms — exact match
scores 100, prefix 70+, substring 40+ — and never assigns one column to two
fields.

### 2. Validate — `POST /models/:id/imports/validate`

Normalises every row and returns findings. Writes nothing.

### 3. Commit — `POST /models/:id/imports/commit`

Imports in one transaction. Rows with error-level findings are **never
imported**; the caller must fix them or explicitly pass `skipRowsWithErrors`.
Tenants are matched by name within the property before a new one is created, so
re-importing an updated rent roll does not duplicate them. Leases upsert by
code, so re-import updates rather than duplicating.

## Recognised fields

Required: suite/space, tenant, area, commencement, expiration, base rent.
Optional: lease reference, property, building, floor, status, units, rent start,
rent basis, recovery structure, security deposit, TI allowance, leasing
commission, notes.

Synonyms cover the vocabulary these files actually use — `SF`, `Sq Ft`, `NRA`,
`GLA`, `Rentable`, `Size` for area; `Expir`, `End`, `Lease End`, `Termination`,
`Expiry` for expiration; `Passing Rent`, `Rent PSF`, `Annual Rent` for base rent.

## Normalisation rules

### Numbers

Handles currency symbols, thousands separators, trailing units and parenthesised
negatives.

**Separator disambiguation:**

- Both `,` and `.` present → the **last** one is the decimal separator.
  `1.234,50` → 1234.50; `1,234.50` → 1234.50.
- Only one present, appearing more than once → thousands separator.
- Only one present, appearing once, followed by **exactly three digits** →
  thousands separator. `12,500` → 12500; `1.500` → 1500.
- Otherwise → decimal separator. `1234.50` → 1234.50.

> The three-digit rule is a documented judgement call. `1.500` on a rent roll is
> far more likely to be fifteen hundred than one and a half. A file that means
> 1.5 must write `1.50`.

`N/A`, `none`, `-`, `—`, `TBD` and blanks return null — a missing value, not
zero.

### Dates

| Input | Reading |
| --- | --- |
| `2026-03-04` | ISO, unambiguous |
| `45658` | Excel serial (1899-12-30 epoch), unambiguous |
| `1 Mar 2026`, `March 15, 2026`, `15-Jun-27` | Named month, unambiguous |
| `25/12/2026` | Day > 12, so unambiguous |
| `03/04/2026` | **Ambiguous** — resolved by the caller's `datePreference`, and flagged |

Two-digit years below 70 map to 2000s, otherwise 1900s.

### Vocabulary

Status: `current`/`active`/`leased` → occupied; `available`/`empty` → vacant;
`MTM`/`month to month` → month_to_month; and the direct matches.

Recovery: `NNN`/`triple net` → triple_net; `base year` → base_year; `stop` →
expense_stop; `full service`/`FSG`/`gross` → full_service_gross; unrecognised →
none.

### Rent basis

Taken from a basis column when present. Otherwise inferred from magnitude: a
rent **smaller than the area** is a per-area rate, larger is a total. The
inference is surfaced for confirmation, never applied silently.

## Findings

| Severity | Blocks import | Examples |
| --- | --- | --- |
| Error | Yes | Required field unmapped; unreadable area or rent; negative area or rent; unreadable date; expiration before commencement; duplicate lease reference; blank tenant on a non-vacant row |
| Warning | No | Ambiguous date resolved by preference |

A row that raises **any** error is excluded from the importable set, even when
its individual values parsed — an inverted lease term is unusable however clean
its dates.

Rows blank in both suite and tenant are skipped silently: spacer rows are normal
in these files and are not findings.

## Audit

Every batch records the file name, header row, detected columns, mapping, row
count, imported count, errors and warnings in `import_batches`, and writes an
audit entry with the imported and skipped counts.

## Limitations

- **CSV and Excel `.xlsx` are both parsed.** A workbook is read into the same
  rows the CSV pipeline takes, with the rent roll sheet suggested when there
  is more than one. `.xls` (the pre-2007 binary format) is not supported.
- The commit runs in one transaction — either every valid lease lands or none
  does — and `POST /models/:id/imports/:batchId/rollback` can undo a commit
  afterwards: it restores or deletes exactly what that commit touched, from a
  snapshot taken in the same transaction as the write. It does not detect
  edits made to a lease after the import, the same as an editor's own undo.
- One sheet at a time.
- Rent steps, options and recovery detail are not imported — only the fields
  above.

---

# Trial balance import (actuals and budgets)

A separate reader, in `packages/reporting/src/actuals-import.ts`, for the
general-ledger export that carries actuals or a budget. Same principles as the
rent roll: local, deterministic, nothing written until the analyst has seen what
would be written.

## Layouts

Both shapes accountancy systems actually export are read. The shape is detected,
not configured — arguing with the export is not the analyst's job.

**Wide** — one row per account, one column per month:

```
Account, Description,   Jan-26,  Feb-26,  Mar-26
4000,    Base rent,     10000,   10000,   10500
```

**Long** — one row per account per month:

```
Account, Description, Period,   Amount
4000,    Base rent,   2026-01,  10000
```

A period column paired with an amount column settles it as long, whatever else
the header contains. Otherwise any month-shaped header means the months are the
columns. **A single month column counts**: one month of actuals is the routine
monthly close, and requiring two would reject the most ordinary upload there is.

## Months

`Jan-26`, `Jan 2026`, `January 2026`, `2026-01`, `2026-01-31`, `03/2026` and
`12-2026` are read. Everything lands on the **first of the month**: a monthly
figure has no meaningful day, and keeping one invites a timezone to shift it
into the previous month. Anything unrecognised is refused rather than guessed —
`Q1 2026` is an error, not a January.

## Sign

The platform stores amounts money-in-positive, money-out-negative. Ledgers
usually state costs positive. `expenseSign` declares which convention the file
uses, and costs are negated on the way in when it says `positive`. A cost
already written negative is not negated twice.

That conversion needs to know which rows are costs. Category comes from a
category column if there is one, otherwise from account-code prefixes the caller
supplies. A row whose category cannot be determined is **left as written and
reported**, because applying the wrong sign would reverse its variance rather
than merely misplace it.

## Findings

| Severity | Excludes the row | Raised for |
| --- | --- | --- |
| Error | Yes | No account column in the file; empty account code; unreadable month; unreadable amount |
| Warning | No | Uncategorised row whose sign was therefore left alone |

A row raising any error contributes nothing, even where some of its months
parsed — half an account is not a usable figure.

A blank cell in a wide sheet is skipped rather than stored as zero. "Nothing
posted" and "someone entered zero" are different statements, and only one of
them should appear in a variance report as a budgeted nil.

## Limitations

- CSV only, as with the rent roll.
- The importer replaces a period's entries wholesale. A budget upload states the
  whole period; appending would silently double every account on a second
  upload.
- An approved budget refuses new figures. Create a revised budget instead, so
  the approved numbers stay on the record.

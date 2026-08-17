# Reporting specification

## One definition, four renderings

A report is a pure function from a calculated model to a `ReportTable`:

```ts
interface ReportTable {
  id, title, description
  columns: Array<{ key, label, align, format }>
  rows:    Array<Record<string, string | number | null>>
  totals?: Record<string, string | number | null>
  footnotes: string[]
}
```

The same definition drives the on-screen grid, the CSV, the spreadsheet and the
print view. They cannot disagree about what a report contains, because there is
only one of them.

## Reports available

| Report | Contents |
| --- | --- |
| Annual cash flow | The full line stack by fiscal year |
| Rent roll | Contract leases at the forecast start, with totals |
| Valuation summary | Concluded value by method with every input |
| Return summary | All return, yield and credit metrics |
| Lease expiration schedule | Expiring area, share and rent by year |
| Expense recovery detail | Pool, share, gross-up, stop, caps, fees, recovery |
| Debt schedule | Balance, interest, amortisation, fees, covenants |
| Occupancy reconciliation | Occupied, available, physical and economic occupancy |
| Model validation | Every diagnostic by severity |

## Output formats

| Format | Notes |
| --- | --- |
| JSON | The `ReportTable` itself |
| CSV | RFC-4180 quoting, CRLF |
| XLSX | Numbers written as **numbers with a display format**, not pre-formatted strings, so a recipient can keep working in the sheet. Frozen header, bold totals, footnotes below. Requires `export:run`. |
| Print HTML | Self-contained, escaped, with print styles and repeating table headers |

Also available: a whole-model workbook (every property report as one file) and a
**portable JSON model document**:

```json
{
  "format": "cre-platform-model",
  "formatVersion": 1,
  "exportedAt": "...",
  "engineVersion": "15.0.0",
  "model":  { /* the exact engine input */ },
  "result": { /* the calculated result, trace omitted */ }
}
```

This is the platform's own documented, non-proprietary format for backups and
integrations. It is **not** an interchange format for any other vendor's files,
and no proprietary format is read or written.

## Accessibility

Every table has a caption. Numeric columns use tabular figures so digits align.
Every chart carries an `aria-label` naming each value and a `<details>` element
exposing the underlying figures as a real table — the data is always reachable
without the graphic.

Chart axes are **anchored at zero**. Truncating an axis exaggerates differences,
which is the kind of distortion a financial chart must not introduce.

## Permissions and reproducibility

Reports are built from the model's **stored calculation run**, so a report and
the screen show the same numbers from the same run. Every report footnotes the
engine version and calculation timestamp. Requesting a report for an
uncalculated model returns 422 with an explanation rather than an empty table.

## Server-side PDF

`POST /models/:id/reports/:reportId/pdf` enqueues a `render_report` job. The
worker (`apps/worker/src/pdf.ts`) launches a real headless Chromium via
`playwright-core`, renders the same print HTML the `html` format already
produces, and returns real PDF bytes — polled via the existing
`GET /jobs/:id`, the same shape `export_workbook` already returns. Gated
behind `export:run`, same as the `xlsx` format. This closes what used to be
listed here as deferred: server-side rendering needed a headless browser in
the worker image, and now has one. The browser's own print-to-PDF (via the
`html` format) still works and remains the zero-latency option for a screen
the reader is already looking at.

The production Docker image installs Chromium via Alpine's own `apk chromium`
package rather than Playwright's glibc-targeted download — unverified past a
build this environment cannot run, same as every other Docker claim in this
repository. The rendering code itself is verified: `apps/worker/src/pdf.test.ts`
produces real PDF bytes in this environment's own headless Chromium, and the
full pipeline — a click in a real browser through the API, the job queue, the
worker, and a downloaded file — was exercised by hand against real running
API, worker and web processes.

## Not implemented

- Report configuration, saved layouts, scheduled delivery, branding.

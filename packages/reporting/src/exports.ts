import ExcelJS from 'exceljs';
import type { ModelResult } from '@cre/domain-models';
import { toCsv } from './csv.js';
import type { ReportTable } from './reports.js';

/**
 * Export renderers.
 *
 * Each takes a `ReportTable` produced by a report definition, so a report is
 * authored once and every format follows. Numeric cells are written as numbers
 * with a display format rather than as pre-formatted strings, so a recipient
 * can keep working in the spreadsheet.
 */

/**
 * Renders one cell as the text a reader should see, for every format that
 * isn't a spreadsheet.
 *
 * A `percent`-format cell holds the same raw decimal fraction every other
 * format does (`0.055`, not `5.5` or `"5.50%"`) — the engine's own
 * convention, checked by `mustBeRate` at the write boundary and matched by
 * the XLSX export below, which stores that same `0.055` as a number and
 * applies Excel's own `0.00%` display format so the cell still recalculates
 * as a fraction. CSV, print HTML and the on-screen preview have no such
 * display-format layer to lean on: writing the raw fraction into them
 * literally shows "0.055" where a reader expects "5.50%" — not a rounding
 * difference but two decimal orders of magnitude apart, in every DSCR,
 * occupancy, cap rate and covenant figure on every report. This is the one
 * place that conversion happens for all three.
 */
export function formatCellText(value: string | number | null | undefined, format: string): string {
  if (value === null || value === undefined || value === '') return '';
  if (format !== 'percent') return String(value);
  const numeric = Number(value);
  return Number.isFinite(numeric) ? `${(numeric * 100).toFixed(2)}%` : String(value);
}

export function reportToCsv(table: ReportTable): string {
  const header = table.columns.map((column) => column.label);
  const body = table.rows.map((row) =>
    table.columns.map((column) => formatCellText(row[column.key], column.format)),
  );
  const totals = table.totals
    ? [table.columns.map((column) => formatCellText(table.totals?.[column.key], column.format))]
    : [];
  return toCsv([header, ...body, ...totals]);
}

const NUMBER_FORMATS: Record<string, string> = {
  currency: '#,##0.00;(#,##0.00)',
  percent: '0.00%',
  area: '#,##0',
  number: '#,##0.00',
};

export async function reportToWorkbook(tables: ReportTable[]): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'CRE Platform';
  workbook.created = new Date();

  for (const table of tables) {
    // Sheet names are limited to 31 characters and cannot contain []:*?/\
    const sheetName = table.title.replace(/[[\]:*?/\\]/g, ' ').slice(0, 31) || table.id;
    const sheet = workbook.addWorksheet(sheetName, {
      views: [{ state: 'frozen', ySplit: 3, xSplit: 1 }],
    });

    sheet.addRow([table.title]);
    sheet.getRow(1).font = { bold: true, size: 14 };
    sheet.addRow([table.description]);
    sheet.getRow(2).font = { italic: true, size: 10 };

    const headerRow = sheet.addRow(table.columns.map((column) => column.label));
    headerRow.font = { bold: true };
    headerRow.alignment = { wrapText: true, vertical: 'bottom' };

    for (const row of table.rows) {
      const values = table.columns.map((column) => coerce(row[column.key], column.format));
      const added = sheet.addRow(values);
      table.columns.forEach((column, index) => {
        const cell = added.getCell(index + 1);
        cell.alignment = { horizontal: column.align };
        const format = NUMBER_FORMATS[column.format];
        if (format && typeof cell.value === 'number') cell.numFmt = format;
      });
    }

    if (table.totals) {
      const values = table.columns.map((column) =>
        coerce(table.totals?.[column.key], column.format),
      );
      const totalsRow = sheet.addRow(values);
      totalsRow.font = { bold: true };
      totalsRow.border = { top: { style: 'thin' } };
      table.columns.forEach((column, index) => {
        const cell = totalsRow.getCell(index + 1);
        const format = NUMBER_FORMATS[column.format];
        if (format && typeof cell.value === 'number') cell.numFmt = format;
      });
    }

    if (table.footnotes.length > 0) {
      sheet.addRow([]);
      for (const note of table.footnotes) {
        const noteRow = sheet.addRow([note]);
        noteRow.font = { italic: true, size: 9 };
      }
    }

    table.columns.forEach((column, index) => {
      sheet.getColumn(index + 1).width = column.format === 'text' ? 32 : 16;
    });
  }

  const buffer = await workbook.xlsx.writeBuffer();
  return Buffer.from(buffer);
}

function coerce(value: string | number | null | undefined, format: string): string | number | null {
  if (value === null || value === undefined || value === '') return null;
  if (format === 'text' || format === 'date') return String(value);
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : String(value);
}

/**
 * The platform's own portable model format.
 *
 * Documented, non-proprietary and versioned, so a model can be archived or
 * moved between deployments without depending on any vendor's file format.
 */
export interface PortableModelDocument {
  format: 'cre-platform-model';
  formatVersion: 1;
  exportedAt: string;
  engineVersion: string;
  model: unknown;
  result?: Omit<ModelResult, 'trace'>;
}

export function toPortableDocument(
  modelInput: unknown,
  engineVersion: string,
  result?: ModelResult,
): PortableModelDocument {
  const document: PortableModelDocument = {
    format: 'cre-platform-model',
    formatVersion: 1,
    exportedAt: new Date().toISOString(),
    engineVersion,
    model: modelInput,
  };
  if (result) {
    const { trace: _trace, ...rest } = result;
    document.result = rest;
  }
  return document;
}

/**
 * Print-ready HTML for a report.
 *
 * This is what the browser's own print-to-PDF consumes for a screen the
 * reader is already looking at, so the printed output is real rather than a
 * placeholder. Real server-side rendering — a headless browser inside the
 * worker image, for a PDF nobody has to open the app to produce — is
 * `apps/worker/src/pdf.ts`'s `renderHtmlToPdf`, which takes this same HTML
 * as its input; see docs/reporting-specification.md.
 */
export function reportToPrintableHtml(table: ReportTable): string {
  const escape = (value: unknown): string =>
    String(value ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');

  const head = table.columns
    .map((column) => `<th style="text-align:${column.align}">${escape(column.label)}</th>`)
    .join('');
  const body = table.rows
    .map(
      (row) =>
        `<tr>${table.columns
          .map(
            (column) =>
              `<td style="text-align:${column.align}">${escape(formatCellText(row[column.key], column.format))}</td>`,
          )
          .join('')}</tr>`,
    )
    .join('');
  const totals = table.totals
    ? `<tfoot><tr>${table.columns
        .map(
          (column) =>
            `<th style="text-align:${column.align}">${escape(formatCellText(table.totals?.[column.key], column.format))}</th>`,
        )
        .join('')}</tr></tfoot>`
    : '';

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<title>${escape(table.title)}</title>
<style>
  body { font: 12px/1.45 system-ui, sans-serif; color: #16181d; margin: 24px; }
  h1 { font-size: 18px; margin: 0 0 4px; }
  p.description { color: #5b6270; margin: 0 0 16px; }
  table { border-collapse: collapse; width: 100%; }
  th, td { padding: 4px 8px; border-bottom: 1px solid #dfe3ea; }
  thead th { border-bottom: 2px solid #16181d; }
  tfoot th { border-top: 2px solid #16181d; }
  ol.footnotes { color: #5b6270; font-size: 10px; margin-top: 16px; }
  @media print { body { margin: 0; } thead { display: table-header-group; } }
</style></head>
<body>
<h1>${escape(table.title)}</h1>
<p class="description">${escape(table.description)}</p>
<table><thead><tr>${head}</tr></thead><tbody>${body}</tbody>${totals}</table>
<ol class="footnotes">${table.footnotes.map((note) => `<li>${escape(note)}</li>`).join('')}</ol>
</body></html>`;
}

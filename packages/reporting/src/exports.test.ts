import { describe, expect, it } from 'vitest';
import { formatCellText, reportToCsv, reportToPrintableHtml } from './exports.js';
import type { ReportTable } from './reports.js';

/**
 * Cell formatting across the non-spreadsheet export formats.
 *
 * A `percent`-format cell always holds the engine's own raw decimal
 * fraction (0.055 for 5.5%) — the XLSX export reads that same convention
 * and applies Excel's own `0.00%` display format, so the underlying number
 * survives for further computation. CSV, print HTML and the on-screen
 * preview have no such display layer of their own: writing the raw
 * fraction straight into them shows "0.055" where a reader expects
 * "5.50%", two decimal orders of magnitude apart. These pin the fix.
 */
describe('formatCellText', () => {
  it('turns a raw decimal fraction into a percentage, matching the XLSX display format', () => {
    expect(formatCellText('0.055', 'percent')).toBe('5.50%');
    expect(formatCellText(0.055, 'percent')).toBe('5.50%');
    expect(formatCellText('1', 'percent')).toBe('100.00%');
    expect(formatCellText('0', 'percent')).toBe('0.00%');
  });

  it('leaves every other format as plain text', () => {
    expect(formatCellText('1234.56', 'currency')).toBe('1234.56');
    expect(formatCellText(50000, 'area')).toBe('50000');
    expect(formatCellText('Suite 100', 'text')).toBe('Suite 100');
  });

  it('leaves a missing value empty rather than formatting it', () => {
    expect(formatCellText(null, 'percent')).toBe('');
    expect(formatCellText(undefined, 'percent')).toBe('');
    expect(formatCellText('', 'percent')).toBe('');
  });

  it('falls back to the raw text for a percent cell that is not actually a number', () => {
    expect(formatCellText('Not available', 'percent')).toBe('Not available');
  });
});

const table: ReportTable = {
  id: 'probe',
  title: 'Debt schedule',
  description: 'Probe table',
  columns: [
    { key: 'facility', label: 'Facility', align: 'left', format: 'text' },
    { key: 'appliedRate', label: 'Rate', align: 'right', format: 'percent' },
  ],
  rows: [{ facility: 'Senior loan', appliedRate: '0.0575' }],
  totals: { facility: 'Total', appliedRate: '0.06' },
  footnotes: [],
};

describe('reportToCsv', () => {
  it('renders a percent column as a percentage, not the raw fraction', () => {
    const csv = reportToCsv(table);
    expect(csv).toContain('5.75%');
    expect(csv).toContain('6.00%');
    expect(csv).not.toContain('0.0575');
    expect(csv).not.toContain('0.06');
  });
});

describe('reportToPrintableHtml', () => {
  it('renders a percent column as a percentage, not the raw fraction', () => {
    const html = reportToPrintableHtml(table);
    expect(html).toContain('5.75%');
    expect(html).toContain('6.00%');
    expect(html).not.toContain('0.0575');
    expect(html).not.toContain('0.06<');
  });
});

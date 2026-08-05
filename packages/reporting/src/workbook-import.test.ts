import ExcelJS from 'exceljs';
import { describe, expect, it } from 'vitest';
import {
  cellToString,
  isWorkbookFilename,
  pickRentRollSheet,
  readWorkbook,
} from './workbook-import.js';
import { analyzeSheet, suggestMapping } from './rent-roll-import.js';

/**
 * Reading a real workbook.
 *
 * These build actual `.xlsx` files with exceljs and read them back, rather than
 * asserting against hand-made objects that only resemble what the library
 * returns. A test against an imagined cell shape passes while the real one
 * fails, which is the entire failure mode of a mocked parser.
 *
 * Every case here is a way a spreadsheet import corrupts a rent roll *without
 * erroring* — a date that moves a day, a formula imported as its own text, a
 * blank column that shifts every value left. Those are the ones worth pinning:
 * a loud failure is found the first time somebody tries it.
 */

/** Builds a workbook in memory and returns its bytes. */
async function workbook(
  build: (sheet: ExcelJS.Worksheet, book: ExcelJS.Workbook) => void,
): Promise<Buffer> {
  const book = new ExcelJS.Workbook();
  const sheet = book.addWorksheet('Rent Roll');
  build(sheet, book);
  return Buffer.from((await book.xlsx.writeBuffer()) as ArrayBuffer);
}

describe('cell conversion', () => {
  it('formats a date as YYYY-MM-DD in UTC', () => {
    // The trap: toISOString() on a date built in a negative-offset timezone
    // reports the previous day. A lease expiring on the 1st becomes the 31st.
    const value = new Date(Date.UTC(2028, 5, 30));
    expect(cellToString(value)).toBe('2028-06-30');
  });

  it('takes a formula’s result, never its text', () => {
    expect(cellToString({ formula: 'B2*12', result: 42000 })).toBe('42000');
    // A formula with no cached result computed nothing, so there is nothing to
    // import. Importing "B2*12" as a rent would be worse than importing blank.
    expect(cellToString({ formula: 'B2*12' })).toBe('');
    expect(cellToString({ sharedFormula: 'C1' })).toBe('');
  });

  it('flattens rich text rather than stringifying the object', () => {
    // `String({richText: [...]})` is "[object Object]", which flows into a
    // tenant name and never looks like an error.
    expect(cellToString({ richText: [{ text: 'Meridian ' }, { text: 'Actuarial Group' }] })).toBe(
      'Meridian Actuarial Group',
    );
  });

  it('reads a hyperlink’s text', () => {
    expect(cellToString({ text: 'Suite 1200', hyperlink: 'https://example.invalid' })).toBe(
      'Suite 1200',
    );
  });

  it('treats an error cell as empty, not as the string "#REF!"', () => {
    // "#REF!" in an area column would fail number normalisation and be reported.
    // "#REF!" in a tenant name would be imported as a tenant called #REF!.
    expect(cellToString({ error: '#REF!' })).toBe('');
    expect(cellToString({ error: '#DIV/0!' })).toBe('');
  });

  it('passes numbers and text through', () => {
    expect(cellToString(42500)).toBe('42500');
    expect(cellToString('  Meridian  ')).toBe('Meridian');
    expect(cellToString(null)).toBe('');
    expect(cellToString(undefined)).toBe('');
  });
});

describe('reading a workbook', () => {
  it('reads a rent roll into the rows the CSV pipeline takes', async () => {
    const data = await workbook((sheet) => {
      sheet.addRow(['Lease', 'Tenant', 'Area', 'Commences', 'Expires', 'Base rent']);
      sheet.addRow([
        'L-001',
        'Meridian Actuarial Group',
        42500,
        new Date(Date.UTC(2021, 6, 1)),
        new Date(Date.UTC(2028, 5, 30)),
        33.75,
      ]);
      sheet.addRow([
        'L-002',
        'Kestrel Analytics',
        51300,
        new Date(Date.UTC(2024, 8, 1)),
        new Date(Date.UTC(2031, 7, 31)),
        37.25,
      ]);
    });

    const sheets = await readWorkbook(data);
    expect(sheets).toHaveLength(1);
    const rows = sheets[0]?.rows ?? [];
    expect(rows[0]).toEqual(['Lease', 'Tenant', 'Area', 'Commences', 'Expires', 'Base rent']);
    expect(rows[1]?.[1]).toBe('Meridian Actuarial Group');
    expect(rows[1]?.[2]).toBe('42500');
    expect(rows[1]?.[4]).toBe('2028-06-30');

    // The whole point: the existing pipeline reads it unchanged.
    const analysis = analyzeSheet(rows);
    expect(analysis.headerRowIndex).toBe(0);
    const mapping = suggestMapping(analysis.headers);
    expect(mapping.tenantName).toBe(1);
    expect(mapping.area).toBe(2);
  });

  it('keeps columns aligned when a column is blank', async () => {
    /*
     * exceljs's `eachCell` skips empty cells. Reading that way would shift every
     * value after a gap one column left — a rent roll with a spacer column
     * would import expiry dates into the rent column, silently, with every row
     * looking plausible.
     */
    const data = await workbook((sheet) => {
      const header = sheet.addRow(['Lease', '', 'Tenant', '', 'Area']);
      header.commit();
      const row = sheet.getRow(2);
      row.getCell(1).value = 'L-001';
      row.getCell(3).value = 'Kestrel Analytics';
      row.getCell(5).value = 51300;
      row.commit();
    });

    const rows = (await readWorkbook(data))[0]?.rows ?? [];
    expect(rows[1]?.[0]).toBe('L-001');
    expect(rows[1]?.[1]).toBe('');
    expect(rows[1]?.[2]).toBe('Kestrel Analytics');
    expect(rows[1]?.[3]).toBe('');
    expect(rows[1]?.[4]).toBe('51300');
  });

  it('drops trailing empty rows', async () => {
    const data = await workbook((sheet) => {
      sheet.addRow(['Lease', 'Tenant']);
      sheet.addRow(['L-001', 'Kestrel']);
      sheet.addRow([]);
      sheet.addRow([]);
    });
    const rows = (await readWorkbook(data))[0]?.rows ?? [];
    expect(rows).toHaveLength(2);
  });

  it('returns every sheet rather than assuming the first', async () => {
    const book = new ExcelJS.Workbook();
    const cover = book.addWorksheet('Cover');
    cover.addRow(['Prepared for the investment committee']);
    const roll = book.addWorksheet('Rent Roll');
    roll.addRow(['Lease', 'Tenant', 'Suite', 'Area', 'Expires']);
    roll.addRow(['L-001', 'Kestrel Analytics', '1600', 51300, new Date(Date.UTC(2031, 7, 31))]);
    const data = Buffer.from((await book.xlsx.writeBuffer()) as ArrayBuffer);

    const sheets = await readWorkbook(data);
    expect(sheets.map((sheet) => sheet.name)).toEqual(['Cover', 'Rent Roll']);

    // A workbook with a cover sheet first is the common case, and importing the
    // cover is the failure the suggestion exists to avoid.
    expect(pickRentRollSheet(sheets)).toBe(1);
  });

  it('imports a formula column as its computed value', async () => {
    const data = await workbook((sheet) => {
      sheet.addRow(['Lease', 'Tenant', 'Annual rent']);
      const row = sheet.addRow(['L-001', 'Kestrel Analytics', null]);
      row.getCell(3).value = { formula: 'B2*12', result: 447750 } as ExcelJS.CellFormulaValue;
      row.commit();
    });
    const rows = (await readWorkbook(data))[0]?.rows ?? [];
    expect(rows[1]?.[2]).toBe('447750');
  });
});

describe('filename dispatch', () => {
  it('recognises the spreadsheet extensions and nothing else', () => {
    expect(isWorkbookFilename('rent-roll.xlsx')).toBe(true);
    expect(isWorkbookFilename('RENT ROLL.XLSX')).toBe(true);
    expect(isWorkbookFilename('macro-enabled.xlsm')).toBe(true);
    expect(isWorkbookFilename('rent-roll.csv')).toBe(false);
    expect(isWorkbookFilename('rent-roll.txt')).toBe(false);
    // `.xls` is the old binary format, which exceljs does not read. Claiming it
    // works and failing at parse time would be worse than saying so.
    expect(isWorkbookFilename('legacy.xls')).toBe(false);
  });
});

import { describe, expect, it } from 'vitest';
import { inflateRawSync } from 'node:zlib';
import ExcelJS from 'exceljs';
import { columnLetter, quoteSheet, safeDefinedName, safeSheetName } from './refs.js';
import { WorkbookModel } from './model.js';
import { measureCoverage } from './coverage.js';
import { renderWorkbook } from './render.js';
import { seriesRow, timeAxis } from './layout.js';
import type { PeriodMeta } from '@cre/domain-models';

/**
 * Framework tests.
 *
 * These prove the parts a workbook is assembled from, not a workbook. The
 * sheet builders do not exist yet, so there is deliberately nothing here
 * asserting that revenue reconciles — a test claiming that would be asserting
 * about code that has not been written.
 *
 * What is worth proving now is that the machinery cannot lie: that a formula
 * survives the round trip into a real .xlsx, that references resolve to the
 * cells they claim, and that the coverage metric counts what it says it counts.
 */

/**
 * Reads one entry out of an .xlsx, which is a zip.
 *
 * Written here rather than pulled in as a dependency: jszip and unzipper exist
 * only as transitive dependencies of ExcelJS and do not resolve from this
 * package, and adding one to assert on a handful of bytes would be a poor
 * trade. Scans for the local file header, then inflates.
 */
function zipEntry(input: Uint8Array, name: string): string {
  // Deliberately Uint8Array and DataView rather than node's Buffer: ExcelJS
  // declares its own global `Buffer` shape, and mixing the two produces a type
  // error about `Symbol.toStringTag` that has nothing to do with the code.
  const view = new DataView(input.buffer, input.byteOffset, input.byteLength);
  const target = new TextEncoder().encode(name);

  for (let offset = 0; offset + 30 < input.byteLength; offset += 1) {
    if (view.getUint32(offset, true) !== 0x04034b50) continue;
    const nameLength = view.getUint16(offset + 26, true);
    if (nameLength !== target.length) continue;

    const candidate = input.subarray(offset + 30, offset + 30 + nameLength);
    if (!target.every((byte, index) => candidate[index] === byte)) continue;

    const method = view.getUint16(offset + 8, true);
    const compressedSize = view.getUint32(offset + 18, true);
    const extraLength = view.getUint16(offset + 28, true);
    const start = offset + 30 + nameLength + extraLength;
    // A zero compressed size means the writer streamed the entry and put the
    // real size in a trailing descriptor; inflating to the end of the buffer is
    // still correct, because the deflate stream carries its own end marker.
    const data =
      compressedSize > 0 ? input.subarray(start, start + compressedSize) : input.subarray(start);
    const bytes = method === 0 ? data : new Uint8Array(inflateRawSync(data));
    return new TextDecoder().decode(bytes);
  }
  throw new Error(`The workbook contains no entry named ${name}.`);
}

function periods(count: number): PeriodMeta[] {
  return Array.from({ length: count }, (_, index) => {
    const month = (index % 12) + 1;
    const year = 2026 + Math.floor(index / 12);
    return {
      index: index + 1,
      startDate: `${year}-${String(month).padStart(2, '0')}-01`,
      endDate: `${year}-${String(month).padStart(2, '0')}-28`,
      year,
      month,
      fiscalYear: year,
      fiscalPeriod: month,
      daysInMonth: 28,
    };
  });
}

describe('column letters', () => {
  it('counts in base 26 with no zero digit', () => {
    expect(columnLetter(1)).toBe('A');
    expect(columnLetter(26)).toBe('Z');
    // The boundary that a naive base-26 conversion gets wrong.
    expect(columnLetter(27)).toBe('AA');
    expect(columnLetter(52)).toBe('AZ');
    expect(columnLetter(53)).toBe('BA');
    expect(columnLetter(702)).toBe('ZZ');
    expect(columnLetter(703)).toBe('AAA');
    // Excel's last column.
    expect(columnLetter(16384)).toBe('XFD');
  });

  it('refuses a column that cannot exist', () => {
    expect(() => columnLetter(0)).toThrow(/positive integer/);
    expect(() => columnLetter(-1)).toThrow(/positive integer/);
  });
});

describe('sheet and name quoting', () => {
  it('quotes only when the name needs it', () => {
    expect(quoteSheet('Revenue')).toBe('Revenue');
    expect(quoteSheet('Cash Flow')).toBe("'Cash Flow'");
    // An apostrophe inside a quoted name is doubled, or the formula ends early.
    expect(quoteSheet("Bob's Sheet")).toBe("'Bob''s Sheet'");
  });

  it('keeps sheet names inside what Excel accepts', () => {
    expect(safeSheetName('Rent Roll')).toBe('Rent Roll');
    expect(safeSheetName('A/B:C*D?E[F]G')).toBe('A B C D E F G');
    expect(safeSheetName('x'.repeat(40))).toHaveLength(31);
    expect(safeSheetName('   ')).toBe('Sheet');
  });

  it('produces defined names Excel will not reject', () => {
    expect(safeDefinedName('Exit Cap Rate')).toBe('ExitCapRate');
    // Must not start with a digit.
    expect(safeDefinedName('2026Rate')).toBe('_2026Rate');
    // Must not be mistakable for a cell address.
    expect(safeDefinedName('A1')).toBe('A1_');
    expect(safeDefinedName('XFD1048576')).toBe('XFD1048576_');
    // ...but a name that merely looks similar is left alone.
    expect(safeDefinedName('ABCD1')).toBe('ABCD1');
  });
});

describe('the cell registry', () => {
  it('resolves a key to the cell it was registered at', () => {
    const workbook = new WorkbookModel();
    const sheet = workbook.sheet('Cash Flow');
    sheet.at(7, 4, { kind: 'input', value: 1 }, 'cashFlow.noi#0');

    const fromElsewhere = workbook.resolver('Returns');
    expect(fromElsewhere.ref('cashFlow.noi', 0)).toBe("'Cash Flow'!D7");

    // Same-sheet references stay unqualified, which is what makes a schedule
    // readable when you click through it in Excel.
    const fromSame = workbook.resolver('Cash Flow');
    expect(fromSame.ref('cashFlow.noi', 0)).toBe('D7');
  });

  it('refuses to invent a reference for a key that was never registered', () => {
    const workbook = new WorkbookModel();
    workbook.sheet('Revenue');
    const refs = workbook.resolver('Revenue');
    // The alternative is emitting a formula that opens as #REF!, which is
    // discovered by a person rather than by a test.
    expect(() => refs.ref('revenue.missing', 3)).toThrow(/No cell is registered/);
  });

  it('refuses duplicate keys, sheet names and defined names', () => {
    const workbook = new WorkbookModel();
    const sheet = workbook.sheet('Assumptions');
    sheet.at(1, 1, { kind: 'input', value: 1 }, 'a.b');
    expect(() => sheet.at(2, 1, { kind: 'input', value: 2 }, 'a.b')).toThrow(/registered twice/);
    expect(() => workbook.sheet('Assumptions')).toThrow(/Duplicate sheet name/);

    sheet.at(3, 1, { kind: 'input', value: 3, definedName: 'Rate' });
    expect(() => sheet.at(4, 1, { kind: 'input', value: 4, definedName: 'Rate' })).toThrow(
      /Defined name "Rate" was registered twice/,
    );
  });

  it('will not build a range that spans two sheets', () => {
    const workbook = new WorkbookModel();
    const a = workbook.sheet('Revenue');
    const b = workbook.sheet('Expenses');
    a.at(1, 3, { kind: 'input', value: 1 }, 'x#0');
    b.at(1, 4, { kind: 'input', value: 1 }, 'x#1');
    const refs = workbook.resolver('Revenue');
    expect(() => refs.range('x', 0, 1)).toThrow(/cannot span sheets/);
  });

  it('rejects a formula naming a defined name that does not exist', () => {
    const workbook = new WorkbookModel();
    workbook.sheet('Returns');
    const refs = workbook.resolver('Returns');
    expect(() => refs.name('ExitCapRate')).toThrow(/never defined/);
  });
});

describe('forward references', () => {
  it('lets an earlier sheet reference a later one', () => {
    // Summary is written first and references Returns, which does not exist
    // yet. Resolving formulas eagerly would make this impossible and force the
    // sheets into dependency order rather than reading order.
    const workbook = new WorkbookModel();
    const summary = workbook.sheet('Summary');
    summary.at(
      2,
      2,
      { kind: 'formula', formula: (refs) => refs.ref('returns.leveredIrr') },
      'summary.leveredIrr',
    );

    const returns = workbook.sheet('Returns');
    returns.at(20, 6, { kind: 'input', value: 0.17 }, 'returns.leveredIrr');

    const resolved = summary.cells
      .find((cell) => cell.key === 'summary.leveredIrr')
      ?.formula?.(workbook.resolver('Summary'));
    expect(resolved).toBe('Returns!F20');
  });
});

describe('coverage', () => {
  it('counts derived cells only, and reports a static one as a gap', () => {
    const workbook = new WorkbookModel();
    const sheet = workbook.sheet('Revenue');
    sheet.at(1, 1, { kind: 'label', value: 'Base rent' });
    sheet.at(1, 2, { kind: 'input', value: 100 });
    sheet.at(1, 3, { kind: 'formula', formula: () => 'B1*2' });
    sheet.at(1, 4, { kind: 'formula', formula: () => 'B1*3' });
    sheet.at(1, 5, { kind: 'staticDerived', value: 400 });
    sheet.at(1, 6, { kind: 'metadata', value: 'Suite 100' });

    const report = measureCoverage(workbook);
    // Inputs, labels and metadata are excluded: a formula in any of them would
    // be wrong, so counting them would flatter the metric.
    expect(report.calculatedCells).toBe(3);
    expect(report.formulaCells).toBe(2);
    expect(report.staticDerivedCells).toBe(1);
    expect(report.formulaCoverage).toBeCloseTo(2 / 3, 10);
    expect(report.inputCells).toBe(1);
  });

  it('reports full coverage when there is nothing to calculate', () => {
    const workbook = new WorkbookModel();
    workbook.sheet('Notes').at(1, 1, { kind: 'label', value: 'Nothing here' });
    expect(measureCoverage(workbook).formulaCoverage).toBe(1);
  });
});

describe('rendering to a real workbook', () => {
  async function reopen(buffer: Uint8Array): Promise<ExcelJS.Workbook> {
    const reopened = new ExcelJS.Workbook();
    // ExcelJS's typings declare `interface Buffer extends ArrayBuffer`, which
    // does not describe node's Buffer. `readWorkbook` in this package already
    // casts the same way; matching it rather than inventing a second workaround.
    await reopened.xlsx.load(buffer as unknown as ArrayBuffer);
    return reopened;
  }

  it('writes formulas as formulas, and keeps the cached value beside them', async () => {
    const workbook = new WorkbookModel();
    const sheet = workbook.sheet('Cash Flow');
    sheet.at(1, 1, { kind: 'input', value: 250, definedName: 'Revenue_' }, 'cf.revenue');
    sheet.at(
      2,
      1,
      {
        kind: 'formula',
        formula: (refs) => `${refs.ref('cf.revenue')}*2`,
        cachedValue: 500,
        format: 'currency',
      },
      'cf.doubled',
    );

    const reopened = await reopen(await renderWorkbook(workbook));
    const cell = reopened.getWorksheet('Cash Flow')?.getCell(2, 1);
    const value = cell?.value as ExcelJS.CellFormulaValue;

    expect(value.formula).toBe('A1*2');
    // The cached result is what Excel shows before it recalculates, and what
    // the reconciliation tests will read. It must not have replaced the formula.
    expect(value.result).toBe(500);
  });

  it('asks Excel to recalculate on open', async () => {
    // Without this the cached values above are entitled to stand forever and
    // the workbook is a report wearing a model's clothes.
    //
    // Asserted against the file rather than against a reopened workbook:
    // ExcelJS writes `calcPr` but its reader does not populate
    // `calcProperties` when loading, so a round-trip assertion fails on a
    // correct file and would have sent us to fix working code. Checked by
    // reading the XML the writer actually produced.
    const workbook = new WorkbookModel();
    workbook.sheet('S').at(1, 1, { kind: 'formula', formula: () => '1+1', cachedValue: 2 });

    const xml = zipEntry(await renderWorkbook(workbook), 'xl/workbook.xml');
    expect(xml).toMatch(/<calcPr[^>]*fullCalcOnLoad="1"/);
  });

  it('carries defined names through to the file', async () => {
    const workbook = new WorkbookModel();
    const sheet = workbook.sheet('Assumptions');
    sheet.at(5, 2, { kind: 'input', value: 0.0575, definedName: 'ExitCapRate' }, 'a.exitCap');

    const reopened = await reopen(await renderWorkbook(workbook));
    expect(reopened.definedNames.getNames('Assumptions!B5')).toContain('ExitCapRate');
  });

  it('lays a series across period columns and totals it', async () => {
    const axis = timeAxis(periods(3));
    const workbook = new WorkbookModel();
    const sheet = workbook.sheet('Revenue');
    seriesRow(sheet, axis, { label: 'Base rent', key: 'rev.base' }, (period) => ({
      kind: 'staticDerived',
      value: 100 * (period + 1),
    }));

    const reopened = await reopen(await renderWorkbook(workbook));
    const worksheet = reopened.getWorksheet('Revenue');
    expect(worksheet?.getCell(1, 1).value).toBe('Base rent');
    // Periods start at column C, leaving A for the label and B for the total.
    expect(worksheet?.getCell(1, 3).value).toBe(100);
    expect(worksheet?.getCell(1, 5).value).toBe(300);
    expect((worksheet?.getCell(1, 2).value as ExcelJS.CellFormulaValue).formula).toBe('SUM(C1:E1)');
  });

  it('refuses to render a formula cell with no formula', async () => {
    const workbook = new WorkbookModel();
    workbook.sheet('Broken').at(1, 1, { kind: 'formula', cachedValue: 5 });
    await expect(renderWorkbook(workbook)).rejects.toThrow(/marked as a formula but has none/);
  });
});

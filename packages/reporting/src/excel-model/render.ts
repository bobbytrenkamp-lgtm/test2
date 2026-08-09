import ExcelJS from 'exceljs';
import type { WorkbookModel } from './model.js';
import { HEADER_FILL, NUMBER_FORMATS, SECTION_FILL, fontColour } from './styles.js';

/**
 * Turns a `WorkbookModel` into an .xlsx buffer.
 *
 * This is the only file that talks to ExcelJS. Everything above it reasons
 * about keys, formulas and periods; if the spreadsheet library is ever
 * replaced, it is replaced here and nowhere else.
 */

export interface RenderOptions {
  creator?: string;
  /** Written into the workbook properties so a reader knows what produced it. */
  description?: string;
}

export async function renderWorkbook(
  model: WorkbookModel,
  options: RenderOptions = {},
): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = options.creator ?? 'CRE Platform';
  workbook.created = new Date();
  if (options.description !== undefined) workbook.description = options.description;

  /*
   * Recalculate on load.
   *
   * Cached values are written next to every formula, so without this Excel is
   * entitled to display them and never evaluate anything — the workbook would
   * look right and be inert, which is the exact failure this feature exists to
   * avoid. `fullCalcOnLoad` is the property ExcelJS 4.4 writes into
   * `calcPr`; it was checked against the installed version rather than copied
   * from an example.
   */
  workbook.calcProperties.fullCalcOnLoad = true;

  for (const sheetModel of model.sheets) {
    const sheet = workbook.addWorksheet(sheetModel.name);

    const freezeRows = sheetModel.options.freezeRows ?? 0;
    const freezeColumns = sheetModel.options.freezeColumns ?? 0;
    if (freezeRows > 0 || freezeColumns > 0) {
      sheet.views = [{ state: 'frozen', xSplit: freezeColumns, ySplit: freezeRows }];
    }

    for (const width of sheetModel.options.columnWidths ?? []) {
      sheet.getColumn(width.column).width = width.width;
    }

    const refs = model.resolver(sheetModel.name);

    for (const cell of sheetModel.cells) {
      const target = sheet.getCell(cell.row, cell.col);

      let formulaText: string | undefined;
      if (cell.kind === 'formula') {
        if (!cell.formula) {
          throw new Error(
            `Cell ${sheetModel.name}!${cell.row}:${cell.col} is marked as a formula but has none.`,
          );
        }
        formulaText = cell.formula(refs);
        /*
         * `result` is the cached value, not a replacement for the formula.
         * ExcelJS writes both; Excel shows the cached value until it
         * recalculates, which with `fullCalcOnLoad` is immediately on open.
         */
        target.value = {
          formula: formulaText,
          ...(cell.cachedValue === undefined || cell.cachedValue === null
            ? {}
            : { result: cell.cachedValue }),
        } as ExcelJS.CellFormulaValue;
      } else if (cell.value !== undefined && cell.value !== null) {
        target.value = cell.value;
      }

      if (cell.format !== undefined && cell.format !== 'text') {
        target.numFmt = NUMBER_FORMATS[cell.format];
      }

      target.font = {
        color: { argb: fontColour(cell.kind, formulaText) },
        bold: cell.bold === true || cell.kind === 'header',
        size: 11,
      };

      if (cell.kind === 'header') {
        target.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: HEADER_FILL } };
      } else if (cell.kind === 'label' && cell.bold === true) {
        target.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: SECTION_FILL } };
      }

      if (cell.indent !== undefined && cell.indent > 0) {
        target.alignment = { indent: cell.indent };
      }

      if (cell.note !== undefined) {
        target.note = cell.note;
      }
    }
  }

  for (const entry of model.definedNameEntries()) {
    workbook.definedNames.add(entry.ref, entry.name);
  }

  const buffer = await workbook.xlsx.writeBuffer();
  return Buffer.from(buffer);
}

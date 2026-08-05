import ExcelJS from 'exceljs';

/**
 * Reading a spreadsheet file into the rows the import pipeline already takes.
 *
 * A rent roll arrives as `.xlsx` far more often than as `.csv`, and until now
 * the answer was "save it as CSV first" — a step that existed only because the
 * software could not be bothered. This is the same door the clipboard paste
 * uses: a different reader in front of the *same* proven pipeline, not a second
 * pipeline that would drift from the first.
 *
 * The output is `string[][]`, exactly what `parseCsv` produces, so header
 * detection, column mapping, number and date normalisation, validation and
 * duplicate detection are all reached unchanged.
 *
 * ## Why converting a cell is not `String(value)`
 *
 * Every interesting failure in a spreadsheet import is a cell that converted
 * without complaining and meant something else afterwards:
 *
 * - **Dates.** Excel holds them as serial numbers and exceljs hands back a
 *   `Date`. `String(date)` gives a locale-dependent sentence; `toISOString()`
 *   silently shifts a date across midnight for anyone west of UTC, turning a
 *   lease that expires on the 1st into one that expires on the 31st. The date
 *   part is taken in UTC and formatted as YYYY-MM-DD.
 * - **Formulas.** A formula cell is `{ formula, result }`. Taking the cell's
 *   text would import `=B2*12` as a tenant name. The computed result is what
 *   the person looking at the sheet saw, so that is what is read.
 * - **Rich text.** A cell somebody part-bolded is `{ richText: [...] }`, which
 *   stringifies to `[object Object]` — a value that flows all the way into a
 *   tenant name without ever looking like an error.
 * - **Hyperlinks.** `{ text, hyperlink }`; the text is what was meant.
 * - **Errors.** `{ error: '#REF!' }` is not a value and must not become the
 *   string "#REF!" in a rent roll. It becomes empty, and the row then fails
 *   validation like any other missing field.
 */

/** A cell value flattened to the text the pipeline expects. */
export function cellToString(value: unknown): string {
  if (value === null || value === undefined) return '';

  if (value instanceof Date) {
    // UTC, and date-only. See the note above about midnight.
    const year = value.getUTCFullYear();
    const month = String(value.getUTCMonth() + 1).padStart(2, '0');
    const day = String(value.getUTCDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
  }

  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (typeof value === 'string') return value.trim();

  if (typeof value === 'object') {
    const cell = value as Record<string, unknown>;

    // An error cell has no value. Empty is honest; "#REF!" is not.
    if ('error' in cell) return '';

    if ('result' in cell) return cellToString(cell.result);
    if ('text' in cell && typeof cell.text === 'string') return cell.text.trim();

    if ('richText' in cell && Array.isArray(cell.richText)) {
      return (cell.richText as Array<{ text?: string }>)
        .map((part) => part.text ?? '')
        .join('')
        .trim();
    }

    // A shared formula with no cached result: nothing was computed, so there is
    // nothing to import. Better empty than the formula's own text.
    if ('sharedFormula' in cell || 'formula' in cell) return '';
  }

  return String(value).trim();
}

export interface WorkbookSheet {
  name: string;
  rows: string[][];
}

/**
 * Every worksheet in a workbook, as rows of text.
 *
 * All sheets are returned rather than only the first. A rent roll workbook
 * routinely carries a cover sheet, a rent roll and a set of notes, and silently
 * importing whichever happens to be first is how somebody imports the notes.
 * The caller chooses; `pickRentRollSheet` suggests.
 */
export async function readWorkbook(data: Buffer): Promise<WorkbookSheet[]> {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(data as unknown as ArrayBuffer);

  const sheets: WorkbookSheet[] = [];
  workbook.eachSheet((worksheet) => {
    const rows: string[][] = [];
    let widest = 0;

    worksheet.eachRow({ includeEmpty: true }, (row) => {
      const cells: string[] = [];
      // `eachCell` skips empty cells, which would shift every value after a gap
      // one column to the left — a rent roll with a blank column would import
      // rents into the expiry column. Indexing by position keeps the shape.
      const count = Math.max(row.cellCount, widest);
      for (let column = 1; column <= count; column += 1) {
        cells.push(cellToString(row.getCell(column).value));
      }
      widest = Math.max(widest, cells.length);
      rows.push(cells);
    });

    // Pad every row to the widest, so the pipeline sees a rectangle.
    const rectangular = rows.map((row) => {
      const padded = [...row];
      while (padded.length < widest) padded.push('');
      return padded;
    });

    // Trailing rows that are entirely empty are formatting, not data. Excel
    // reports a used range far below the last real row surprisingly often.
    while (rectangular.length > 0 && rectangular[rectangular.length - 1]?.every((c) => c === '')) {
      rectangular.pop();
    }

    sheets.push({ name: worksheet.name, rows: rectangular });
  });

  return sheets;
}

/**
 * Which sheet most looks like a rent roll.
 *
 * A suggestion, never a decision: the import wizard shows which sheet was
 * chosen and lets it be changed. Scored on the words a rent roll header row
 * actually contains, with a tie broken by size, because a cover sheet that
 * happens to mention "tenant" is smaller than the roll itself.
 */
export function pickRentRollSheet(sheets: WorkbookSheet[]): number {
  const SIGNALS = ['tenant', 'suite', 'unit', 'lease', 'area', 'rent', 'expir', 'commenc'];

  let best = 0;
  let bestScore = -1;
  sheets.forEach((sheet, index) => {
    const head = sheet.rows.slice(0, 25).flat().join(' ').toLowerCase();
    const hits = SIGNALS.filter((signal) => head.includes(signal)).length;
    // Rows count for far less than a header match, but break ties.
    const score = hits * 1000 + Math.min(sheet.rows.length, 999);
    if (score > bestScore) {
      bestScore = score;
      best = index;
    }
  });
  return best;
}

/** Whether a filename should be read as a workbook rather than as text. */
export function isWorkbookFilename(filename: string): boolean {
  return /\.(xlsx|xlsm)$/i.test(filename.trim());
}

/**
 * The parsing surface the browser is allowed to import.
 *
 * The grid needs to turn a pasted block of spreadsheet text into values, and
 * the import pipeline already knows how to do that: which delimiter a clipboard
 * used, where a quoted comma ends, whether `12,500` is twelve and a half
 * thousand, whether `03/04/2026` is March or April. Writing a second reader for
 * the grid would mean a paste into a cell and a paste into the importer
 * disagreeing about the same text, which is precisely the drift this project
 * keeps refusing elsewhere.
 *
 * So this is the same code reached by a different door.
 *
 * It exists as its own entry point rather than widening `index.ts` because the
 * package's main entry pulls in ExcelJS, and a megabyte of workbook writer has
 * no business in a browser bundle that only wants to read a tab-separated
 * string. Every module re-exported here is dependency-free; a test pins that,
 * so adding an import to one of them fails rather than quietly inflating the
 * bundle.
 */

export { parseCsv, detectDelimiter, toCsv } from './csv.js';
export type { ParseOptions } from './csv.js';

export {
  normalizeNumber,
  normalizeDate,
  normalizeStatus,
  normalizeRecoveryMethod,
  suggestField,
  RENT_ROLL_FIELDS,
} from './rent-roll-import.js';
export type { RentRollField, FieldDefinition } from './rent-roll-import.js';

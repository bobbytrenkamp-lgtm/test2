/**
 * Spreadsheet reference arithmetic.
 *
 * Everything that turns a (sheet, row, column) into text Excel understands
 * lives here, so no other file has to know how A1 notation works or which
 * characters a sheet name may not contain.
 */

/** `1 -> A`, `27 -> AA`. Excel columns are base-26 with no zero digit. */
export function columnLetter(column: number): string {
  if (!Number.isInteger(column) || column < 1) {
    throw new Error(`Column must be a positive integer, received ${column}.`);
  }
  let remaining = column;
  let letters = '';
  while (remaining > 0) {
    const digit = (remaining - 1) % 26;
    letters = String.fromCharCode(65 + digit) + letters;
    remaining = Math.floor((remaining - 1) / 26);
  }
  return letters;
}

export interface Address {
  sheet: string;
  row: number;
  col: number;
}

export interface RefOptions {
  /** Absolute column, `$D5`. */
  absoluteColumn?: boolean;
  /** Absolute row, `D$5`. */
  absoluteRow?: boolean;
}

function local(address: Address, options: RefOptions = {}): string {
  const column = `${options.absoluteColumn ? '$' : ''}${columnLetter(address.col)}`;
  const row = `${options.absoluteRow ? '$' : ''}${address.row}`;
  return `${column}${row}`;
}

/**
 * A sheet name as it appears inside a formula.
 *
 * Excel requires quoting when the name contains anything but letters, digits
 * and underscores, and an apostrophe inside a quoted name is doubled. Getting
 * this wrong produces a workbook that opens with `#REF!` rather than one that
 * fails to open, which is the harder failure to notice.
 */
export function quoteSheet(name: string): string {
  return /^[A-Za-z0-9_]+$/.test(name) ? name : `'${name.replace(/'/g, "''")}'`;
}

/** A reference usable from any sheet. */
export function refTo(address: Address, fromSheet?: string, options?: RefOptions): string {
  const cell = local(address, options);
  if (fromSheet !== undefined && fromSheet === address.sheet) return cell;
  return `${quoteSheet(address.sheet)}!${cell}`;
}

/** A contiguous range. Both ends must be on the same sheet. */
export function rangeTo(from: Address, to: Address, fromSheet?: string): string {
  if (from.sheet !== to.sheet) {
    throw new Error(
      `A range cannot span sheets: ${from.sheet} to ${to.sheet}. ` +
        'Sum the parts on each sheet and add the results instead.',
    );
  }
  const start = local(from);
  const end = local(to);
  if (fromSheet !== undefined && fromSheet === from.sheet) return `${start}:${end}`;
  return `${quoteSheet(from.sheet)}!${start}:${end}`;
}

/** An absolute reference, which is what a defined name should point at. */
export function absoluteRef(address: Address): string {
  return `${quoteSheet(address.sheet)}!$${columnLetter(address.col)}$${address.row}`;
}

/**
 * Excel forbids `[ ] : * ? / \` in a sheet name and caps it at 31 characters.
 * A name that survives this unchanged is left alone so the common case reads
 * as written.
 */
export function safeSheetName(name: string): string {
  const cleaned = name.replace(/[[\]:*?/\\]/g, ' ').trim();
  return (cleaned || 'Sheet').slice(0, 31);
}

/**
 * A defined name Excel will accept.
 *
 * Names must start with a letter or underscore, may contain only word
 * characters and full stops, and must not look like a cell reference — `A1` or
 * `XFD1048576` are addresses, not names. The trailing underscore on a
 * collision is deliberate: silently returning something that resolves to a
 * different cell would be worse than an ugly name.
 */
export function safeDefinedName(name: string): string {
  let cleaned = name.replace(/[^A-Za-z0-9_.]/g, '');
  if (cleaned === '' || /^[0-9.]/.test(cleaned)) cleaned = `_${cleaned}`;
  if (/^[A-Za-z]{1,3}[0-9]{1,7}$/.test(cleaned)) cleaned = `${cleaned}_`;
  return cleaned.slice(0, 255);
}

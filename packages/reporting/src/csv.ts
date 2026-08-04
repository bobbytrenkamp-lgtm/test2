/**
 * CSV parsing and serialisation.
 *
 * Written by hand rather than pulled from a dependency because rent rolls
 * arrive with quoted commas, embedded newlines, BOMs and mixed line endings,
 * and the behaviour on each of those needs to be pinned down by our own tests
 * rather than inherited from a library's defaults.
 */

export interface ParseOptions {
  delimiter?: string;
  /** Stops after this many rows. Used for previewing a large upload. */
  maxRows?: number;
}

export function parseCsv(text: string, options: ParseOptions = {}): string[][] {
  const delimiter = options.delimiter ?? detectDelimiter(text);
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  let index = 0;

  // Strip a UTF-8 byte order mark, which otherwise becomes part of the first
  // header and breaks every column match.
  const input = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;

  const pushField = (): void => {
    row.push(field);
    field = '';
  };
  const pushRow = (): boolean => {
    row.push(field);
    field = '';
    rows.push(row);
    row = [];
    return options.maxRows !== undefined && rows.length >= options.maxRows;
  };

  while (index < input.length) {
    const char = input[index] as string;

    if (inQuotes) {
      if (char === '"') {
        if (input[index + 1] === '"') {
          field += '"';
          index += 2;
          continue;
        }
        inQuotes = false;
        index += 1;
        continue;
      }
      field += char;
      index += 1;
      continue;
    }

    if (char === '"' && field === '') {
      inQuotes = true;
      index += 1;
      continue;
    }
    if (char === delimiter) {
      pushField();
      index += 1;
      continue;
    }
    if (char === '\r') {
      index += input[index + 1] === '\n' ? 2 : 1;
      if (pushRow()) return rows;
      continue;
    }
    if (char === '\n') {
      index += 1;
      if (pushRow()) return rows;
      continue;
    }
    field += char;
    index += 1;
  }

  if (field !== '' || row.length > 0) pushRow();
  return rows;
}

/** Picks the delimiter that yields the most consistent column count. */
export function detectDelimiter(text: string): string {
  const sample = text.split(/\r?\n/).slice(0, 20).join('\n');
  const candidates = [',', ';', '\t', '|'];
  let best = ',';
  let bestScore = -1;
  for (const candidate of candidates) {
    const counts = sample
      .split('\n')
      .filter((line) => line.trim() !== '')
      .map((line) => line.split(candidate).length);
    if (counts.length === 0) continue;
    const max = Math.max(...counts);
    if (max < 2) continue;
    const consistent = counts.filter((count) => count === max).length;
    const score = consistent * max;
    if (score > bestScore) {
      bestScore = score;
      best = candidate;
    }
  }
  return best;
}

export function toCsv(rows: Array<Array<string | number | null | undefined>>): string {
  return rows
    .map((row) =>
      row
        .map((cell) => {
          const value = cell === null || cell === undefined ? '' : String(cell);
          return /[",\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
        })
        .join(','),
    )
    .join('\r\n');
}

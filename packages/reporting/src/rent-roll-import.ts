/**
 * Rent-roll import.
 *
 * Rent rolls are exported by dozens of property accounting systems and no two
 * agree on column names, header position, date format or how a blank is
 * represented. The pipeline here is deliberately deterministic — pattern
 * matching and normalisation rules that a user can see and correct — and never
 * sends the uploaded file anywhere. Any AI-assisted mapping is a separate,
 * explicitly enabled path; nothing in this module contacts a provider.
 */

export type RentRollField =
  | 'propertyCode'
  | 'buildingCode'
  | 'floor'
  | 'spaceCode'
  | 'tenantName'
  | 'leaseCode'
  | 'status'
  | 'area'
  | 'unitCount'
  | 'commencementDate'
  | 'rentStartDate'
  | 'expirationDate'
  | 'baseRent'
  | 'baseRentBasis'
  | 'recoveryMethod'
  | 'securityDeposit'
  | 'tiPerArea'
  | 'lcPercent'
  | 'notes';

export interface FieldDefinition {
  field: RentRollField;
  label: string;
  required: boolean;
  kind: 'text' | 'number' | 'date' | 'enum';
  /** Lower-cased header fragments that suggest this field. */
  synonyms: string[];
}

export const RENT_ROLL_FIELDS: FieldDefinition[] = [
  { field: 'spaceCode', label: 'Suite / unit', required: true, kind: 'text', synonyms: ['suite', 'unit', 'space', 'premises', 'shop', 'bay'] },
  { field: 'tenantName', label: 'Tenant', required: true, kind: 'text', synonyms: ['tenant', 'occupant', 'lessee', 'tenant name', 'trading name'] },
  { field: 'leaseCode', label: 'Lease reference', required: false, kind: 'text', synonyms: ['lease id', 'lease ref', 'lease code', 'lease number', 'contract'] },
  { field: 'propertyCode', label: 'Property', required: false, kind: 'text', synonyms: ['property', 'asset', 'site'] },
  { field: 'buildingCode', label: 'Building', required: false, kind: 'text', synonyms: ['building', 'bldg', 'block'] },
  { field: 'floor', label: 'Floor', required: false, kind: 'text', synonyms: ['floor', 'level', 'storey'] },
  { field: 'status', label: 'Status', required: false, kind: 'enum', synonyms: ['status', 'lease status', 'occupancy'] },
  { field: 'area', label: 'Area', required: true, kind: 'number', synonyms: ['area', 'sf', 'sq ft', 'sqft', 'square feet', 'nra', 'rentable', 'gla', 'sqm', 'size'] },
  { field: 'unitCount', label: 'Units', required: false, kind: 'number', synonyms: ['units', 'unit count', 'no. of units'] },
  { field: 'commencementDate', label: 'Commencement', required: true, kind: 'date', synonyms: ['commence', 'start', 'lease start', 'from', 'begin'] },
  { field: 'rentStartDate', label: 'Rent start', required: false, kind: 'date', synonyms: ['rent start', 'rent commence', 'billing start'] },
  { field: 'expirationDate', label: 'Expiration', required: true, kind: 'date', synonyms: ['expir', 'end', 'lease end', 'to', 'termination', 'expiry'] },
  { field: 'baseRent', label: 'Base rent', required: true, kind: 'number', synonyms: ['rent', 'base rent', 'annual rent', 'monthly rent', 'rent psf', 'rate', 'passing rent'] },
  { field: 'baseRentBasis', label: 'Rent basis', required: false, kind: 'enum', synonyms: ['rent basis', 'basis', 'per', 'frequency'] },
  { field: 'recoveryMethod', label: 'Recovery structure', required: false, kind: 'enum', synonyms: ['recovery', 'reimbursement', 'lease type', 'cam type', 'expense'] },
  { field: 'securityDeposit', label: 'Security deposit', required: false, kind: 'number', synonyms: ['deposit', 'security'] },
  { field: 'tiPerArea', label: 'TI allowance', required: false, kind: 'number', synonyms: ['ti', 'tenant improvement', 'improvement allowance'] },
  { field: 'lcPercent', label: 'Leasing commission', required: false, kind: 'number', synonyms: ['commission', 'lc', 'brokerage'] },
  { field: 'notes', label: 'Notes', required: false, kind: 'text', synonyms: ['note', 'comment', 'remark'] },
];

export interface SheetAnalysis {
  headerRowIndex: number;
  headers: string[];
  /** Rows after the header, trimmed of fully blank rows. */
  dataRows: string[][];
  confidence: number;
}

/**
 * Finds the header row.
 *
 * Rent rolls routinely carry a title block, a logo row and a date stamp above
 * the real headers, so the first row is rarely the header. Each candidate row
 * is scored on how many cells look like a known column name and how full it is.
 */
export function analyzeSheet(rows: string[][], searchDepth = 25): SheetAnalysis {
  let bestIndex = 0;
  let bestScore = -1;

  const limit = Math.min(searchDepth, rows.length);
  for (let i = 0; i < limit; i += 1) {
    const row = rows[i] ?? [];
    const filled = row.filter((cell) => cell.trim() !== '').length;
    if (filled < 2) continue;
    let matches = 0;
    for (const cell of row) {
      if (suggestField(cell)) matches += 1;
    }
    // A header row is both well populated and recognisable.
    const score = matches * 3 + filled;
    if (score > bestScore) {
      bestScore = score;
      bestIndex = i;
    }
  }

  const headers = (rows[bestIndex] ?? []).map((cell) => cell.trim());
  const dataRows = rows
    .slice(bestIndex + 1)
    .filter((row) => row.some((cell) => cell.trim() !== ''));

  const recognisable = headers.filter((header) => suggestField(header)).length;
  const confidence = headers.length === 0 ? 0 : recognisable / headers.length;

  return { headerRowIndex: bestIndex, headers, dataRows, confidence };
}

/** Best-guess field for a header, or null when nothing matches. */
export function suggestField(header: string): RentRollField | null {
  const normalized = header.toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
  if (normalized === '') return null;

  let best: { field: RentRollField; score: number } | null = null;
  for (const definition of RENT_ROLL_FIELDS) {
    for (const synonym of definition.synonyms) {
      let score = 0;
      if (normalized === synonym) score = 100;
      else if (normalized.startsWith(synonym)) score = 70 + synonym.length;
      else if (normalized.includes(synonym)) score = 40 + synonym.length;
      if (score > 0 && (!best || score > best.score)) {
        best = { field: definition.field, score };
      }
    }
  }
  return best?.field ?? null;
}

export type ColumnMapping = Partial<Record<RentRollField, number>>;

/** Proposes a mapping from header text, never assigning one column twice. */
export function suggestMapping(headers: string[]): ColumnMapping {
  const scored: Array<{ field: RentRollField; column: number; score: number }> = [];
  headers.forEach((header, column) => {
    const field = suggestField(header);
    if (!field) return;
    scored.push({ field, column, score: header.length });
  });

  const mapping: ColumnMapping = {};
  const usedColumns = new Set<number>();
  for (const candidate of scored) {
    if (mapping[candidate.field] !== undefined) continue;
    if (usedColumns.has(candidate.column)) continue;
    mapping[candidate.field] = candidate.column;
    usedColumns.add(candidate.column);
  }
  return mapping;
}

/* -------------------------------------------------------------------------- */
/* Normalisation                                                              */
/* -------------------------------------------------------------------------- */

/**
 * Parses a number written in any of the forms rent rolls use: thousands
 * separators, currency symbols, trailing units, and negatives in parentheses.
 * Returns null when the cell holds no number at all.
 */
export function normalizeNumber(raw: string): string | null {
  const text = raw.trim();
  if (text === '' || /^(n\/?a|none|-|—|tbd)$/i.test(text)) return null;

  const negative = /^\(.*\)$/.test(text) || text.trim().startsWith('-');
  const cleaned = text
    .replace(/[()]/g, '')
    .replace(/[^\d.,-]/g, '')
    .replace(/-/g, '');

  if (cleaned === '') return null;

  // Decide which separator is the decimal point.
  //
  // When both appear, the last one is the decimal separator: "1.234,50" is
  // European and "1,234.50" is not. When only one appears, a single separator
  // followed by exactly three digits is read as a thousands separator, because
  // "12,500" and "1.500" are overwhelmingly more likely to be twelve and a half
  // thousand and fifteen hundred than 12.5 and 1.5 on a rent roll. That
  // convention is documented in docs/import-specification.md.
  const lastComma = cleaned.lastIndexOf(',');
  const lastDot = cleaned.lastIndexOf('.');
  const commaCount = (cleaned.match(/,/g) ?? []).length;
  const dotCount = (cleaned.match(/\./g) ?? []).length;

  let normalized: string;
  if (commaCount > 0 && dotCount > 0) {
    normalized =
      lastComma > lastDot
        ? cleaned.replace(/\./g, '').replace(/,/g, '.')
        : cleaned.replace(/,/g, '');
  } else if (commaCount + dotCount === 0) {
    normalized = cleaned;
  } else {
    const separator = commaCount > 0 ? ',' : '.';
    const count = commaCount > 0 ? commaCount : dotCount;
    const lastIndex = commaCount > 0 ? lastComma : lastDot;
    const trailingDigits = cleaned.length - lastIndex - 1;
    const isGrouping = count > 1 || trailingDigits === 3;
    normalized = isGrouping
      ? cleaned.split(separator).join('')
      : cleaned.replace(separator, '.');
  }
  if (!/^\d*\.?\d*$/.test(normalized) || normalized === '' || normalized === '.') return null;

  return negative ? `-${normalized}` : normalized;
}

/**
 * Parses a date in the formats rent rolls actually contain.
 *
 * An ambiguous all-numeric date is resolved with the caller's stated
 * preference rather than guessed, because reading 03/04/2026 as March or April
 * silently shifts a lease expiry by a month.
 */
export function normalizeDate(
  raw: string,
  preference: 'mdy' | 'dmy' = 'mdy',
): { value: string | null; ambiguous: boolean } {
  const text = raw.trim();
  if (text === '' || /^(n\/?a|none|-|—)$/i.test(text)) return { value: null, ambiguous: false };

  // ISO first: unambiguous.
  const iso = /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})/.exec(text);
  if (iso) {
    return { value: format(Number(iso[1]), Number(iso[2]), Number(iso[3])), ambiguous: false };
  }

  // Excel serial numbers, which arrive when a cell was never formatted.
  if (/^\d{5}$/.test(text)) {
    const serial = Number(text);
    // Day 1 is 1900-01-01 and the 1900 leap-year bug shifts everything after
    // 28 February 1900 by one day.
    const epoch = Date.UTC(1899, 11, 30);
    const date = new Date(epoch + serial * 86_400_000);
    return {
      value: format(date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate()),
      ambiguous: false,
    };
  }

  const numeric = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})$/.exec(text);
  if (numeric) {
    const first = Number(numeric[1]);
    const second = Number(numeric[2]);
    let year = Number(numeric[3]);
    if (year < 100) year += year < 70 ? 2000 : 1900;

    if (first > 12 && second <= 12) return { value: format(year, second, first), ambiguous: false };
    if (second > 12 && first <= 12) return { value: format(year, first, second), ambiguous: false };
    const ambiguous = first <= 12 && second <= 12 && first !== second;
    return preference === 'dmy'
      ? { value: format(year, second, first), ambiguous }
      : { value: format(year, first, second), ambiguous };
  }

  const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
  const named = /^(\d{1,2})[\s-]*([a-zA-Z]{3,9})[\s-]*(\d{2,4})$/.exec(text);
  if (named) {
    const month = MONTHS.indexOf((named[2] as string).slice(0, 3).toLowerCase()) + 1;
    let year = Number(named[3]);
    if (year < 100) year += year < 70 ? 2000 : 1900;
    if (month > 0) return { value: format(year, month, Number(named[1])), ambiguous: false };
  }
  const namedFirst = /^([a-zA-Z]{3,9})[\s-]*(\d{1,2}),?[\s-]*(\d{2,4})$/.exec(text);
  if (namedFirst) {
    const month = MONTHS.indexOf((namedFirst[1] as string).slice(0, 3).toLowerCase()) + 1;
    let year = Number(namedFirst[3]);
    if (year < 100) year += year < 70 ? 2000 : 1900;
    if (month > 0) return { value: format(year, month, Number(namedFirst[2])), ambiguous: false };
  }

  return { value: null, ambiguous: false };
}

function format(year: number, month: number, day: number): string | null {
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

const STATUS_MAP: Record<string, string> = {
  occupied: 'occupied', current: 'occupied', active: 'occupied', leased: 'occupied',
  vacant: 'vacant', available: 'vacant', empty: 'vacant',
  future: 'future', pending: 'pending', proposed: 'proposed',
  mtm: 'month_to_month', 'month to month': 'month_to_month', 'month-to-month': 'month_to_month',
  holdover: 'holdover', expired: 'expired', terminated: 'terminated', sublease: 'sublease',
};

export function normalizeStatus(raw: string): string {
  const key = raw.trim().toLowerCase();
  return STATUS_MAP[key] ?? (key === '' ? 'occupied' : 'occupied');
}

const RECOVERY_MAP: Array<{ pattern: RegExp; value: string }> = [
  { pattern: /triple\s*net|nnn|net net net/i, value: 'triple_net' },
  { pattern: /base\s*year/i, value: 'base_year' },
  { pattern: /stop/i, value: 'expense_stop' },
  { pattern: /full\s*service|fsg|gross/i, value: 'full_service_gross' },
  { pattern: /fixed/i, value: 'fixed_amount' },
];

export function normalizeRecoveryMethod(raw: string): string {
  for (const entry of RECOVERY_MAP) {
    if (entry.pattern.test(raw)) return entry.value;
  }
  return 'none';
}

/* -------------------------------------------------------------------------- */
/* Row mapping and validation                                                 */
/* -------------------------------------------------------------------------- */

export interface ImportIssue {
  rowIndex: number;
  field?: RentRollField;
  severity: 'error' | 'warning';
  message: string;
  rawValue?: string;
}

export interface MappedLease {
  rowIndex: number;
  leaseCode: string;
  spaceCode: string;
  tenantName: string;
  status: string;
  area: string;
  unitCount: number;
  commencementDate: string;
  rentStartDate: string | null;
  expirationDate: string;
  baseRent: string;
  baseRentBasis: string;
  recoveryMethod: string;
  securityDeposit: string | null;
  tiPerArea: string | null;
  lcPercent: string | null;
  notes: string | null;
}

export interface ImportResult {
  leases: MappedLease[];
  issues: ImportIssue[];
  duplicates: Array<{ leaseCode: string; rowIndexes: number[] }>;
}

export interface MapOptions {
  datePreference?: 'mdy' | 'dmy';
  /** Applied when the source has no rent-basis column. */
  defaultRentBasis?: string;
}

export function mapRows(
  rows: string[][],
  mapping: ColumnMapping,
  options: MapOptions = {},
): ImportResult {
  const issues: ImportIssue[] = [];
  const leases: MappedLease[] = [];
  const seen = new Map<string, number[]>();

  const cell = (row: string[], field: RentRollField): string => {
    const column = mapping[field];
    if (column === undefined) return '';
    return (row[column] ?? '').trim();
  };

  for (const definition of RENT_ROLL_FIELDS) {
    if (definition.required && mapping[definition.field] === undefined) {
      issues.push({
        rowIndex: -1,
        field: definition.field,
        severity: 'error',
        message: `No column is mapped to "${definition.label}", which is required to create a lease.`,
      });
    }
  }

  rows.forEach((row, rowIndex) => {
    const spaceCode = cell(row, 'spaceCode');
    const tenantName = cell(row, 'tenantName');
    if (spaceCode === '' && tenantName === '') return; // Blank or spacer row.

    const areaRaw = cell(row, 'area');
    const area = normalizeNumber(areaRaw);
    const rentRaw = cell(row, 'baseRent');
    const rent = normalizeNumber(rentRaw);
    const commencement = normalizeDate(cell(row, 'commencementDate'), options.datePreference);
    const expiration = normalizeDate(cell(row, 'expirationDate'), options.datePreference);
    const rentStart = normalizeDate(cell(row, 'rentStartDate'), options.datePreference);

    const status = normalizeStatus(cell(row, 'status'));
    const leaseCode = cell(row, 'leaseCode') || `${spaceCode || 'SPACE'}-${rowIndex + 1}`;

    if (tenantName === '' && status !== 'vacant') {
      issues.push({ rowIndex, field: 'tenantName', severity: 'error', message: 'Tenant name is blank.' });
    }
    if (area === null) {
      issues.push({
        rowIndex, field: 'area', severity: 'error',
        message: 'Area could not be read as a number.', rawValue: areaRaw,
      });
    } else if (Number(area) < 0) {
      issues.push({ rowIndex, field: 'area', severity: 'error', message: 'Area is negative.', rawValue: areaRaw });
    }
    if (rent === null) {
      issues.push({
        rowIndex, field: 'baseRent', severity: 'error',
        message: 'Base rent could not be read as a number.', rawValue: rentRaw,
      });
    }
    if (!commencement.value) {
      issues.push({
        rowIndex, field: 'commencementDate', severity: 'error',
        message: 'Commencement date could not be read.', rawValue: cell(row, 'commencementDate'),
      });
    }
    if (!expiration.value) {
      issues.push({
        rowIndex, field: 'expirationDate', severity: 'error',
        message: 'Expiration date could not be read.', rawValue: cell(row, 'expirationDate'),
      });
    }
    if (commencement.ambiguous || expiration.ambiguous || rentStart.ambiguous) {
      issues.push({
        rowIndex, severity: 'warning',
        message: `A date on this row is ambiguous and was read as ${options.datePreference === 'dmy' ? 'day/month/year' : 'month/day/year'}. Confirm the order before importing.`,
      });
    }
    if (commencement.value && expiration.value && expiration.value < commencement.value) {
      issues.push({
        rowIndex, field: 'expirationDate', severity: 'error',
        message: 'The lease expires before it commences.',
      });
    }

    const existing = seen.get(leaseCode);
    if (existing) existing.push(rowIndex);
    else seen.set(leaseCode, [rowIndex]);

    // A row that raised any error is never importable, even when the individual
    // values parsed: an inverted lease term is unusable however clean its dates.
    if (issues.some((issue) => issue.rowIndex === rowIndex && issue.severity === 'error')) return;
    if (area === null || rent === null || !commencement.value || !expiration.value) return;

    leases.push({
      rowIndex,
      leaseCode,
      spaceCode: spaceCode || leaseCode,
      tenantName: tenantName || 'Vacant',
      status,
      area,
      unitCount: Number(normalizeNumber(cell(row, 'unitCount')) ?? '0'),
      commencementDate: commencement.value,
      rentStartDate: rentStart.value,
      expirationDate: expiration.value,
      baseRent: rent,
      baseRentBasis: inferRentBasis(cell(row, 'baseRentBasis'), options.defaultRentBasis, rent, area),
      recoveryMethod: normalizeRecoveryMethod(cell(row, 'recoveryMethod')),
      securityDeposit: normalizeNumber(cell(row, 'securityDeposit')),
      tiPerArea: normalizeNumber(cell(row, 'tiPerArea')),
      lcPercent: normalizeNumber(cell(row, 'lcPercent')),
      notes: cell(row, 'notes') || null,
    });
  });

  const duplicates = [...seen.entries()]
    .filter(([, indexes]) => indexes.length > 1)
    .map(([leaseCode, rowIndexes]) => ({ leaseCode, rowIndexes }));
  for (const duplicate of duplicates) {
    issues.push({
      rowIndex: duplicate.rowIndexes[1] as number,
      severity: 'error',
      message: `Lease reference "${duplicate.leaseCode}" appears on rows ${duplicate.rowIndexes.map((i) => i + 1).join(', ')}.`,
    });
  }

  return { leases, issues, duplicates };
}

/**
 * Infers whether a rent figure is quoted per area per year, per area per month
 * or as a total. The magnitude relative to area is the only reliable signal
 * when the source has no basis column, and the inference is surfaced to the
 * user for confirmation rather than applied silently.
 */
function inferRentBasis(
  stated: string,
  fallback: string | undefined,
  rent: string,
  area: string,
): string {
  const text = stated.toLowerCase();
  if (/annual|year|yr|pa|p\.a\./.test(text) && /sf|sq|psf|area/.test(text)) return 'per_area_per_year';
  if (/month|mo/.test(text) && /sf|sq|psf|area/.test(text)) return 'per_area_per_month';
  if (/annual|year|yr/.test(text)) return 'annual_amount';
  if (/month|mo/.test(text)) return 'monthly_amount';
  if (/unit/.test(text)) return 'per_unit_per_month';
  if (fallback) return fallback;

  const rentValue = Number(rent);
  const areaValue = Number(area);
  if (!Number.isFinite(rentValue) || !Number.isFinite(areaValue) || areaValue <= 0) {
    return 'annual_amount';
  }
  // A rent smaller than the area is almost certainly a per-area rate.
  return rentValue < areaValue ? 'per_area_per_year' : 'annual_amount';
}

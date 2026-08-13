import { detectDelimiter, parseCsv } from './csv.js';
import { type ImportIssue, analyzeSheet, normalizeNumber } from './rent-roll-import.js';

/**
 * Actuals and budget import.
 *
 * Accounting systems export a trial balance in one of two shapes, and both are
 * accepted because arguing with the export is not the analyst's job:
 *
 * **Wide** — one row per account, one column per month. This is what a general
 * ledger export usually looks like.
 *
 *     Account, Description,   Jan-26,  Feb-26,  Mar-26
 *     4000,    Base rent,     10000,   10000,   10500
 *     5100,    Repairs,        1200,     900,    1450
 *
 * **Long** — one row per account per month.
 *
 *     Account, Description, Period,   Amount
 *     4000,    Base rent,   2026-01,  10000
 *
 * The shape is detected rather than configured: a header row with two or more
 * cells that parse as months is wide, otherwise long.
 *
 * ## Sign
 *
 * The platform stores amounts in the cash-flow convention — money in positive,
 * money out negative — because that is what makes a favourable variance simply
 * a positive one. Ledgers usually state costs as positive. `expenseSign`
 * declares which convention the file uses, and costs are negated on the way in
 * when it says `positive`.
 *
 * That conversion depends on knowing which rows are costs, so a row whose
 * category cannot be determined is reported rather than guessed at. Guessing
 * would flip the sign of the answer, silently.
 */

export type ActualsField = 'accountCode' | 'accountName' | 'category' | 'period' | 'amount';

export type AccountCategoryName =
  'revenue' | 'operating_expense' | 'capital' | 'debt_service' | 'other';

const FIELD_SYNONYMS: Record<ActualsField, string[]> = {
  accountCode: ['account', 'account code', 'code', 'gl', 'gl code', 'nominal', 'account no'],
  accountName: ['description', 'account name', 'name', 'narrative', 'detail'],
  category: ['category', 'type', 'account type', 'classification', 'group'],
  period: ['period', 'month', 'date', 'posting date', 'accounting period'],
  amount: ['amount', 'value', 'total', 'balance', 'actual', 'budget'],
};

const CATEGORY_SYNONYMS: Record<AccountCategoryName, string[]> = {
  revenue: ['revenue', 'income', 'rent', 'receipts', 'turnover'],
  operating_expense: ['expense', 'operating', 'opex', 'cost', 'expenditure', 'outgoings'],
  capital: ['capital', 'capex', 'ti', 'tenant improvement', 'leasing', 'commission'],
  debt_service: ['debt', 'interest', 'finance', 'loan', 'principal', 'amortisation'],
  other: ['other', 'sundry', 'misc'],
};

const MONTH_NAMES = [
  'jan',
  'feb',
  'mar',
  'apr',
  'may',
  'jun',
  'jul',
  'aug',
  'sep',
  'oct',
  'nov',
  'dec',
];

/**
 * Reads a month from a header cell or a period cell.
 *
 * Returns a first-of-month ISO date, which is how the database stores it: a
 * monthly figure has no meaningful day, and picking one invites a timezone to
 * shift it into the previous month.
 */
export function normalizeMonth(raw: string, defaultCentury = 2000): string | null {
  const text = raw.trim().toLowerCase();
  if (!text) return null;

  // 2026-01, 2026-01-01, 2026/01
  const iso = /^(\d{4})[-/](\d{1,2})(?:[-/](\d{1,2}))?$/.exec(text);
  if (iso) {
    const year = Number(iso[1]);
    const month = Number(iso[2]);
    if (month >= 1 && month <= 12) return `${year}-${String(month).padStart(2, '0')}-01`;
    return null;
  }

  // Jan-26, Jan 2026, January 2026, Jan26
  const named = /^([a-z]{3,9})[\s\-/]*(\d{2}|\d{4})$/.exec(text);
  if (named) {
    const index = MONTH_NAMES.indexOf((named[1] as string).slice(0, 3));
    if (index >= 0) {
      const rawYear = Number(named[2]);
      const year = rawYear < 100 ? defaultCentury + rawYear : rawYear;
      return `${year}-${String(index + 1).padStart(2, '0')}-01`;
    }
    return null;
  }

  // 01/2026, 1-2026
  const numeric = /^(\d{1,2})[-/](\d{4})$/.exec(text);
  if (numeric) {
    const month = Number(numeric[1]);
    if (month >= 1 && month <= 12) return `${numeric[2]}-${String(month).padStart(2, '0')}-01`;
  }

  return null;
}

function isWordChar(char: string | undefined): boolean {
  return char !== undefined && /[a-z0-9]/.test(char);
}

/**
 * Scores how well `synonym` matches `text`. An exact match wins outright,
 * otherwise the synonym must land on a word boundary: "current" contains
 * "rent" and "portion" contains "ti", and scoring those as if the account
 * said "rent" or "TI" files a debt-service line under revenue or capital.
 * A synonym the text starts with beats one merely contained in it, and a
 * longer synonym beats a shorter one.
 */
function synonymScore(text: string, synonym: string): number {
  if (text === synonym) return 100;
  let index = text.indexOf(synonym);
  while (index !== -1) {
    const before = index === 0 ? undefined : text[index - 1];
    const after = text[index + synonym.length];
    if (!isWordChar(before) && !isWordChar(after)) {
      return index === 0 ? 70 + synonym.length : 40 + synonym.length;
    }
    index = text.indexOf(synonym, index + 1);
  }
  return 0;
}

/** Reads a category from the word a chart of accounts uses for it. */
export function suggestCategory(raw: string): AccountCategoryName | null {
  const text = raw.trim().toLowerCase();
  if (!text) return null;

  let best: { category: AccountCategoryName; score: number } | null = null;
  for (const [category, synonyms] of Object.entries(CATEGORY_SYNONYMS)) {
    for (const synonym of synonyms) {
      const score = synonymScore(text, synonym);
      if (score > 0 && (!best || score > best.score)) {
        best = { category: category as AccountCategoryName, score };
      }
    }
  }
  return best?.category ?? null;
}

function suggestField(header: string): ActualsField | null {
  const text = header.trim().toLowerCase().replace(/[_.]+/g, ' ');
  if (!text) return null;
  let best: { field: ActualsField; score: number } | null = null;
  for (const [field, synonyms] of Object.entries(FIELD_SYNONYMS)) {
    for (const synonym of synonyms) {
      const score = synonymScore(text, synonym);
      if (score > 0 && (!best || score > best.score)) {
        best = { field: field as ActualsField, score };
      }
    }
  }
  return best?.field ?? null;
}

export interface ActualsAnalysis {
  layout: 'wide' | 'long';
  headerRowIndex: number;
  headers: string[];
  rowCount: number;
  /** Column index per field, for the columns that were recognised. */
  mapping: Partial<Record<ActualsField, number>>;
  /** For a wide sheet: the month each amount column carries. */
  monthColumns: Array<{ index: number; month: string }>;
  preview: string[][];
}

export function analyzeActuals(content: string): ActualsAnalysis {
  const rows = parseCsv(content, { delimiter: detectDelimiter(content) });
  const sheet = analyzeSheet(rows);

  const monthColumns: Array<{ index: number; month: string }> = [];
  const mapping: Partial<Record<ActualsField, number>> = {};

  for (const [index, header] of sheet.headers.entries()) {
    const month = normalizeMonth(header);
    if (month) {
      monthColumns.push({ index, month });
      continue;
    }
    const field = suggestField(header);
    if (field && mapping[field] === undefined) mapping[field] = index;
  }

  // A period column paired with an amount column settles it: that is a row per
  // account per month whatever else the header contains. Otherwise any
  // month-shaped header means the months are the columns.
  //
  // A single month column has to count. The most ordinary upload in asset
  // management is one month of actuals, and requiring two would reject it.
  const hasLongPair = mapping.period !== undefined && mapping.amount !== undefined;
  const layout: 'wide' | 'long' = !hasLongPair && monthColumns.length > 0 ? 'wide' : 'long';

  return {
    layout,
    headerRowIndex: sheet.headerRowIndex,
    headers: sheet.headers,
    rowCount: sheet.dataRows.length,
    mapping,
    monthColumns: layout === 'wide' ? monthColumns : [],
    preview: sheet.dataRows.slice(0, 5),
  };
}

export interface MappedAccountEntry {
  rowIndex: number;
  accountCode: string;
  accountName: string;
  accountCategory: AccountCategoryName;
  periodMonth: string;
  amount: string;
}

export interface ActualsImportResult {
  entries: MappedAccountEntry[];
  issues: ImportIssue[];
  /** Distinct months seen, sorted. */
  months: string[];
}

export interface ActualsMapOptions {
  /**
   * Whether costs are stated positive in the file. When they are, rows in a
   * cost category are negated so the stored figures follow the cash-flow
   * convention the variance calculation depends on.
   */
  expenseSign?: 'positive' | 'negative';
  /** Category applied to a row whose own category cannot be read. */
  defaultCategory?: AccountCategoryName;
  /** Account-code prefixes mapped to categories, longest prefix winning. */
  categoryByPrefix?: Record<string, AccountCategoryName>;
}

const COST_CATEGORIES = new Set<AccountCategoryName>([
  'operating_expense',
  'capital',
  'debt_service',
]);

function categoryFor(
  code: string,
  declared: string | undefined,
  options: ActualsMapOptions,
): { category: AccountCategoryName; inferred: boolean } {
  if (declared) {
    const fromColumn = suggestCategory(declared);
    if (fromColumn) return { category: fromColumn, inferred: false };
  }

  const prefixes = Object.keys(options.categoryByPrefix ?? {}).sort((a, b) => b.length - a.length);
  for (const prefix of prefixes) {
    if (code.startsWith(prefix)) {
      return {
        category: (options.categoryByPrefix as Record<string, AccountCategoryName>)[
          prefix
        ] as AccountCategoryName,
        inferred: false,
      };
    }
  }

  return { category: options.defaultCategory ?? 'other', inferred: true };
}

/**
 * Maps an analysed sheet into storable entries.
 *
 * A row that produces an error contributes nothing to `entries`. Reporting a
 * problem and importing the row anyway is the worst of both: the warning is
 * ignored because the number arrived.
 */
export function mapActuals(
  content: string,
  analysis: ActualsAnalysis,
  options: ActualsMapOptions = {},
): ActualsImportResult {
  const rows = parseCsv(content, { delimiter: detectDelimiter(content) });
  const dataRows = rows.slice(analysis.headerRowIndex + 1);
  const issues: ImportIssue[] = [];
  const entries: MappedAccountEntry[] = [];
  const months = new Set<string>();

  const codeColumn = analysis.mapping.accountCode;
  const nameColumn = analysis.mapping.accountName;
  const categoryColumn = analysis.mapping.category;

  if (codeColumn === undefined) {
    issues.push({
      rowIndex: -1,
      severity: 'error',
      message:
        'No account code column was found. Expected a column named Account, Code, GL or similar.',
    });
    return { entries: [], issues, months: [] };
  }

  const cell = (row: string[], index: number | undefined): string =>
    index === undefined ? '' : (row[index] ?? '').trim();

  const push = (
    rowIndex: number,
    code: string,
    name: string,
    declaredCategory: string,
    month: string,
    rawAmount: string,
  ): void => {
    const amount = normalizeNumber(rawAmount);
    if (amount === null) {
      issues.push({
        rowIndex,
        severity: 'error',
        message: `"${rawAmount}" in ${month} is not a number that can be read as an amount.`,
        rawValue: rawAmount,
      });
      return;
    }

    const { category, inferred } = categoryFor(code, declaredCategory || undefined, options);
    if (inferred && options.expenseSign === 'positive') {
      // Without a category, the sign cannot be applied, and applying the wrong
      // one reverses the variance rather than merely misplacing it.
      issues.push({
        rowIndex,
        severity: 'warning',
        message:
          `Account ${code} has no category, so it was taken as "${category}" and its sign ` +
          'was left as written. Categorise it if it is a cost.',
      });
    }

    const negate = options.expenseSign === 'positive' && COST_CATEGORIES.has(category);
    const signed = negate && !amount.startsWith('-') ? `-${amount}` : amount;

    months.add(month);
    entries.push({
      rowIndex,
      accountCode: code,
      accountName: name || code,
      accountCategory: category,
      periodMonth: month,
      amount: signed,
    });
  };

  for (const [offset, row] of dataRows.entries()) {
    const rowIndex = offset;
    if (row.every((value) => !value.trim())) continue;

    const code = cell(row, codeColumn);
    if (!code) {
      issues.push({
        rowIndex,
        severity: 'error',
        message: 'The account code is empty, so the row cannot be attributed to an account.',
      });
      continue;
    }
    const name = cell(row, nameColumn);
    const declaredCategory = cell(row, categoryColumn);

    if (analysis.layout === 'wide') {
      for (const column of analysis.monthColumns) {
        const raw = cell(row, column.index);
        // A blank cell in a wide sheet means "nothing posted", which is not the
        // same as a zero someone entered, but stores identically and is not
        // worth an issue.
        if (!raw) continue;
        push(rowIndex, code, name, declaredCategory, column.month, raw);
      }
      continue;
    }

    const periodColumn = analysis.mapping.period;
    const amountColumn = analysis.mapping.amount;
    if (periodColumn === undefined || amountColumn === undefined) {
      issues.push({
        rowIndex,
        severity: 'error',
        message:
          'This looks like one row per account per month, but no period and amount column pair was found.',
      });
      continue;
    }

    const rawMonth = cell(row, periodColumn);
    const month = normalizeMonth(rawMonth);
    if (!month) {
      issues.push({
        rowIndex,
        severity: 'error',
        message: `"${rawMonth}" could not be read as a month.`,
        rawValue: rawMonth,
      });
      continue;
    }
    push(rowIndex, code, name, declaredCategory, month, cell(row, amountColumn));
  }

  // A row that raised an error contributes nothing, even if some of its months
  // parsed. Half an account is not a usable figure.
  const failed = new Set(
    issues.filter((issue) => issue.severity === 'error').map((issue) => issue.rowIndex),
  );

  return {
    entries: entries.filter((entry) => !failed.has(entry.rowIndex)),
    issues,
    months: [...months].sort(),
  };
}

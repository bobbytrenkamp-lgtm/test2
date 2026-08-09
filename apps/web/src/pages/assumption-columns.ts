import { debtTypeEnum, expenseMethodEnum, rentBasisEnum } from '@cre/domain-models';
import {
  parseChoice,
  parseDate,
  parseDecimal,
  parsePercent,
  parseText,
  type ColumnDef,
} from '../grid/columns.js';
import { formatCurrency, formatDate, formatNumber, formatPercent, titleCase } from '../format.js';

/**
 * Grid columns for each model-scoped assumption collection.
 *
 * One file rather than six, because the interesting content is the same
 * question answered six times: **which fields have a meaning complete in a
 * single value, and what will each accept?** Everything a cell cannot express —
 * a monthly schedule, a recovery structure, an escalation, a draw schedule — is
 * left out and stays in the record editor, and the column's help text says so
 * rather than leaving an analyst hunting for a column that was never there.
 *
 * Rows arrive from the API snake_cased (`SELECT *`), and the write API takes
 * camelCase, so a column's `key` is the **camelCase field name** the batch
 * endpoint expects while its `value` reads the snake_cased row.
 */

export type AssumptionRow = Record<string, unknown>;

const text = (row: AssumptionRow, key: string): string => {
  const value = row[key];
  return value === null || value === undefined ? '' : String(value);
};

/** A read-only identifier column. Codes are referenced by traces and reports. */
function codeColumn(): ColumnDef<AssumptionRow> {
  return {
    key: 'code',
    label: 'Code',
    width: 130,
    frozen: true,
    editable: false,
    value: (row) => text(row, 'code'),
    help: 'The stable identifier used in traces, reports and other records. Changing it would orphan those references, so it is set when the row is created.',
  };
}

function nameColumn(width = 200): ColumnDef<AssumptionRow> {
  return {
    key: 'name',
    label: 'Name',
    width,
    frozen: true,
    value: (row) => text(row, 'name'),
    parse: parseText({ maxLength: 200 }),
  };
}

/** A currency amount whose meaning depends on the row's method. */
function amountColumn(currency: string, help: string): ColumnDef<AssumptionRow> {
  return {
    key: 'amount',
    label: 'Amount',
    width: 130,
    numeric: true,
    value: (row) => text(row, 'amount'),
    display: (row, value) =>
      String(row.method ?? '').startsWith('percent_of_')
        ? formatPercent(value)
        : formatCurrency(value, currency, { decimals: 2 }),
    parse: parseDecimal(),
    help,
  };
}

function percentColumn(
  key: string,
  label: string,
  options: { width?: number; max?: number; help?: string } = {},
): ColumnDef<AssumptionRow> {
  const snake = key.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);
  return {
    key,
    label,
    width: options.width ?? 140,
    numeric: true,
    value: (row) => text(row, snake),
    display: (_row, value) => (value === '' ? '—' : formatPercent(value)),
    parse: parsePercent(options.max === undefined ? {} : { max: options.max }),
    ...(options.help ? { help: options.help } : {}),
  };
}

function monthsColumn(key: string, label: string, help?: string): ColumnDef<AssumptionRow> {
  const snake = key.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);
  return {
    key,
    label,
    width: 120,
    numeric: true,
    value: (row) => text(row, snake),
    display: (_row, value) => (value === '' ? '—' : formatNumber(value, 0)),
    parse: parseDecimal({ min: 0, label }),
    ...(help ? { help } : {}),
  };
}

function choiceColumn(
  key: string,
  label: string,
  options: readonly string[],
  width = 190,
): ColumnDef<AssumptionRow> {
  const snake = key.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);
  return {
    key,
    label,
    width,
    value: (row) => text(row, snake),
    display: (_row, value) => (value === '' ? '—' : titleCase(value)),
    parse: parseChoice(options, (raw) =>
      raw
        .trim()
        .toLowerCase()
        .replace(/[\s-]+/g, '_'),
    ),
    options: options.map((option) => ({ value: option, label: titleCase(option) })),
  };
}

function boolColumn(key: string, label: string, help?: string): ColumnDef<AssumptionRow> {
  const snake = key.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);
  return {
    key,
    label,
    width: 150,
    value: (row) => (row[snake] === true ? 'true' : 'false'),
    display: (_row, value) => (value === 'true' ? 'Yes' : 'No'),
    parse: (raw) => {
      const cleaned = raw.trim().toLowerCase();
      if (['true', 'yes', 'y', '1'].includes(cleaned)) return { ok: true, value: 'true' };
      if (['false', 'no', 'n', '0', ''].includes(cleaned)) return { ok: true, value: 'false' };
      return { ok: false, reason: `“${raw.trim()}” is not yes or no.` };
    },
    options: [
      { value: 'true', label: 'Yes' },
      { value: 'false', label: 'No' },
    ],
    ...(help ? { help } : {}),
  };
}

function dateColumn(key: string, label: string, help?: string): ColumnDef<AssumptionRow> {
  const snake = key.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);
  return {
    key,
    label,
    width: 130,
    value: (row) => text(row, snake).slice(0, 10),
    display: (_row, value) => (value === '' ? '—' : formatDate(value)),
    parse: parseDate,
    ...(help ? { help } : {}),
  };
}

/** A free-text reference to a growth curve's code. Validated by the engine. */
function growthCurveColumn(): ColumnDef<AssumptionRow> {
  return {
    key: 'growthCurve',
    label: 'Growth curve',
    width: 150,
    value: (row) => text(row, 'growth_curve'),
    display: (_row, value) => value || '—',
    parse: parseText({ maxLength: 60 }),
    help: 'The code of a growth curve defined below. An unknown code is reported by validation rather than silently treated as no growth.',
  };
}

/* -------------------------------------------------------------------------- */

const EXPENSE_CATEGORIES = [
  'operating',
  'utilities',
  'management',
  'taxes',
  'insurance',
  'repairs',
  'administrative',
  'ground_rent',
  'other',
] as const;

const CAPITAL_CATEGORIES = [
  'reserve',
  'building_improvement',
  'tenant_improvement',
  'development',
  'other',
] as const;

const CAPITAL_METHODS = [
  'fixed_annual',
  'per_area_per_year',
  'per_unit_per_year',
  'one_time',
  'custom_monthly_schedule',
] as const;

const REVENUE_METHODS = [
  'fixed_annual',
  'per_area_per_year',
  'per_unit_per_year',
  'percent_of_base_rent',
  'custom_monthly_schedule',
] as const;

/**
 * Columns by collection segment.
 *
 * `null` means the collection has no grid: growth curves carry a per-year rate
 * table that is a list, not a value, so a single "default rate" column would
 * invite an analyst to edit the fallback while the years that actually apply sit
 * out of sight.
 */
export function assumptionColumns(
  segment: string,
  options: { currency: string; areaUnit: string },
): Array<ColumnDef<AssumptionRow>> | null {
  const { currency, areaUnit } = options;

  switch (segment) {
    case 'expenses':
      return [
        codeColumn(),
        nameColumn(),
        choiceColumn('category', 'Category', EXPENSE_CATEGORIES, 160),
        choiceColumn('method', 'Method', expenseMethodEnum.options, 230),
        amountColumn(
          currency,
          `Read according to the method: a total for the year, a rate per ${areaUnit}, per unit, or a percentage. Changing the method reinterprets this figure; it does not convert it.`,
        ),
        growthCurveColumn(),
        percentColumn('recoverableShare', 'Recoverable', {
          max: 1,
          help: 'The share eligible for recovery from tenants, before each lease’s own method and caps apply.',
        }),
        percentColumn('variableShare', 'Occupancy variable', {
          max: 1,
          help: 'The share that scales with physical occupancy. The rest is fixed. A wholly variable expense at 80% occupancy costs 80% of its base.',
        }),
        boolColumn(
          'isCapitalized',
          'Capitalised',
          'Capitalised expenses are added to capital expenditure below NOI rather than deducted as an operating cost.',
        ),
      ];

    case 'other-revenue':
      return [
        codeColumn(),
        nameColumn(),
        choiceColumn(
          'category',
          'Category',
          ['parking', 'storage', 'signage', 'antenna', 'other'],
          150,
        ),
        choiceColumn('method', 'Method', REVENUE_METHODS, 230),
        amountColumn(currency, 'Read according to the method beside it.'),
        growthCurveColumn(),
        boolColumn(
          'varyWithOccupancy',
          'Varies with occupancy',
          'Parking usually does; a signage licence usually does not.',
        ),
      ];

    case 'capital':
      return [
        codeColumn(),
        nameColumn(),
        choiceColumn('category', 'Category', CAPITAL_CATEGORIES, 190),
        choiceColumn('method', 'Method', CAPITAL_METHODS, 210),
        amountColumn(currency, 'Read according to the method beside it.'),
        dateColumn('startDate', 'Start', 'Blank means the forecast start.'),
        dateColumn('endDate', 'End', 'Blank means the end of the forecast.'),
        growthCurveColumn(),
        boolColumn(
          'capitalized',
          'Capitalised',
          'Capitalised items sit below NOI. An expensed item is deducted above it.',
        ),
      ];

    case 'debt':
      return [
        codeColumn(),
        nameColumn(180),
        choiceColumn('type', 'Type', debtTypeEnum.options, 170),
        {
          key: 'commitment',
          label: 'Commitment',
          width: 150,
          numeric: true,
          value: (row) => text(row, 'commitment'),
          display: (_row, value) => formatCurrency(value, currency, { decimals: 0 }),
          parse: parseDecimal({ min: 0, label: 'Commitment' }),
        },
        {
          key: 'initialFunding',
          label: 'Initial funding',
          width: 150,
          numeric: true,
          value: (row) => text(row, 'initial_funding'),
          display: (_row, value) => formatCurrency(value, currency, { decimals: 0 }),
          parse: parseDecimal({ min: 0, label: 'Initial funding' }),
          help: 'Drawn at the funding date. Later draws are a dated schedule and live in the record editor.',
        },
        dateColumn('fundingDate', 'Funds'),
        choiceColumn('rateType', 'Rate type', ['fixed', 'floating'], 130),
        percentColumn('fixedRate', 'Fixed rate', {
          width: 120,
          help: 'Used when the rate type is fixed. On a floating facility this is the fixed component only.',
        }),
        percentColumn('spread', 'Spread', {
          width: 110,
          help: 'Added to the index curve on a floating facility.',
        }),
        percentColumn('rateFloor', 'Floor', { width: 110 }),
        percentColumn('rateCap', 'Cap', { width: 110 }),
        monthsColumn('interestOnlyMonths', 'IO months'),
        monthsColumn('amortizationMonths', 'Amort. months'),
        monthsColumn('termMonths', 'Term'),
        percentColumn('originationFeePercent', 'Origination fee', { width: 150 }),
        percentColumn('exitFeePercent', 'Exit fee', { width: 120 }),
        {
          ...percentColumn('minimumDscr', 'Min DSCR', { width: 120 }),
          hiddenByDefault: true,
          help: 'A covenant, not a rate: tested each period and reported as a breach. Left out of the default view because most facilities in a model do not carry one.',
        },
        boolColumn(
          'capitalizeInterest',
          'Capitalises interest',
          'Interest joins the balance instead of being paid in cash. Usual on construction facilities.',
        ),
        boolColumn('repayOnSale', 'Repays on sale'),
      ];

    case 'market-leasing':
      return [
        codeColumn(),
        nameColumn(190),
        {
          key: 'marketRent',
          label: 'Market rent',
          width: 140,
          numeric: true,
          value: (row) => text(row, 'market_rent'),
          display: (_row, value) => formatCurrency(value, currency, { decimals: 2 }),
          parse: parseDecimal({ min: 0, label: 'Market rent' }),
        },
        choiceColumn('marketRentBasis', 'Rent basis', rentBasisEnum.options, 180),
        {
          key: 'marketRentGrowthCurve',
          label: 'Rent growth',
          width: 150,
          value: (row) => text(row, 'market_rent_growth_curve'),
          display: (_row, value) => value || '—',
          parse: parseText({ maxLength: 60 }),
        },
        percentColumn('renewalProbability', 'Renewal probability', {
          width: 170,
          max: 1,
          help: 'The rollover is weighted: a renewal branch at this probability and a new-lease branch at its complement. Downtime applies only to the new-lease branch.',
        }),
        monthsColumn('renewalTermMonths', 'Renewal term'),
        monthsColumn('newLeaseTermMonths', 'New term'),
        monthsColumn('downtimeMonths', 'Downtime'),
        monthsColumn('renewalFreeRentMonths', 'Renewal free rent'),
        monthsColumn('newFreeRentMonths', 'New free rent'),
        {
          key: 'renewalTiPerArea',
          label: `Renewal TI / ${areaUnit}`,
          width: 150,
          numeric: true,
          value: (row) => text(row, 'renewal_ti_per_area'),
          display: (_row, value) => formatCurrency(value, currency, { decimals: 2 }),
          parse: parseDecimal({ min: 0, label: 'Renewal TI' }),
        },
        {
          key: 'newTiPerArea',
          label: `New TI / ${areaUnit}`,
          width: 150,
          numeric: true,
          value: (row) => text(row, 'new_ti_per_area'),
          display: (_row, value) => formatCurrency(value, currency, { decimals: 2 }),
          parse: parseDecimal({ min: 0, label: 'New TI' }),
        },
        percentColumn('renewalLcPercent', 'Renewal LC', { width: 140 }),
        percentColumn('newLcPercent', 'New LC', { width: 130 }),
        {
          key: 'precedence',
          label: 'Precedence',
          width: 120,
          numeric: true,
          value: (row) => text(row, 'precedence'),
          parse: parseDecimal({ label: 'Precedence' }),
          help: 'Resolves overlaps when more than one profile could apply. The winner is recorded in the trace.',
        },
      ];

    // Growth curves carry a per-year rate list, which is not a cell.
    case 'growth-curves':
      return null;

    default:
      return null;
  }
}

/**
 * Fields the grid may write for a collection.
 *
 * Derived from the columns rather than listed twice: a column that is editable
 * is a field the batch endpoint will be asked to write, and keeping the two in
 * one place removes the chance of them disagreeing.
 */
export function editableFields(columns: Array<ColumnDef<AssumptionRow>>): Set<string> {
  return new Set(columns.filter((column) => column.editable !== false).map((column) => column.key));
}

/** A row with its pending edits applied, for display and for totals. */
export function withPendingAssumption(
  row: AssumptionRow,
  pending: Record<string, string> | undefined,
): AssumptionRow {
  if (!pending) return row;
  const next = { ...row };
  for (const [camel, value] of Object.entries(pending)) {
    const snake = camel.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);
    next[snake] = value === 'true' ? true : value === 'false' ? false : value;
  }
  return next;
}

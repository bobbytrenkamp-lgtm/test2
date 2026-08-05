import type { CashFlowLine, ModelInput, ModelResult } from '@cre/domain-models';
import { Decimal, ZERO, d } from './decimal.js';
import { safeDivide, toStringOrNull } from './metrics.js';

/**
 * Comparing two versions of a model.
 *
 * The question is never "what are these two numbers" — both are on screen
 * already. It is **what changed, and what did that change do**. So a comparison
 * has to answer both halves: the assumptions someone edited, and the effect
 * those edits had on value and return.
 *
 * Reporting only the second half produces the familiar useless artefact: a
 * value that moved by four million with no account of why. Reporting only the
 * first produces a diff nobody can prioritise, where a renamed lease sits
 * beside a discount rate that moved fifty basis points.
 *
 * Two rules.
 *
 * **A change is described in the units it was made in.** A discount rate that
 * moved from 8% to 8.5% is a rate change of fifty basis points, not a decimal
 * that went from "0.08" to "0.085". A rent that moved is currency.
 *
 * **Nothing is inferred that was not recorded.** Two versions are two frozen
 * inputs; if a lease exists in both with the same code, it is the same lease.
 * If a code appears in one and not the other, that is an addition or a removal
 * — not a rename, because nothing in the record says it was one, and guessing
 * would silently pair two unrelated tenancies.
 */

export type ChangeKind = 'added' | 'removed' | 'changed';

export interface FieldChange {
  /** Dotted path into the model input, e.g. `valuation.discountRate`. */
  path: string;
  /** How the field should be read: a rate, an amount, a count, or plain text. */
  unit: 'rate' | 'currency' | 'area' | 'months' | 'text';
  before: string | null;
  after: string | null;
  /** `after − before`, for the units where subtraction means something. */
  delta: string | null;
}

export interface EntityChange {
  kind: ChangeKind;
  /** `lease`, `expense`, `capital`, `debt`, or `assumption`. */
  entity: string;
  /** The stable code the entity is known by in both versions. */
  code: string;
  label: string;
  /** Empty for an addition or a removal: the whole entity is the change. */
  fields: FieldChange[];
}

export interface LineDelta {
  line: CashFlowLine;
  before: string;
  after: string;
  delta: string;
  /** `delta ÷ |before|`, null when the base is zero. */
  percentChange: string | null;
}

export interface YearDelta {
  fiscalYear: number;
  lines: LineDelta[];
}

export interface VersionComparison {
  /** What someone edited. */
  inputChanges: EntityChange[];
  /** What those edits did, year by year. */
  annual: YearDelta[];
  /** And to the figures a decision is actually made on. */
  headline: {
    value: LineDelta | null;
    netOperatingIncomeYear1: LineDelta | null;
    unleveredIrr: FieldChange | null;
    leveredIrr: FieldChange | null;
    equityMultiple: FieldChange | null;
  };
  /** True when the two versions were produced by different engine versions. */
  engineChanged: boolean;
  engineBefore: string;
  engineAfter: string;
}

/* -------------------------------------------------------------------------- */
/* Input differences                                                          */
/* -------------------------------------------------------------------------- */

function change(
  path: string,
  unit: FieldChange['unit'],
  before: unknown,
  after: unknown,
): FieldChange | null {
  const a = before === null || before === undefined ? null : String(before);
  const b = after === null || after === undefined ? null : String(after);
  if (a === b) return null;

  // A delta only means something where subtraction does. Text has none, and a
  // field that appeared or disappeared has no base to subtract from.
  let delta: string | null = null;
  if (unit !== 'text' && a !== null && b !== null) {
    const difference = d(b).minus(d(a));
    /*
     * Numbers are compared as numbers, not as the strings they arrived in.
     * PostgreSQL returns a `numeric(12,8)` as "0.08000000" and a literal in a
     * fixture as "0.08"; a textual comparison would report that as a change
     * with a delta of zero, and a diff that flags things nobody edited is one
     * people stop reading.
     */
    if (difference.isZero()) return null;
    delta = difference.toString();
  }
  return { path, unit, before: a, after: b, delta };
}

/** The model-level assumptions, which are the ones that move everything at once. */
const ASSUMPTION_FIELDS: Array<[string, FieldChange['unit']]> = [
  ['discountRate', 'rate'],
  ['terminalCapRate', 'rate'],
  ['directCapRate', 'rate'],
  ['saleCostPercent', 'rate'],
  ['generalVacancyRate', 'rate'],
  ['creditLossRate', 'rate'],
  ['acquisitionPrice', 'currency'],
  ['acquisitionCosts', 'currency'],
  ['grossSalePriceOverride', 'currency'],
  ['saleMonth', 'months'],
  ['discountingConvention', 'text'],
  ['terminalNoiBasis', 'text'],
];

const LEASE_FIELDS: Array<[string, FieldChange['unit']]> = [
  ['area', 'area'],
  ['baseRent', 'currency'],
  ['baseRentBasis', 'text'],
  ['commencementDate', 'text'],
  ['expirationDate', 'text'],
  ['status', 'text'],
];

const EXPENSE_FIELDS: Array<[string, FieldChange['unit']]> = [
  ['amount', 'currency'],
  ['method', 'text'],
  ['category', 'text'],
  ['recoverableShare', 'rate'],
  ['variableShare', 'rate'],
  ['growthCurveId', 'text'],
];

const CAPITAL_FIELDS: Array<[string, FieldChange['unit']]> = [
  ['amount', 'currency'],
  ['method', 'text'],
  ['category', 'text'],
  ['startDate', 'text'],
];

const DEBT_FIELDS: Array<[string, FieldChange['unit']]> = [
  ['commitment', 'currency'],
  ['initialFunding', 'currency'],
  ['fixedRate', 'rate'],
  ['spread', 'rate'],
  ['termMonths', 'months'],
  ['amortizationMonths', 'months'],
  ['rateType', 'text'],
];

interface Coded {
  id?: string;
  code?: string;
  name?: string;
  [key: string]: unknown;
}

/**
 * Matches two collections by their stable identifier.
 *
 * An entity present in one version and not the other is an addition or a
 * removal. It is never reported as a rename: nothing in a frozen input records
 * that one thing became another, and pairing them on similarity would
 * confidently equate two unrelated tenancies.
 */
function diffCollection(
  entity: string,
  fields: Array<[string, FieldChange['unit']]>,
  before: Coded[],
  after: Coded[],
): EntityChange[] {
  const key = (item: Coded): string => String(item.code ?? item.id ?? '');
  const label = (item: Coded): string => String(item.name ?? item.code ?? item.id ?? '');

  const beforeByKey = new Map(before.map((item) => [key(item), item]));
  const afterByKey = new Map(after.map((item) => [key(item), item]));
  const changes: EntityChange[] = [];

  for (const [code, item] of afterByKey) {
    const previous = beforeByKey.get(code);
    if (!previous) {
      changes.push({ kind: 'added', entity, code, label: label(item), fields: [] });
      continue;
    }
    const fieldChanges = fields
      .map(([field, unit]) =>
        change(`${entity}.${code}.${field}`, unit, previous[field], item[field]),
      )
      .filter((entry): entry is FieldChange => entry !== null);
    if (fieldChanges.length > 0) {
      changes.push({ kind: 'changed', entity, code, label: label(item), fields: fieldChanges });
    }
  }

  for (const [code, item] of beforeByKey) {
    if (!afterByKey.has(code)) {
      changes.push({ kind: 'removed', entity, code, label: label(item), fields: [] });
    }
  }

  // Stable order: additions, then changes, then removals, alphabetical within
  // each. A diff whose order shifts between runs cannot be read side by side.
  const rank: Record<ChangeKind, number> = { added: 0, changed: 1, removed: 2 };
  return changes.sort((a, b) => rank[a.kind] - rank[b.kind] || a.code.localeCompare(b.code));
}

export function compareInputs(before: ModelInput, after: ModelInput): EntityChange[] {
  const changes: EntityChange[] = [];

  const assumptionFields = ASSUMPTION_FIELDS.map(([field, unit]) =>
    change(
      `valuation.${field}`,
      unit,
      (before.valuation as Record<string, unknown>)[field],
      (after.valuation as Record<string, unknown>)[field],
    ),
  ).filter((entry): entry is FieldChange => entry !== null);

  const forecastFields = [
    change('forecast.months', 'months', before.forecast.months, after.forecast.months),
    change('forecast.startDate', 'text', before.forecast.startDate, after.forecast.startDate),
  ].filter((entry): entry is FieldChange => entry !== null);

  const modelFields = [...assumptionFields, ...forecastFields];
  if (modelFields.length > 0) {
    changes.push({
      kind: 'changed',
      entity: 'assumption',
      code: 'model',
      label: 'Model assumptions',
      fields: modelFields,
    });
  }

  changes.push(
    ...diffCollection('lease', LEASE_FIELDS, before.leases as Coded[], after.leases as Coded[]),
    ...diffCollection(
      'expense',
      EXPENSE_FIELDS,
      before.expenses as Coded[],
      after.expenses as Coded[],
    ),
    ...diffCollection(
      'capital',
      CAPITAL_FIELDS,
      (before.capital ?? []) as Coded[],
      (after.capital ?? []) as Coded[],
    ),
    ...diffCollection(
      'debt',
      DEBT_FIELDS,
      (before.debt ?? []) as Coded[],
      (after.debt ?? []) as Coded[],
    ),
  );

  return changes;
}

/* -------------------------------------------------------------------------- */
/* Result differences                                                         */
/* -------------------------------------------------------------------------- */

function lineDelta(line: CashFlowLine, before: string, after: string): LineDelta {
  const a = d(before);
  const b = d(after);
  const delta = b.minus(a);
  return {
    line,
    before: a.toString(),
    after: b.toString(),
    delta: delta.toString(),
    // Against the magnitude of the base, so a cost that grew more negative
    // reports a positive percentage increase rather than a sign flip.
    percentChange: toStringOrNull(safeDivide(delta, a.abs())),
  };
}

function metricChange(
  path: string,
  unit: FieldChange['unit'],
  before: string | null,
  after: string | null,
): FieldChange | null {
  return change(path, unit, before, after);
}

function dcfValue(result: ModelResult): Decimal {
  const dcf = result.valuations.find((valuation) => valuation.method === 'dcf');
  if (dcf) return d(dcf.value);
  const direct = result.valuations.find(
    (valuation) => valuation.method === 'direct_capitalization',
  );
  return direct ? d(direct.value) : ZERO;
}

/**
 * Year-by-year movement in the lines a reader actually interrogates.
 *
 * Not every line: a comparison that lists all twenty-seven for every year is a
 * wall nobody reads, and the subtotals below are what a change in any component
 * shows up in anyway.
 */
const COMPARED_LINES: CashFlowLine[] = [
  'scheduledBaseRent',
  'expenseRecoveries',
  'effectiveGrossRevenue',
  'operatingExpenses',
  'netOperatingIncome',
  'unleveredCashFlow',
  'leveredCashFlow',
];

export function compareResults(before: ModelResult, after: ModelResult): YearDelta[] {
  const years = new Set<number>([
    ...before.annual.map((row) => row.fiscalYear),
    ...after.annual.map((row) => row.fiscalYear),
  ]);

  const beforeByYear = new Map(before.annual.map((row) => [row.fiscalYear, row]));
  const afterByYear = new Map(after.annual.map((row) => [row.fiscalYear, row]));

  return [...years]
    .sort((a, b) => a - b)
    .map((fiscalYear) => ({
      fiscalYear,
      lines: COMPARED_LINES.map((line) =>
        lineDelta(
          line,
          // A year present in only one version compares against zero, which is
          // the truth: the other version forecast nothing for it.
          beforeByYear.get(fiscalYear)?.lines[line] ?? '0',
          afterByYear.get(fiscalYear)?.lines[line] ?? '0',
        ),
      ),
    }));
}

export function compareVersions(
  before: { input: ModelInput; result: ModelResult },
  after: { input: ModelInput; result: ModelResult },
): VersionComparison {
  const firstYear = (result: ModelResult): string =>
    result.annual[0]?.lines.netOperatingIncome ?? '0';

  return {
    inputChanges: compareInputs(before.input, after.input),
    annual: compareResults(before.result, after.result),
    headline: {
      value: lineDelta(
        'netOperatingIncome',
        dcfValue(before.result).toString(),
        dcfValue(after.result).toString(),
      ),
      netOperatingIncomeYear1: lineDelta(
        'netOperatingIncome',
        firstYear(before.result),
        firstYear(after.result),
      ),
      unleveredIrr: metricChange(
        'returns.unleveredIrr',
        'rate',
        before.result.returns.unleveredIrr,
        after.result.returns.unleveredIrr,
      ),
      leveredIrr: metricChange(
        'returns.leveredIrr',
        'rate',
        before.result.returns.leveredIrr,
        after.result.returns.leveredIrr,
      ),
      equityMultiple: metricChange(
        'returns.equityMultiple',
        'text',
        before.result.returns.equityMultiple,
        after.result.returns.equityMultiple,
      ),
    },
    /*
     * Flagged rather than hidden. Two versions calculated by different engine
     * versions may differ for reasons nobody edited, and a reader comparing
     * them needs to know that before attributing a movement to an assumption.
     */
    engineChanged: before.result.engineVersion !== after.result.engineVersion,
    engineBefore: before.result.engineVersion,
    engineAfter: after.result.engineVersion,
  };
}

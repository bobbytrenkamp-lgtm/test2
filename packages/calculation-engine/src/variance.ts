import type { AccountCategory, VarianceDesignation } from '@cre/domain-models';
import { Decimal, ZERO, d, money } from './decimal.js';

/**
 * Budget, actuals and variance.
 *
 * ## The sign convention, and why it decides everything else
 *
 * Every amount here follows the same convention as the cash-flow statement:
 * **money in is positive, money out is negative.** An expense budget of 50,000
 * is stored as `-50000`.
 *
 * That one decision removes an entire class of bug. Under it, a favourable
 * variance is simply a positive one — for every account, with no reference to
 * whether the line is revenue or cost:
 *
 * | | Budget | Actual | Variance | Reading |
 * | --- | --- | --- | --- | --- |
 * | Revenue | 100 | 120 | +20 | more income — favourable |
 * | Revenue | 100 | 80 | −20 | less income — unfavourable |
 * | Expense | −50 | −60 | −10 | spent more — unfavourable |
 * | Expense | −50 | −40 | +10 | spent less — favourable |
 *
 * The alternative — storing costs positive and flipping the comparison for
 * cost accounts — needs a correct category on every row to produce a correct
 * answer, and silently reports the opposite of the truth when one is wrong.
 * Here a miscategorised row lands in the wrong subtotal, which is visible,
 * rather than reversing its own variance, which is not.
 *
 * The account category is therefore used for grouping and subtotals only.
 *
 * ## What "variance" means
 *
 * `variance = actual − budget`, and more generally `comparison − base`. The
 * base is whichever set of numbers is being measured against: an original
 * budget, an approved budget, or a prior forecast. Nothing here assumes the
 * base is "the" budget, because comparing a reforecast against the original
 * budget and against the approved budget are different questions.
 */

/** One account's amount in one month. */
export interface BudgetLine {
  accountCode: string;
  accountName: string;
  category: AccountCategory;
  /** First day of the month the amount belongs to, `YYYY-MM-DD`. */
  periodMonth: string;
  /** Decimal string, cash-flow convention: deductions are negative. */
  amount: string;
}

export interface VarianceRow {
  accountCode: string;
  accountName: string;
  category: AccountCategory;
  base: string;
  comparison: string;
  variance: string;
  /** `variance / |base|`, or null when the base is zero. */
  variancePercent: string | null;
  designation: VarianceDesignation;
}

export interface VarianceGroup {
  category: AccountCategory;
  rows: VarianceRow[];
  base: string;
  comparison: string;
  variance: string;
  variancePercent: string | null;
  designation: VarianceDesignation;
}

export interface VarianceReport {
  /** Inclusive month range covered, `YYYY-MM-DD` first-of-month. */
  fromMonth: string | null;
  toMonth: string | null;
  groups: VarianceGroup[];
  rows: VarianceRow[];
  totalBase: string;
  totalComparison: string;
  totalVariance: string;
  totalVariancePercent: string | null;
  totalDesignation: VarianceDesignation;
  /** Accounts present on one side only, which are usually a mapping mistake. */
  unmatchedAccounts: string[];
}

export interface VarianceOptions {
  /** Restrict to months on or after this first-of-month date. */
  fromMonth?: string | null;
  /** Restrict to months on or before this first-of-month date. */
  toMonth?: string | null;
  /**
   * Variances smaller than this in absolute value are reported as neutral.
   * An asset manager writing commentary does not want to explain £3.
   */
  materialityAmount?: string | null;
  /**
   * Variances smaller than this as a fraction of the base are reported as
   * neutral. Applied together with `materialityAmount`: a row must clear both
   * to be called favourable or unfavourable.
   */
  materialityPercent?: string | null;
}

const CATEGORY_ORDER: AccountCategory[] = [
  'revenue',
  'operating_expense',
  'capital',
  'debt_service',
  'other',
];

function inRange(month: string, options: VarianceOptions): boolean {
  if (options.fromMonth && month < options.fromMonth) return false;
  if (options.toMonth && month > options.toMonth) return false;
  return true;
}

/**
 * Designates a variance, honouring materiality.
 *
 * A variance that clears neither threshold is neutral rather than favourable:
 * calling a rounding difference "favourable" trains people to ignore the
 * column.
 */
function designate(
  variance: Decimal,
  base: Decimal,
  options: VarianceOptions,
): VarianceDesignation {
  if (variance.isZero()) return 'neutral';

  const minimumAmount = options.materialityAmount ? d(options.materialityAmount).abs() : ZERO;
  if (variance.abs().lessThan(minimumAmount)) return 'neutral';

  if (options.materialityPercent && !base.isZero()) {
    const share = variance.dividedBy(base.abs()).abs();
    if (share.lessThan(d(options.materialityPercent).abs())) return 'neutral';
  }

  return variance.isPositive() ? 'favourable' : 'unfavourable';
}

function percentOf(variance: Decimal, base: Decimal): string | null {
  // A percentage against a zero base is not "infinite", it is meaningless: any
  // amount against nothing budgeted is a new line, not a large overspend.
  if (base.isZero()) return null;
  return variance.dividedBy(base.abs()).toDecimalPlaces(6).toString();
}

interface Accumulated {
  accountCode: string;
  accountName: string;
  category: AccountCategory;
  base: Decimal;
  comparison: Decimal;
  inBase: boolean;
  inComparison: boolean;
}

/**
 * Compares two sets of monthly amounts account by account.
 *
 * Both sides are summed over the requested months first, so a single row is one
 * account over the whole window rather than one account-month.
 */
export function computeVariance(
  base: BudgetLine[],
  comparison: BudgetLine[],
  options: VarianceOptions = {},
): VarianceReport {
  const accounts = new Map<string, Accumulated>();
  const months: string[] = [];

  const absorb = (lines: BudgetLine[], side: 'base' | 'comparison'): void => {
    for (const line of lines) {
      if (!inRange(line.periodMonth, options)) continue;
      months.push(line.periodMonth);

      const existing = accounts.get(line.accountCode);
      const entry: Accumulated = existing ?? {
        accountCode: line.accountCode,
        accountName: line.accountName,
        category: line.category,
        base: ZERO,
        comparison: ZERO,
        inBase: false,
        inComparison: false,
      };
      // The comparison side names the account if the base did not, so a new
      // account introduced by a reforecast still reads properly.
      if (!existing) accounts.set(line.accountCode, entry);
      else if (side === 'base') {
        entry.accountName = line.accountName;
        entry.category = line.category;
      }

      if (side === 'base') {
        entry.base = entry.base.plus(d(line.amount));
        entry.inBase = true;
      } else {
        entry.comparison = entry.comparison.plus(d(line.amount));
        entry.inComparison = true;
      }
    }
  };

  absorb(base, 'base');
  absorb(comparison, 'comparison');

  const rows: VarianceRow[] = [];
  const unmatchedAccounts: string[] = [];

  for (const entry of accounts.values()) {
    if (!entry.inBase || !entry.inComparison) unmatchedAccounts.push(entry.accountCode);
    const variance = entry.comparison.minus(entry.base);
    rows.push({
      accountCode: entry.accountCode,
      accountName: entry.accountName,
      category: entry.category,
      base: money(entry.base).toFixed(2),
      comparison: money(entry.comparison).toFixed(2),
      variance: money(variance).toFixed(2),
      variancePercent: percentOf(variance, entry.base),
      designation: designate(variance, entry.base, options),
    });
  }

  rows.sort((a, b) => {
    const byCategory = CATEGORY_ORDER.indexOf(a.category) - CATEGORY_ORDER.indexOf(b.category);
    return byCategory !== 0 ? byCategory : a.accountCode.localeCompare(b.accountCode);
  });

  const groups: VarianceGroup[] = [];
  for (const category of CATEGORY_ORDER) {
    const inCategory = rows.filter((row) => row.category === category);
    if (inCategory.length === 0) continue;
    const groupBase = inCategory.reduce((total, row) => total.plus(d(row.base)), ZERO);
    const groupComparison = inCategory.reduce((total, row) => total.plus(d(row.comparison)), ZERO);
    const groupVariance = groupComparison.minus(groupBase);
    groups.push({
      category,
      rows: inCategory,
      base: money(groupBase).toFixed(2),
      comparison: money(groupComparison).toFixed(2),
      variance: money(groupVariance).toFixed(2),
      variancePercent: percentOf(groupVariance, groupBase),
      designation: designate(groupVariance, groupBase, options),
    });
  }

  const totalBase = rows.reduce((total, row) => total.plus(d(row.base)), ZERO);
  const totalComparison = rows.reduce((total, row) => total.plus(d(row.comparison)), ZERO);
  const totalVariance = totalComparison.minus(totalBase);
  const sorted = [...new Set(months)].sort();

  return {
    fromMonth: sorted[0] ?? null,
    toMonth: sorted[sorted.length - 1] ?? null,
    groups,
    rows,
    totalBase: money(totalBase).toFixed(2),
    totalComparison: money(totalComparison).toFixed(2),
    totalVariance: money(totalVariance).toFixed(2),
    totalVariancePercent: percentOf(totalVariance, totalBase),
    totalDesignation: designate(totalVariance, totalBase, options),
    unmatchedAccounts: unmatchedAccounts.sort(),
  };
}

/**
 * Turns an engine result's monthly cash flow into budget lines.
 *
 * This is what makes forecast-versus-budget possible without a second data
 * entry pass: the model already holds a month-by-month view of the same
 * accounts, in the same sign convention, so it can be compared directly.
 */
export interface ForecastLineSource {
  /** Monthly series keyed by cash-flow line, in engine order. */
  monthly: Record<string, string[]>;
  /** First-of-month ISO dates, parallel to the series. */
  monthStarts: string[];
}

const FORECAST_ACCOUNTS: Array<{
  line: string;
  code: string;
  name: string;
  category: AccountCategory;
}> = [
  { line: 'scheduledBaseRent', code: '4000', name: 'Base rent', category: 'revenue' },
  { line: 'percentageRent', code: '4100', name: 'Percentage rent', category: 'revenue' },
  { line: 'expenseRecoveries', code: '4200', name: 'Expense recoveries', category: 'revenue' },
  { line: 'otherLeaseRevenue', code: '4300', name: 'Other lease revenue', category: 'revenue' },
  {
    line: 'otherPropertyRevenue',
    code: '4400',
    name: 'Other property revenue',
    category: 'revenue',
  },
  { line: 'generalVacancy', code: '4900', name: 'General vacancy', category: 'revenue' },
  { line: 'creditLoss', code: '4910', name: 'Credit loss', category: 'revenue' },
  {
    line: 'operatingExpenses',
    code: '5000',
    name: 'Operating expenses',
    category: 'operating_expense',
  },
  { line: 'tenantImprovements', code: '6000', name: 'Tenant improvements', category: 'capital' },
  { line: 'leasingCommissions', code: '6100', name: 'Leasing commissions', category: 'capital' },
  { line: 'capitalExpenditures', code: '6200', name: 'Capital expenditures', category: 'capital' },
  { line: 'interestExpense', code: '7000', name: 'Interest expense', category: 'debt_service' },
  {
    line: 'principalAmortization',
    code: '7100',
    name: 'Principal amortization',
    category: 'debt_service',
  },
];

export function forecastToBudgetLines(source: ForecastLineSource): BudgetLine[] {
  const lines: BudgetLine[] = [];
  for (const account of FORECAST_ACCOUNTS) {
    const series = source.monthly[account.line];
    if (!series) continue;
    for (const [index, amount] of series.entries()) {
      const periodMonth = source.monthStarts[index];
      if (!periodMonth) continue;
      lines.push({
        accountCode: account.code,
        accountName: account.name,
        category: account.category,
        periodMonth,
        amount,
      });
    }
  }
  return lines;
}

import { describe, expect, it } from 'vitest';
import { type BudgetLine, computeVariance, forecastToBudgetLines } from './variance.js';

/**
 * Budget, actuals and variance.
 *
 * Every expected figure below is stated arithmetic on the fixture in the same
 * line, not something the code produced and was then written down.
 */

function line(
  accountCode: string,
  periodMonth: string,
  amount: string,
  category: BudgetLine['category'] = 'revenue',
  accountName = accountCode,
): BudgetLine {
  return { accountCode, accountName, category, periodMonth, amount };
}

describe('variance sign convention', () => {
  it('calls more revenue than budgeted favourable', () => {
    const report = computeVariance(
      [line('4000', '2026-01-01', '100000')],
      [line('4000', '2026-01-01', '120000')],
    );
    expect(report.rows[0]?.variance).toBe('20000.00');
    expect(report.rows[0]?.designation).toBe('favourable');
  });

  it('calls less revenue than budgeted unfavourable', () => {
    const report = computeVariance(
      [line('4000', '2026-01-01', '100000')],
      [line('4000', '2026-01-01', '80000')],
    );
    expect(report.rows[0]?.variance).toBe('-20000.00');
    expect(report.rows[0]?.designation).toBe('unfavourable');
  });

  it('calls overspending unfavourable, with no reference to the category', () => {
    // Expenses are held negative, so spending 60 against a 50 budget is
    // -60 - (-50) = -10. The sign alone decides it.
    const report = computeVariance(
      [line('5000', '2026-01-01', '-50000', 'operating_expense')],
      [line('5000', '2026-01-01', '-60000', 'operating_expense')],
    );
    expect(report.rows[0]?.variance).toBe('-10000.00');
    expect(report.rows[0]?.designation).toBe('unfavourable');
  });

  it('calls underspending favourable', () => {
    const report = computeVariance(
      [line('5000', '2026-01-01', '-50000', 'operating_expense')],
      [line('5000', '2026-01-01', '-40000', 'operating_expense')],
    );
    expect(report.rows[0]?.variance).toBe('10000.00');
    expect(report.rows[0]?.designation).toBe('favourable');
  });

  it('gives the same designation for a cost row whatever its category says', () => {
    // The point of the convention: a miscategorised row lands in the wrong
    // subtotal, which someone will notice, rather than reversing its own
    // variance, which nobody would.
    const mislabelled = computeVariance(
      [line('5000', '2026-01-01', '-50000', 'revenue')],
      [line('5000', '2026-01-01', '-60000', 'revenue')],
    );
    expect(mislabelled.rows[0]?.designation).toBe('unfavourable');
  });
});

describe('aggregation over months', () => {
  const budget: BudgetLine[] = [
    line('4000', '2026-01-01', '10000'),
    line('4000', '2026-02-01', '10000'),
    line('4000', '2026-03-01', '10000'),
    line('5000', '2026-01-01', '-4000', 'operating_expense'),
    line('5000', '2026-02-01', '-4000', 'operating_expense'),
    line('5000', '2026-03-01', '-4000', 'operating_expense'),
  ];
  const actual: BudgetLine[] = [
    line('4000', '2026-01-01', '9500'),
    line('4000', '2026-02-01', '10500'),
    line('4000', '2026-03-01', '11000'),
    line('5000', '2026-01-01', '-4500', 'operating_expense'),
    line('5000', '2026-02-01', '-3800', 'operating_expense'),
    line('5000', '2026-03-01', '-4100', 'operating_expense'),
  ];

  it('sums each account across the window', () => {
    const report = computeVariance(budget, actual);
    // Revenue: 30,000 budgeted against 31,000 actual = +1,000.
    const revenue = report.rows.find((row) => row.accountCode === '4000');
    expect(revenue?.base).toBe('30000.00');
    expect(revenue?.comparison).toBe('31000.00');
    expect(revenue?.variance).toBe('1000.00');
    // Expenses: -12,000 budgeted against -12,400 actual = -400.
    const expense = report.rows.find((row) => row.accountCode === '5000');
    expect(expense?.base).toBe('-12000.00');
    expect(expense?.comparison).toBe('-12400.00');
    expect(expense?.variance).toBe('-400.00');
  });

  it('totals to net operating income by simple addition', () => {
    // The whole point of one sign convention: the total is a sum, not a
    // category-aware subtraction. 30,000 - 12,000 = 18,000 budgeted;
    // 31,000 - 12,400 = 18,600 actual; +600 favourable.
    const report = computeVariance(budget, actual);
    expect(report.totalBase).toBe('18000.00');
    expect(report.totalComparison).toBe('18600.00');
    expect(report.totalVariance).toBe('600.00');
    expect(report.totalDesignation).toBe('favourable');
  });

  it('states the variance as a fraction of the absolute base', () => {
    const report = computeVariance(budget, actual);
    // 600 / 18,000 = 0.033333...
    expect(Number(report.totalVariancePercent)).toBeCloseTo(0.033333, 6);
    // -400 / |-12,000| = -0.033333. The percentage keeps the variance's sign
    // even though the base is negative, so "worse" always reads negative.
    const expense = report.rows.find((row) => row.accountCode === '5000');
    expect(Number(expense?.variancePercent)).toBeCloseTo(-0.033333, 6);
  });

  it('honours a month window', () => {
    const report = computeVariance(budget, actual, {
      fromMonth: '2026-02-01',
      toMonth: '2026-03-01',
    });
    // February and March only: 20,000 budgeted, 21,500 actual.
    const revenue = report.rows.find((row) => row.accountCode === '4000');
    expect(revenue?.base).toBe('20000.00');
    expect(revenue?.comparison).toBe('21500.00');
    expect(report.fromMonth).toBe('2026-02-01');
    expect(report.toMonth).toBe('2026-03-01');
  });

  it('groups and subtotals by category', () => {
    const report = computeVariance(budget, actual);
    const revenue = report.groups.find((group) => group.category === 'revenue');
    const expenses = report.groups.find((group) => group.category === 'operating_expense');
    expect(revenue?.variance).toBe('1000.00');
    expect(revenue?.designation).toBe('favourable');
    expect(expenses?.variance).toBe('-400.00');
    expect(expenses?.designation).toBe('unfavourable');
    // Revenue is always presented before costs.
    expect(report.groups[0]?.category).toBe('revenue');
  });
});

describe('materiality', () => {
  const budget = [line('4000', '2026-01-01', '100000')];

  it('reports an immaterial variance as neutral, not favourable', () => {
    const report = computeVariance(budget, [line('4000', '2026-01-01', '100300')], {
      materialityAmount: '500',
    });
    expect(report.rows[0]?.variance).toBe('300.00');
    expect(report.rows[0]?.designation).toBe('neutral');
  });

  it('requires a variance to clear both thresholds', () => {
    // 3,000 clears the 500 amount but is 3% against a 5% threshold.
    const report = computeVariance(budget, [line('4000', '2026-01-01', '103000')], {
      materialityAmount: '500',
      materialityPercent: '0.05',
    });
    expect(report.rows[0]?.designation).toBe('neutral');
  });

  it('designates a variance that clears both', () => {
    const report = computeVariance(budget, [line('4000', '2026-01-01', '110000')], {
      materialityAmount: '500',
      materialityPercent: '0.05',
    });
    expect(report.rows[0]?.designation).toBe('favourable');
  });

  it('treats an exactly zero variance as neutral without any threshold', () => {
    const report = computeVariance(budget, [line('4000', '2026-01-01', '100000')]);
    expect(report.rows[0]?.designation).toBe('neutral');
  });
});

describe('accounts present on one side only', () => {
  it('reports them rather than letting them pass as a full variance', () => {
    const report = computeVariance(
      [line('4000', '2026-01-01', '10000')],
      [line('4000', '2026-01-01', '10000'), line('4300', '2026-01-01', '250')],
    );
    // An account nobody budgeted is far more often a mapping mistake in the
    // import than a genuine new line, and it would otherwise appear as a 100%
    // favourable variance with nothing to compare against.
    expect(report.unmatchedAccounts).toEqual(['4300']);
    const introduced = report.rows.find((row) => row.accountCode === '4300');
    expect(introduced?.base).toBe('0.00');
    expect(introduced?.variance).toBe('250.00');
    // No percentage against a zero base: that is a new line, not an infinite
    // overspend.
    expect(introduced?.variancePercent).toBeNull();
  });

  it('names an account from whichever side introduced it', () => {
    const report = computeVariance(
      [],
      [line('4300', '2026-01-01', '250', 'revenue', 'Parking income')],
    );
    expect(report.rows[0]?.accountName).toBe('Parking income');
  });
});

describe('forecast as a comparison side', () => {
  it('maps a monthly cash flow onto the same account codes', () => {
    const lines = forecastToBudgetLines({
      monthly: {
        scheduledBaseRent: ['10000', '10000'],
        operatingExpenses: ['-4000', '-4000'],
        // A line the mapping does not cover is left out rather than guessed at.
        leveredCashFlow: ['6000', '6000'],
      },
      monthStarts: ['2026-01-01', '2026-02-01'],
    });

    expect(lines).toHaveLength(4);
    expect(lines.filter((entry) => entry.accountCode === '4000')).toHaveLength(2);
    expect(lines.find((entry) => entry.accountCode === '5000')?.category).toBe('operating_expense');
    expect(lines.some((entry) => entry.accountName === 'Levered cash flow')).toBe(false);
  });

  it('compares a forecast against a budget without a second data entry pass', () => {
    const forecast = forecastToBudgetLines({
      monthly: { scheduledBaseRent: ['10000', '10000'], operatingExpenses: ['-4000', '-4000'] },
      monthStarts: ['2026-01-01', '2026-02-01'],
    });
    const budget: BudgetLine[] = [
      line('4000', '2026-01-01', '9000'),
      line('4000', '2026-02-01', '9000'),
      line('5000', '2026-01-01', '-4000', 'operating_expense'),
      line('5000', '2026-02-01', '-4000', 'operating_expense'),
    ];

    const report = computeVariance(budget, forecast);
    // The forecast expects 20,000 of rent against 18,000 budgeted.
    expect(report.rows.find((row) => row.accountCode === '4000')?.variance).toBe('2000.00');
    expect(report.rows.find((row) => row.accountCode === '5000')?.variance).toBe('0.00');
    expect(report.totalVariance).toBe('2000.00');
    expect(report.unmatchedAccounts).toEqual([]);
  });
});

import { describe, expect, it } from 'vitest';
import { compareInputs, compareResults, compareVersions } from './compare.js';
import { calculate } from './engine.js';
import { baseYearRecovery, singleTenantIndustrial } from './__fixtures__/properties.js';

/**
 * Version comparison.
 *
 * Every expected value is derived from the fixture assumptions by hand. Where a
 * figure comes from the engine, the test states the arithmetic that produces it
 * and asserts the difference, not the level — a comparison that agreed with
 * whatever the engine returned would prove nothing about the comparison.
 */

const FIXED_CLOCK = '2026-01-01T00:00:00.000Z';
const run = (input: Parameters<typeof calculate>[0]) =>
  calculate(input, { calculatedAt: FIXED_CLOCK, trace: { enabled: false } });

function withDiscountRate(rate: string) {
  const input = singleTenantIndustrial();
  return { ...input, valuation: { ...input.valuation, discountRate: rate } };
}

describe('what changed in the inputs', () => {
  it('reports a rate change in the units it was made in', () => {
    const changes = compareInputs(withDiscountRate('0.08'), withDiscountRate('0.085'));
    const model = changes.find((entry) => entry.code === 'model');
    const rate = model?.fields.find((field) => field.path === 'valuation.discountRate');

    expect(rate?.unit).toBe('rate');
    expect(rate?.before).toBe('0.08');
    expect(rate?.after).toBe('0.085');
    // Fifty basis points. A reader should not have to subtract two decimals.
    expect(Number(rate?.delta)).toBeCloseTo(0.005, 12);
  });

  it('reports nothing at all when nothing moved', () => {
    // The common case, and the one that has to be silent. A comparison that
    // always finds something teaches people to ignore it.
    expect(compareInputs(singleTenantIndustrial(), singleTenantIndustrial())).toEqual([]);
  });

  it('reports a lease that was added, and one that was removed', () => {
    const before = singleTenantIndustrial();
    const after = {
      ...before,
      leases: [{ ...(before.leases[0] as Record<string, unknown>), id: 'L2' } as never],
    };

    const changes = compareInputs(before, after);
    const added = changes.filter((entry) => entry.kind === 'added');
    const removed = changes.filter((entry) => entry.kind === 'removed');

    expect(added.map((entry) => entry.code)).toEqual(['L2']);
    expect(removed.map((entry) => entry.code)).toEqual(['L1']);
    // An addition is the whole entity, so there are no field-level rows to read.
    expect(added[0]?.fields).toEqual([]);
  });

  it('does not guess that a removal and an addition are a rename', () => {
    // Nothing in a frozen input records that one lease became another. Pairing
    // them on similarity would silently equate two unrelated tenancies, and the
    // reader would never see the removal.
    const before = singleTenantIndustrial();
    const after = {
      ...before,
      leases: [{ ...(before.leases[0] as Record<string, unknown>), id: 'L1-RENEWED' } as never],
    };
    const changes = compareInputs(before, after);
    expect(changes.map((entry) => entry.kind).sort()).toEqual(['added', 'removed']);
    expect(changes.some((entry) => entry.kind === 'changed')).toBe(false);
  });

  it('reports a rent change on a lease that stayed', () => {
    const before = singleTenantIndustrial();
    const first = before.leases[0] as never as Record<string, unknown>;
    const after = {
      ...before,
      leases: [{ ...first, baseRent: '7.50' } as never],
    };

    const changes = compareInputs(before, after);
    expect(changes).toHaveLength(1);
    expect(changes[0]?.kind).toBe('changed');
    const rent = changes[0]?.fields.find((field) => field.path.endsWith('.baseRent'));
    expect(rent?.before).toBe('6.00');
    expect(rent?.after).toBe('7.50');
    expect(Number(rent?.delta)).toBeCloseTo(1.5, 12);
    expect(rent?.unit).toBe('currency');
  });

  it('groups by entity, and within each puts additions before changes before removals', () => {
    // Grouping by entity rather than sorting globally keeps every lease change
    // together, which is how the list is actually read. A diff whose order
    // shifts between runs cannot be compared side by side at all.
    const before = baseYearRecovery();
    const firstExpense = before.expenses[0] as never as Record<string, unknown>;
    const after = {
      ...before,
      leases: [],
      expenses: [
        { ...firstExpense, amount: '600000' } as never,
        { ...firstExpense, id: 'E2', amount: '10000' } as never,
      ],
    };

    const changes = compareInputs(before, after);
    const leases = changes.filter((entry) => entry.entity === 'lease');
    const expenses = changes.filter((entry) => entry.entity === 'expense');

    expect(leases.map((entry) => entry.kind)).toEqual(['removed']);
    expect(expenses.map((entry) => entry.kind)).toEqual(['added', 'changed']);

    // Entities stay grouped: every lease row precedes every expense row.
    const firstExpenseIndex = changes.findIndex((entry) => entry.entity === 'expense');
    const lastLeaseIndex = changes.map((entry) => entry.entity).lastIndexOf('lease');
    expect(lastLeaseIndex).toBeLessThan(firstExpenseIndex);
  });
});

describe('what the change did', () => {
  it('reports the movement in each year, not the level', () => {
    /*
     * The base-year fixture runs an expense of 500,000 growing 10% a year, with
     * the sole tenant on a 2026 base year. Doubling the expense to 1,000,000
     * doubles the base year with it, so the recovery does not keep pace:
     *
     *   before  FY2027  expense 550,000, recovery  550,000 -   500,000 =  50,000
     *   after   FY2027  expense 1,100,000, recovery 1,100,000 - 1,000,000 = 100,000
     *
     *   expense line moves by -550,000 (expenses are negative in the cash flow)
     *   recovery moves by      +50,000
     *   NOI therefore moves by -500,000
     *
     * A base year holds NOI flat against *growth* in an expense, which is what
     * fixture 7 asserts. It does not hold NOI flat against a larger expense in
     * the base year itself, because the stop rises too.
     */
    const before = baseYearRecovery();
    const firstExpense = before.expenses[0] as never as Record<string, unknown>;
    const after = { ...before, expenses: [{ ...firstExpense, amount: '1000000' } as never] };

    const deltas = compareResults(run(before), run(after));
    const year2027 = deltas.find((entry) => entry.fiscalYear === 2027);
    const expenses = year2027?.lines.find((line) => line.line === 'operatingExpenses');
    expect(Number(expenses?.delta)).toBeCloseTo(-550000, 4);

    const recoveries = year2027?.lines.find((line) => line.line === 'expenseRecoveries');
    expect(Number(recoveries?.delta)).toBeCloseTo(50000, 4);

    const noi = year2027?.lines.find((line) => line.line === 'netOperatingIncome');
    expect(Number(noi?.delta)).toBeCloseTo(-500000, 4);
  });

  it('reports no movement at all when the input is identical', () => {
    const deltas = compareResults(run(singleTenantIndustrial()), run(singleTenantIndustrial()));
    for (const year of deltas) {
      for (const line of year.lines) {
        expect(Number(line.delta), `${year.fiscalYear} ${line.line}`).toBeCloseTo(0, 10);
      }
    }
  });

  it('measures the percentage against the magnitude, so a cost that grew reads as growth', () => {
    // Operating expenses are negative. Comparing -1,100,000 against -550,000
    // must read as a 100% increase, not a -100% one.
    const before = baseYearRecovery();
    const firstExpense = before.expenses[0] as never as Record<string, unknown>;
    const after = { ...before, expenses: [{ ...firstExpense, amount: '1000000' } as never] };

    const deltas = compareResults(run(before), run(after));
    const expenses = deltas
      .find((entry) => entry.fiscalYear === 2027)
      ?.lines.find((line) => line.line === 'operatingExpenses');
    expect(Number(expenses?.percentChange)).toBeCloseTo(1, 6);
    expect(Number(expenses?.before)).toBeLessThan(0);
  });

  it('compares a year present in only one version against zero', () => {
    // Shortening a forecast removes years. Reporting them as absent would hide
    // that the later cash flow was dropped; comparing against zero says so.
    const before = singleTenantIndustrial();
    const after = { ...before, forecast: { ...before.forecast, months: 36 } };

    const deltas = compareResults(run(before), run(after));
    const year2030 = deltas.find((entry) => entry.fiscalYear === 2030);
    const noi = year2030?.lines.find((line) => line.line === 'netOperatingIncome');
    expect(Number(noi?.after)).toBe(0);
    expect(Number(noi?.before)).toBeGreaterThan(0);
    expect(Number(noi?.delta)).toBeCloseTo(-Number(noi?.before), 6);
  });
});

describe('the whole comparison', () => {
  it('answers both halves: what was edited and what it did', () => {
    const before = { input: withDiscountRate('0.08'), result: run(withDiscountRate('0.08')) };
    const after = { input: withDiscountRate('0.10'), result: run(withDiscountRate('0.10')) };
    const comparison = compareVersions(before, after);

    // The edit.
    expect(comparison.inputChanges).toHaveLength(1);
    expect(Number(comparison.inputChanges[0]?.fields[0]?.delta)).toBeCloseTo(0.02, 12);

    // And its effect: a higher discount rate is a lower present value, always.
    expect(Number(comparison.headline.value?.delta)).toBeLessThan(0);

    // The cash flow itself did not move — only what it is worth today.
    const noi = comparison.headline.netOperatingIncomeYear1;
    expect(Number(noi?.delta)).toBeCloseTo(0, 6);
  });

  it('flags a comparison across two engine versions', () => {
    // Two versions calculated by different engines can differ for reasons
    // nobody edited. A reader has to know that before attributing a movement to
    // an assumption.
    const result = run(singleTenantIndustrial());
    const comparison = compareVersions(
      { input: singleTenantIndustrial(), result: { ...result, engineVersion: '2.1.0' } },
      { input: singleTenantIndustrial(), result },
    );
    expect(comparison.engineChanged).toBe(true);
    expect(comparison.engineBefore).toBe('2.1.0');
    expect(comparison.engineAfter).toBe(result.engineVersion);
  });

  it('does not flag an engine change when there is none', () => {
    const comparison = compareVersions(
      { input: singleTenantIndustrial(), result: run(singleTenantIndustrial()) },
      { input: singleTenantIndustrial(), result: run(singleTenantIndustrial()) },
    );
    expect(comparison.engineChanged).toBe(false);
  });
});

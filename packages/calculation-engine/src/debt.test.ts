import { describe, expect, it } from 'vitest';
import { calculate } from './engine.js';
import { baseModel, extendModel } from './__fixtures__/builders.js';

/**
 * A facility funded before the forecast start.
 *
 * Found by a repository-wide correctness audit: `computeDebt`'s period loop
 * only ever reads `draws.get(i)` for `i` in `[0, n)`. A facility whose funding
 * date predates the forecast start produces a negative `fundingIndex`, so its
 * draw is stored at a key the loop never reads — the facility silently ran at
 * a zero balance for its whole term (no interest, no principal, no fees) with
 * nothing in the diagnostics to say why. See `docs/commercial-gap-analysis.md`
 * for how this was found.
 */
describe('a facility funded before the forecast start', () => {
  it('is refused with a diagnostic rather than silently computed at a zero balance', () => {
    const model = extendModel(baseModel(), {
      debt: [
        {
          id: 'D-PRE',
          name: 'Existing first mortgage',
          type: 'permanent',
          commitment: '5000000',
          initialFunding: '5000000',
          // The forecast (from baseModel) starts 2026-01-01; this facility
          // funded a year before it — an existing loan, not modelled here.
          fundingDate: '2025-01-01',
          rateType: 'fixed',
          fixedRate: '0.06',
          interestOnlyMonths: 0,
          amortizationMonths: 360,
          termMonths: 120,
        },
      ],
    });

    const result = calculate(model);

    const diagnostic = result.diagnostics.find(
      (entry) => entry.code === 'DEBT_FUNDED_BEFORE_FORECAST',
    );
    expect(diagnostic).toBeDefined();
    expect(diagnostic?.severity).toBe('error');

    // Refused outright, not included at a wrong (zero) balance: the facility
    // does not appear in the schedules the engine actually produced.
    expect(result.debtSchedules).toHaveLength(0);
    expect(result.annual.every((year) => year.lines.interestExpense === '0.00')).toBe(true);
  });

  it('does not affect a second, ordinarily funded facility in the same model', () => {
    const model = extendModel(baseModel(), {
      debt: [
        {
          id: 'D-PRE',
          name: 'Existing first mortgage',
          type: 'permanent',
          commitment: '5000000',
          initialFunding: '5000000',
          fundingDate: '2025-01-01',
          rateType: 'fixed',
          fixedRate: '0.06',
          interestOnlyMonths: 0,
          amortizationMonths: 360,
          termMonths: 120,
        },
        {
          id: 'D-NEW',
          name: 'New mezzanine',
          type: 'mezzanine',
          commitment: '1000000',
          initialFunding: '1000000',
          fundingDate: '2026-01-01',
          rateType: 'fixed',
          fixedRate: '0.10',
          interestOnlyMonths: 12,
          amortizationMonths: 0,
          termMonths: 12,
        },
      ],
    });

    const result = calculate(model);

    expect(result.diagnostics.some((entry) => entry.code === 'DEBT_FUNDED_BEFORE_FORECAST')).toBe(
      true,
    );
    expect(result.debtSchedules).toHaveLength(1);
    expect(result.debtSchedules[0]?.facilityId).toBe('D-NEW');

    // $1,000,000 at 10% fixed, interest-only: $8,333.33/month, recorded as a
    // cost (negative) on the cash-flow line.
    expect(result.monthly.interestExpense?.[0]).toBe('-8333.33');
  });
});

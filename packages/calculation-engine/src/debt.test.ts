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

/**
 * A staged draw dated outside the forecast.
 *
 * Found by a fifth audit pass, the same mechanism as the fix above applied to
 * a different field on the same facility: `computeDebt`'s period loop only
 * ever reads `draws.get(i)` for `i` in `[0, n)`, and `DEBT_FUNDED_BEFORE_FORECAST`
 * checks `fundingDate` for exactly that reason — but the facility's own
 * `draws[]` array, populated into the same map two lines later, had no
 * equivalent check. A draw dated before the forecast starts (or after it
 * ends) silently vanished: not applied to the balance, not counted toward
 * interest or principal, and nothing in the diagnostics to say why.
 */
describe('a staged draw dated outside the forecast', () => {
  it('is excluded from the balance with a diagnostic, without disqualifying the rest of the facility', () => {
    const model = extendModel(baseModel(), {
      debt: [
        {
          id: 'D-STAGED',
          name: 'Construction loan',
          type: 'construction',
          commitment: '5000000',
          initialFunding: '0',
          // Closes 2026-01-01 (the forecast's first month) with nothing drawn
          // yet, which is the ordinary shape of a staged-draw facility.
          fundingDate: '2026-01-01',
          draws: [
            // Dated before the forecast starts: an ordinary data-entry
            // mistake (or a draw schedule copied from a term sheet dated
            // before the model's own start), not a contrived state.
            { date: '2025-06-01', amount: '1000000' },
            { date: '2026-03-01', amount: '2000000' },
          ],
          rateType: 'fixed',
          fixedRate: '0.06',
          interestOnlyMonths: 999,
          amortizationMonths: 0,
          termMonths: 24,
        },
      ],
    });

    const result = calculate(model);

    const diagnostic = result.diagnostics.find(
      (entry) => entry.code === 'DEBT_DRAW_OUTSIDE_FORECAST',
    );
    expect(diagnostic?.severity).toBe('error');
    expect(diagnostic?.message).toContain('2025-06-01');

    // Hand-derived: only the in-range $2,000,000 draw (month index 2, March)
    // ever reaches the balance. If the out-of-range $1,000,000 leaked in
    // (the bug), the ending balance would read $3,000,000 instead.
    const rows = result.debtSchedules[0]?.rows ?? [];
    expect(rows[1]?.endingBalance).toBe('0');
    expect(rows[2]?.endingBalance).toBe('2000000');
    expect(rows[11]?.endingBalance).toBe('2000000');
  });
});

/**
 * An origination fee on a facility whose first draw is dated after closing.
 *
 * Found by the same audit pass: the fee was charged only when `i ===
 * fundingIndex` *and* a draw greater than zero landed in that same period —
 * conflating "a draw happened this period" with "this is the closing
 * period," which `unusedFeePercent` a few lines below does not do (it
 * accrues on the undrawn commitment for every `active` period from
 * `fundingIndex` onward, regardless of draw timing). A staged-draw facility
 * ordinarily closes with `initialFunding: 0` and draws only once work
 * begins — the common, not contrived, shape of a construction loan — so the
 * fee silently never charged for the life of any such facility.
 */
describe('an origination fee on a facility whose first draw is dated after closing', () => {
  it('is charged at closing, not lost because no draw landed in the closing month', () => {
    const model = extendModel(baseModel(), {
      debt: [
        {
          id: 'D-DELAYED',
          name: 'Construction loan',
          type: 'construction',
          commitment: '5000000',
          initialFunding: '0',
          fundingDate: '2026-01-01',
          draws: [{ date: '2026-03-01', amount: '2000000' }],
          rateType: 'fixed',
          fixedRate: '0.06',
          interestOnlyMonths: 999,
          amortizationMonths: 0,
          termMonths: 24,
          originationFeePercent: '0.01',
        },
      ],
    });

    const result = calculate(model);
    const rows = result.debtSchedules[0]?.rows ?? [];

    // 1% of the full $5,000,000 commitment, charged once, in the closing
    // month (index 0) — not the draw month (index 2), and not lost.
    expect(rows[0]?.fees).toBe('50000');
    expect(rows[2]?.fees).toBe('0');
    const totalFees = rows.reduce((acc, row) => acc + Number(row.fees), 0);
    expect(totalFees).toBeCloseTo(50_000, 2);
  });
});

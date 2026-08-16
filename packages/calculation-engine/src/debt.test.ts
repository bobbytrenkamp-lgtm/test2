import { describe, expect, it } from 'vitest';
import { calculate } from './engine.js';
import { baseModel, buildModel, extendModel } from './__fixtures__/builders.js';

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

/**
 * A floating-rate facility's DSCR covenant, tested across a rate step.
 *
 * Found by a ninth audit pass: `annualDebtService` was one period's cash
 * interest plus principal, multiplied by twelve — extrapolating a single
 * month rather than summing the trailing twelve months actually paid, unlike
 * `annualNoi` a line above it, which correctly sums `trailingAnnualNoi`. For
 * a facility whose debt service is level month to month (every prior
 * covenant fixture: fixed-rate, or interest-only, or steady-state
 * amortizing) the two are identical and the bug is invisible. A floating
 * rate is not level — `periodRate` re-reads the index curve once per
 * forecast year, so the rate steps at every twelve-month anniversary — which
 * is the ordinary shape of a floating facility, not a contrived one.
 */
describe("a floating-rate facility's DSCR covenant across a rate step", () => {
  it('tests against the trailing twelve months of debt service actually paid, not one month annualised', () => {
    // 24-month forecast. A single lease at a flat $500,000/year ('annual_amount'
    // basis, no escalation, no vacancy, no expenses) gives an exact, known NOI
    // of $41,666.6667/month with nothing else to hand-derive around.
    //
    // A $10,000,000 interest-only floating facility, index curve at 3% in
    // forecast year 1 and 7% in forecast year 2 (an ordinary upward-sloping
    // short curve, spread 0). Interest is flat $25,000.00/month through the
    // first 12 months and flat $58,333.33/month from month 13 on.
    //
    // At period 13 (index 12, the first month of forecast year 2), the
    // buggy formula reads *that month's* interest alone: 58,333.33 x 12 =
    // $700,000.00, against $500,000 of trailing NOI -> DSCR 0.71x, breaching
    // a 1.0x covenant that was never actually in trouble. The true trailing
    // twelve months (11 x $25,000.00 + 1 x $58,333.33 = $333,333.33) gives
    // DSCR 500,000 / 333,333.33 = 1.50x -- comfortably clear.
    const model = buildModel({
      modelId: 'fx-floating-dscr-trailing',
      modelName: 'Floating DSCR trailing window (fixture)',
      forecast: {
        startDate: '2026-01-01',
        months: 24,
        fiscalYearStartMonth: 1,
        proration: 'actual_days',
      },
      property: { id: 'P1', name: 'Fixture', propertyType: 'office', rentableArea: '50000' },
      spaces: [{ id: 'S1', code: 'Whole building', area: '50000' }],
      tenants: [{ id: 'T1', name: 'Sole tenant' }],
      leases: [
        {
          id: 'L1',
          tenantId: 'T1',
          spaceIds: ['S1'],
          status: 'occupied',
          area: '50000',
          commencementDate: '2026-01-01',
          expirationDate: '2035-12-31',
          baseRent: '500000',
          baseRentBasis: 'annual_amount',
          excludeFromRollover: true,
        },
      ],
      growthCurves: [
        {
          id: 'SOFR',
          name: 'SOFR forward',
          defaultRate: '0.03',
          byYear: [{ year: 2, rate: '0.07' }],
        },
      ],
      debt: [
        {
          id: 'D1',
          name: 'Floating facility',
          type: 'bridge',
          commitment: '10000000',
          initialFunding: '10000000',
          fundingDate: '2026-01-01',
          rateType: 'floating',
          indexCurveId: 'SOFR',
          spread: '0',
          interestOnlyMonths: 999,
          amortizationMonths: 0,
          termMonths: 24,
          minimumDscr: '1.0',
          repayOnSale: false,
        },
      ],
      valuation: {
        discountRate: '0.08',
        saleCostPercent: '0',
        directCapAdjustments: '0',
        acquisitionCosts: '0',
        acquisitionPrice: '10000000',
        saleMonth: 24,
      },
    });

    const result = calculate(model);
    const rows = result.debtSchedules[0]?.rows ?? [];
    const breaches = result.debtSchedules[0]?.covenantBreaches ?? [];

    // The rate step itself, confirmed independently before trusting the DSCR
    // built from it: flat 25,000.00 through month 12, flat 58,333.33 from
    // month 13.
    expect(rows[11]?.cashInterest).toBe('25000');
    expect(rows[12]?.cashInterest).toBe('58333.33333333333333333333333333333');

    // The trailing DSCR at the rate step: 1.50x, not the 0.71x a single
    // month's interest annualised would read.
    expect(Number(rows[12]?.dscr)).toBeCloseTo(1.5, 2);

    // No breach at period 13 — the month the bug fired one immediately.
    expect(breaches.some((b) => b.periodIndex === 13)).toBe(false);

    // A genuine breach still occurs once a full trailing year sits entirely
    // at the higher rate: by period 24, trailing debt service is a full
    // $700,000.00 (12 x 58,333.33), and 500,000 / 700,000 = 0.71x truly
    // breaches. The covenant is not disabled by the fix, only measured
    // honestly.
    expect(Number(rows[23]?.dscr)).toBeCloseTo(0.7143, 3);
    expect(breaches.some((b) => b.periodIndex === 24)).toBe(true);
  });
});

/**
 * A facility that both capitalizes interest and amortizes.
 *
 * Found by a repository-wide correctness audit: once `pastInterestOnly`, the
 * loop capitalized that period's interest onto `balance` *and*, in the same
 * period, computed a level payment against that just-inflated balance, then
 * subtracted the never-paid `accrued` interest back out as "principal" — a
 * figure that corresponds to no real amortization schedule, since nothing
 * was actually paid in cash to justify calling any of it principal
 * repayment. A construction-to-permanent facility (capitalize through
 * lease-up, then amortize in cash once stabilised) is the ordinary shape
 * this combination models, not a contrived one.
 */
describe('a facility that capitalizes interest through a window, then amortizes', () => {
  it('fully retires on schedule once amortization begins, capitalizing nothing further', () => {
    // $1,000,000 at a flat 12% fixed rate (1%/month) makes every figure hand
    // -derivable. Capitalizes for month 1 only, then a 2-month level-payment
    // amortization: a level payment recomputed each period against the
    // current balance and remaining term is a textbook annuity that retires
    // to exactly zero at the end of its own schedule, provided (and only
    // provided) every period after capitalization stops is serviced in cash
    // rather than having its unpaid interest folded back into the balance
    // being amortized.
    const model = extendModel(baseModel(), {
      forecast: {
        startDate: '2026-01-01',
        months: 6,
        fiscalYearStartMonth: 1,
        proration: 'actual_days',
      },
      debt: [
        {
          id: 'D-CAPAM',
          name: 'Construction-to-permanent facility',
          type: 'construction',
          commitment: '1000000',
          initialFunding: '1000000',
          fundingDate: '2026-01-01',
          rateType: 'fixed',
          fixedRate: '0.12',
          interestOnlyMonths: 1,
          amortizationMonths: 2,
          termMonths: 6,
          capitalizeInterest: true,
        },
      ],
    });

    const result = calculate(model);
    const rows = result.debtSchedules[0]?.rows ?? [];

    // Month 1 (index 0): capitalizes, as before the fix. $1,000,000 x 1% =
    // $10,000 added to balance, nothing paid in cash.
    expect(rows[0]?.capitalizedInterest).toBe('10000');
    expect(rows[0]?.cashInterest).toBe('0');
    expect(rows[0]?.endingBalance).toBe('1010000');

    // Month 2 (index 1): amortization begins. The fix stops capitalizing
    // here — every dollar of interest from this period on is cash-serviced,
    // not folded back into the balance being amortized.
    expect(rows[1]?.capitalizedInterest).toBe('0');
    expect(Number(rows[1]?.cashInterest)).toBeGreaterThan(0);
    expect(Number(rows[1]?.principal)).toBeGreaterThan(0);

    // Month 3 (index 2): the second and last scheduled amortization period.
    // The bug never reached zero here — capitalization kept inflating the
    // balance every period, including this one, so the two-period schedule
    // could not and did not retire the loan on time.
    expect(rows[2]?.capitalizedInterest).toBe('0');
    expect(rows[2]?.endingBalance).toBe('0');

    // Nothing left to service once retired.
    expect(rows[3]?.cashInterest).toBe('0');
    expect(rows[3]?.principal).toBe('0');
  });
});

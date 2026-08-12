import { describe, expect, it } from 'vitest';
import { calculate } from './engine.js';
import { baseModel, extendModel } from './__fixtures__/builders.js';

/**
 * Two defects in `applyCashTrap`, found by a repository-wide correctness
 * audit's second round (boundary and extreme-value cases):
 *
 * 1. A facility's own funding-period draw was treated as trappable
 *    "surplus" — a covenant that happens to breach in the funding month
 *    (an annualised one-month NOI stub tripping a DSCR threshold a full
 *    year would clear is an ordinary way for that to happen) could sweep
 *    the entire loan proceeds meant to fund the acquisition, over-calling
 *    equity by that amount.
 * 2. Cash still held when the covenant had not cured was released only at
 *    the literal last index of the stated forecast array — not when the
 *    facility was actually repaid at sale. Combined with the sale-
 *    truncation fix in engine.ts (equity cash flow reported as zero for
 *    periods after the sale), a trap still open at the sale date lost the
 *    held cash outright whenever the forecast ran even one month past the
 *    sale, which `terminalNoiBasis: 'forward_12'` deliberately does.
 */
describe('a cash trap open through the sale date', () => {
  // A single LP owning the whole residual, so what the LP receives is
  // exactly the equity cash flow the trap fix is responsible for.
  const singleLpEquity = {
    partners: [{ id: 'LP', name: 'Sole LP', role: 'lp' as const, contributionShare: '1' }],
    tiers: [
      {
        id: 'RESIDUAL',
        name: 'Residual',
        type: 'residual_split' as const,
        splits: [{ partnerId: 'LP', share: '1' }],
      },
    ],
  };

  // 12-month forecast, sale at month 6 (so 6 months remain after it — the
  // forward_12 terminal basis needs them). Flat $10,000/month other revenue,
  // no leases or expenses, so NOI is unambiguous. A $500,000 facility at 6%
  // fixed, interest-only, with `minimumDscr: '50'` — an annualised monthly
  // DSCR of 4.0x this fixture actually produces never gets close to, so the
  // covenant breaches every period from funding through the sale and never
  // cures (`cureConsecutivePeriods: 24` puts the cure permanently out of
  // reach within a 12-month forecast).
  const model = extendModel(baseModel(), {
    forecast: {
      startDate: '2026-01-01',
      months: 12,
      fiscalYearStartMonth: 1,
      proration: 'actual_days',
    },
    otherRevenue: [
      {
        id: 'OTHER',
        name: 'Flat other revenue',
        method: 'custom_monthly_schedule',
        monthlySchedule: Array.from({ length: 12 }, () => '10000'),
      },
    ],
    valuation: {
      discountRate: '0.08',
      saleCostPercent: '0',
      directCapAdjustments: '0',
      acquisitionCosts: '0',
      acquisitionPrice: '1000000',
      saleMonth: 6,
      grossSalePriceOverride: '1000000',
    },
    debt: [
      {
        id: 'D1',
        name: 'Senior loan',
        type: 'permanent',
        commitment: '500000',
        initialFunding: '500000',
        fundingDate: '2026-01-01',
        rateType: 'fixed' as const,
        fixedRate: '0.06',
        interestOnlyMonths: 999,
        amortizationMonths: 0,
        termMonths: 24,
        minimumDscr: '50',
        repayOnSale: true,
        cashTrap: { enabled: true, trigger: 'minimum_dscr' as const, cureConsecutivePeriods: 24 },
      },
    ],
    equity: singleLpEquity,
  });

  const result = calculate(model);
  const lp = result.waterfall.find((partner) => partner.partnerId === 'LP');

  it('does not trap the funding-period loan draw as if it were operating surplus', () => {
    // $500,000 draws in month 1 alongside $10,000 of real operating income
    // and $2,500 of interest (500,000 x 6%/12). The true surplus available
    // to trap is 10,000 - 2,500 = 7,500 — not the 507,500 the bug would have
    // read from a levered cash flow that still includes the loan proceeds.
    expect(result.monthly.restrictedCash[0]).toBe('-7500.00');
  });

  it('releases everything held once the facility is repaid at sale, not lost to the truncated periods after it', () => {
    // Hand-derived, independent of the engine: 5 months (1-5) of $7,500
    // trapped operating surplus, plus month 6's own operating income
    // ($10,000 - $2,500 interest), plus the $1,000,000 sale price (0%
    // selling cost), less the $500,000 loan payoff at sale.
    // = 5*7,500 + 7,500 + 1,000,000 - 500,000 = 545,000.
    const expectedDistributions = 5 * 7_500 + 7_500 + 1_000_000 - 500_000;
    expect(Number(lp?.distributions)).toBeCloseTo(expectedDistributions, 2);
    expect(Number(lp?.contributions)).toBeCloseTo(1_000_000 - 500_000, 2);

    // The release event is dated to the sale month, not month 12 — the
    // literal end of the stated 12-month forecast, which is what a forward
    // reversion basis needs even though equity's own involvement in the
    // deal ended six months earlier.
    const released = result.diagnostics
      .concat()
      .find((entry) => entry.code === 'CASH_TRAP_RELEASED');
    expect(released?.message).toContain('repaid at sale');

    // Nothing remains trapped, and nothing is released a second time, in
    // any period after the sale.
    for (let i = 6; i < 12; i += 1) {
      expect(result.monthly.restrictedCash[i]).toBe('0.00');
    }
  });
});

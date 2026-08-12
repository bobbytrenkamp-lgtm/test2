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

/**
 * A cash trap sprung by one facility, alongside a second, unrelated
 * facility that is also cash-trap-enabled but never itself breaches.
 *
 * Found by a sixth audit pass (multi-entity interaction): the release
 * threshold (`cureAfter`) was computed once, as the *maximum*
 * `cureConsecutivePeriods` across every cash-trap-enabled facility —
 * regardless of whether that facility ever actually breached a covenant.
 * A facility that is enabled for cash trapping but never breaches has no
 * claim on cash a *different* facility's breach trapped, so inflating the
 * release threshold to match its (unrelated, unexercised) cure requirement
 * held the cash hostage for no reason the diagnostics explained.
 */
describe('a cash trap sprung by one facility while a second, unrelated facility never breaches', () => {
  // 12-month forecast. $1,000 other revenue in January, $10,000 every month
  // after. January's DSCR is based purely on January's own annualised NOI
  // (the trailing window has nothing else to average yet: $1,000 x 12 =
  // $12,000), which a 3.0x covenant against $6,000 of annual debt service
  // fails outright (2.0x). February's DSCR averages January and February
  // ($1,000 + $10,000 = $11,000 over 2 months, x 12 = $66,000, an 11.0x
  // multiple) and clears the covenant comfortably — a clean, one-month
  // breach-then-cure with a genuine (if small) operating surplus in the
  // breach month itself to trap.
  //
  // directCapRate is used instead of a DCF sale so the property's concluded
  // value is hand-derivable: $1,000 + 11 x $10,000 = $111,000 year-1 NOI /
  // 5% = $2,220,000.
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
        name: 'Flat other revenue, reduced in January',
        method: 'custom_monthly_schedule',
        monthlySchedule: ['1000', ...Array.from({ length: 11 }, () => '10000')],
      },
    ],
    valuation: {
      discountRate: '0.08',
      saleCostPercent: '0',
      directCapAdjustments: '0',
      acquisitionCosts: '0',
      directCapRate: '0.05',
      directCapNoiBasis: 'year_1',
    },
    debt: [
      {
        id: 'D-BREACHES',
        name: 'Senior loan (breaches once)',
        type: 'permanent',
        commitment: '100000',
        initialFunding: '100000',
        fundingDate: '2026-01-01',
        rateType: 'fixed' as const,
        fixedRate: '0.06',
        interestOnlyMonths: 999,
        amortizationMonths: 0,
        termMonths: 24,
        minimumDscr: '3.0',
        cashTrap: { enabled: true, trigger: 'any_covenant' as const, cureConsecutivePeriods: 1 },
      },
      {
        id: 'D-NEVER-BREACHES',
        name: 'Mezzanine (never breaches)',
        type: 'mezzanine',
        commitment: '50000',
        initialFunding: '50000',
        fundingDate: '2026-01-01',
        rateType: 'fixed' as const,
        fixedRate: '0.08',
        interestOnlyMonths: 999,
        amortizationMonths: 0,
        termMonths: 24,
        // $50,000 against a $2,220,000 property is a ~2.3% LTV — nowhere
        // near this 99% ceiling, so this facility never once breaches.
        maximumLtv: '0.99',
        cashTrap: { enabled: true, trigger: 'any_covenant' as const, cureConsecutivePeriods: 12 },
      },
    ],
  });

  const result = calculate(model);

  it('releases on the breaching facility own one-period cure, not the other facilitys unreached twelve', () => {
    // Hand-derived: January's surplus is its $1,000 NOI less the two
    // facilities' interest ($100,000 x 6%/12 = $500, $50,000 x 8%/12 =
    // $333.33) = $166.67 — small, but real, and enough to confirm something
    // was actually trapped and then actually released, not merely that the
    // diagnostics look right.
    expect(result.monthly.restrictedCash[0]).toBe('-166.67');
    expect(result.monthly.restrictedCash[1]).toBe('166.67');

    const sprung = result.diagnostics.find((entry) => entry.code === 'CASH_TRAP_SPRUNG');
    expect(sprung?.message).toContain('period 1');

    // Released in period 2 — one compliant period, exactly what the
    // breaching facility's own `cureConsecutivePeriods: 1` requires. The bug
    // borrowed the *never-breaching* mezzanine facility's `12` instead,
    // which twelve consecutive compliant periods starting from month 2
    // would never satisfy inside a 12-month forecast.
    const released = result.diagnostics.find((entry) => entry.code === 'CASH_TRAP_RELEASED');
    expect(released?.message).toContain('period 2');
    expect(released?.message).toContain('Covenant met for 1 consecutive periods');

    // Nothing remains trapped from March onward.
    for (let i = 2; i < 12; i += 1) {
      expect(result.monthly.restrictedCash[i]).toBe('0.00');
    }
  });
});

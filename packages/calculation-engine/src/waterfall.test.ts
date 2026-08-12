import { describe, expect, it } from 'vitest';
import { calculate } from './engine.js';
import { baseModel, extendModel } from './__fixtures__/builders.js';

/**
 * Equity distributions after the sale date.
 *
 * Found by a repository-wide correctness audit: `computeReturns` correctly
 * truncates `leveredIrr`/`equityMultiple` at the sale month (`horizon =
 * saleIndex + 1`), but the equity cash flow fed to `computeWaterfall`, and
 * `cashOnCashByYear`, were built from the full, untruncated forecast. A model
 * whose stated forecast runs past its sale month — a completely ordinary
 * configuration; `terminalNoiBasis: 'forward_12'` needs NOI *after* the sale
 * to compute a forward-looking exit value — showed partners receiving
 * distributions for months after the property was sold. See
 * `docs/commercial-gap-analysis.md` for how this was found.
 */
describe('equity distributions stop at the sale date', () => {
  // A single LP, wholly owning the residual, so its distributions are
  // exactly the equity cash flow the engine hands the waterfall — no split
  // math to account for, only the truncation this fixture exists to check.
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

  // 24-month forecast, sale at month 6, flat $10,000/month other revenue
  // (no leases, no expenses, no debt), so net operating income — and
  // therefore equity cash flow — is exactly $10,000 in every period that
  // is not the sale month.
  const model = extendModel(baseModel(), {
    forecast: {
      startDate: '2026-01-01',
      months: 24,
      fiscalYearStartMonth: 1,
      proration: 'actual_days',
    },
    otherRevenue: [
      {
        id: 'OTHER',
        name: 'Flat other revenue',
        method: 'custom_monthly_schedule',
        monthlySchedule: Array.from({ length: 24 }, () => '10000'),
      },
    ],
    valuation: {
      discountRate: '0.08',
      saleCostPercent: '0',
      directCapAdjustments: '0',
      acquisitionCosts: '0',
      acquisitionPrice: '2000000',
      saleMonth: 6,
      grossSalePriceOverride: '3000000',
    },
    equity: singleLpEquity,
  });

  const result = calculate(model);
  const lp = result.waterfall.find((partner) => partner.partnerId === 'LP');

  it('receives nothing but the sale month has arrived, and nothing at all after it', () => {
    // Hand-derived, independent of the engine: $10,000/month for 5 months
    // before the sale (months 1-5), plus the sale month's own $10,000 of
    // operating income and the full $3,000,000 (0% selling cost) of sale
    // proceeds in month 6. Nothing from the 18 months of the forecast that
    // remain after the sale — the property is no longer owned.
    const expectedDistributions = 10_000 * 5 + 10_000 + 3_000_000;
    expect(Number(lp?.distributions)).toBeCloseTo(expectedDistributions, 2);
    expect(Number(lp?.contributions)).toBeCloseTo(2_000_000, 2);
  });

  it('reports the same levered IRR the waterfall pays out as the property-level return states', () => {
    // With one partner holding the entire residual and no fees, the LP's
    // cash flow *is* the equity cash flow the property-level leveredIrr is
    // computed from — the two must (very nearly) agree. Before the fix the
    // waterfall's IRR reflected 18 extra months of phantom post-sale income
    // and came out over 3x too high (~19% vs ~5% on this fixture).
    expect(lp?.irr).not.toBeNull();
    expect(Number(lp?.irr)).toBeCloseTo(Number(result.returns.leveredIrr), 3);
  });

  it('produces no waterfall distribution events after the sale month', () => {
    // Diagnostics are the one place a discarded post-sale flow would leave a
    // trace if some other code path still fed it in — cross-checked here so
    // the fix is not only "the LP total looks right" but "nothing tried to
    // pay out the phantom months at all".
    expect(result.diagnostics.filter((entry) => entry.severity === 'error')).toEqual([]);
  });
});

/**
 * Partner contribution shares that sum to zero.
 *
 * Found by the same audit's second round (extreme-value cases): a capital
 * call is allocated by dividing each partner's stated `contributionShare` by
 * the sum of every partner's share. When every partner is entered at "0" —
 * a plausible data-entry state for a deal being drafted before ownership
 * percentages are finalized, not a deliberately malformed one — that sum is
 * zero, and dividing by it produced a zero allocation for every partner. The
 * capital call itself did not disappear from `equityCashFlow`; only each
 * partner's share of it did, silently, with no diagnostic. Contribution
 * shares are unrelated to a waterfall tier's own `splits`, so distributions
 * (governed by the residual-split tier below) are unaffected and exist here
 * only to give the LP/GP split something to check independently of the
 * contribution-share bug.
 */
describe('partner contribution shares that sum to zero', () => {
  const model = extendModel(baseModel(), {
    forecast: {
      startDate: '2026-01-01',
      months: 6,
      fiscalYearStartMonth: 1,
      proration: 'actual_days',
    },
    otherRevenue: [
      {
        id: 'OTHER',
        name: 'Flat other revenue',
        method: 'custom_monthly_schedule',
        monthlySchedule: Array.from({ length: 6 }, () => '10000'),
      },
    ],
    valuation: {
      discountRate: '0.08',
      saleCostPercent: '0',
      directCapAdjustments: '0',
      acquisitionCosts: '0',
      acquisitionPrice: '1000000',
      saleMonth: 3,
      grossSalePriceOverride: '1000000',
    },
    equity: {
      partners: [
        { id: 'LP', name: 'LP', role: 'lp' as const, contributionShare: '0' },
        { id: 'GP', name: 'GP', role: 'gp' as const, contributionShare: '0' },
      ],
      tiers: [
        {
          id: 'RESIDUAL',
          name: 'Residual',
          type: 'residual_split' as const,
          splits: [
            { partnerId: 'LP', share: '0.8' },
            { partnerId: 'GP', share: '0.2' },
          ],
        },
      ],
    },
  });

  const result = calculate(model);
  const lp = result.waterfall.find((partner) => partner.partnerId === 'LP');
  const gp = result.waterfall.find((partner) => partner.partnerId === 'GP');

  it('splits the capital call evenly across partners instead of losing it from the ledger', () => {
    // Hand-derived: the $1,000,000 acquisition is funded entirely by equity
    // (no debt in this fixture), so initialEquity is exactly $1,000,000.
    // Split evenly across the 2 partners since neither has a usable share.
    expect(Number(lp?.contributions)).toBeCloseTo(500_000, 2);
    expect(Number(gp?.contributions)).toBeCloseTo(500_000, 2);
  });

  it('records a PARTNER_SHARES_SUM_TO_ZERO error naming the cause', () => {
    const diagnostic = result.diagnostics.find(
      (entry) => entry.code === 'PARTNER_SHARES_SUM_TO_ZERO',
    );
    expect(diagnostic?.severity).toBe('error');
    expect(diagnostic?.message).toContain('sum to zero');
  });

  it('still splits residual distributions by the waterfall tier, not the contribution shares', () => {
    // Hand-derived, independent of the contribution-share bug: 2 months
    // (1-2) of $10,000 operating income, plus month 3's own $10,000 and the
    // full $1,000,000 sale price (0% selling cost, no debt to repay),
    // split 80/20 by the residual tier's own splits.
    const totalDistributions = 10_000 * 2 + 10_000 + 1_000_000;
    expect(Number(lp?.distributions)).toBeCloseTo(totalDistributions * 0.8, 2);
    expect(Number(gp?.distributions)).toBeCloseTo(totalDistributions * 0.2, 2);
  });
});

/**
 * Partner contribution shares that sum to zero, with no residual-split tier.
 *
 * Found by a third audit pass: the fix above (splitting a capital call evenly
 * when contribution shares sum to zero) only touched `contribute()`. The
 * waterfall's *other* place that falls back to `partner.share` — the
 * "nothing left to allocate the residual to" branch reached whenever a
 * period's cash flow has no tier left to absorb it — still divided by the
 * raw, zero `partner.share` for every partner. `normalise` there is
 * `partners.length` (matching `contribute`'s own normaliser when shares are
 * useless), not zero, so the bug was not a division by zero; it was
 * multiplying by a numerator of zero and rounding every partner's
 * allocation down to nothing. The fallback's own comment claims "cash is
 * never lost" and its diagnostic claims the cash "was allocated on
 * contribution shares" — both false when every partner's stated share is 0.
 */
describe('partner contribution shares that sum to zero, with no residual tier', () => {
  const model = extendModel(baseModel(), {
    forecast: {
      startDate: '2026-01-01',
      months: 6,
      fiscalYearStartMonth: 1,
      proration: 'actual_days',
    },
    otherRevenue: [
      {
        id: 'OTHER',
        name: 'Flat other revenue',
        method: 'custom_monthly_schedule',
        monthlySchedule: Array.from({ length: 6 }, () => '10000'),
      },
    ],
    valuation: {
      discountRate: '0.08',
      saleCostPercent: '0',
      directCapAdjustments: '0',
      acquisitionCosts: '0',
      acquisitionPrice: '1000000',
      saleMonth: 3,
      grossSalePriceOverride: '1000000',
    },
    equity: {
      partners: [
        { id: 'LP', name: 'LP', role: 'lp' as const, contributionShare: '0' },
        { id: 'GP', name: 'GP', role: 'gp' as const, contributionShare: '0' },
      ],
      // No tiers at all: every period's positive cash flow has nothing to
      // absorb it and falls straight to the "nothing left to allocate the
      // residual to" branch.
      tiers: [],
    },
  });

  const result = calculate(model);
  const lp = result.waterfall.find((partner) => partner.partnerId === 'LP');
  const gp = result.waterfall.find((partner) => partner.partnerId === 'GP');

  it('splits the unallocated residual evenly across partners instead of losing it from the ledger', () => {
    // Hand-derived, independent of the engine: 2 months (1-2) of $10,000
    // operating income, plus month 3's own $10,000 and the full $1,000,000
    // sale price (0% selling cost, no debt to repay) = $1,030,000 total,
    // split evenly across the 2 partners since neither has a usable share.
    const totalDistributed = 10_000 * 2 + 10_000 + 1_000_000;
    expect(Number(lp?.distributions)).toBeCloseTo(totalDistributed / 2, 2);
    expect(Number(gp?.distributions)).toBeCloseTo(totalDistributed / 2, 2);
  });

  it('records both the zero-shares error and the unallocated-residual warning', () => {
    expect(
      result.diagnostics.find((entry) => entry.code === 'PARTNER_SHARES_SUM_TO_ZERO')?.severity,
    ).toBe('error');
    expect(
      result.diagnostics.find((entry) => entry.code === 'WATERFALL_RESIDUAL_UNALLOCATED')?.severity,
    ).toBe('warning');
  });
});

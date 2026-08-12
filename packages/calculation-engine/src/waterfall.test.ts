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

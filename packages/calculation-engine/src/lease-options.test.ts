import { describe, expect, it } from 'vitest';
import { calculate } from './engine.js';
import { buildModel } from './__fixtures__/builders.js';

/**
 * Two defects in `branchOnOption`, found by a fourth audit pass targeted at
 * lease-option branching and rollover interaction:
 *
 * 1. The renewal branch returned early — before pushing the exercised-weight
 *    branch — whenever the extension's start date (the day after the current
 *    term's contractual expiration) fell after the forecast horizon. This is
 *    not a rare configuration: it happens whenever a lease's current term
 *    simply runs through (or past) the end of the forecast, which is
 *    ordinary. The exercised branch's weight was silently dropped instead of
 *    the (invisible) extension being skipped, understating the lease's own
 *    already-elapsed, fully visible term — and at 100% probability, erasing
 *    the lease from the model entirely, since the lapsed branch carries zero
 *    weight in that case too.
 * 2. A termination option's `cost` (the exercise fee) was recorded in the
 *    trace but never applied to any cash-flow line the engine actually
 *    reports — see the second describe block below.
 */
describe('a renewal option whose current term runs through the forecast horizon', () => {
  // 12-month forecast, lease running exactly through the last day of it —
  // the ordinary case, not a contrived one: any lease whose term happens to
  // span the whole hold period hits this. A renewal option dated mid-term
  // means the extension itself starts the day after the forecast ends,
  // making the whole decision invisible to the forecast either way.
  function model(probability: string) {
    return buildModel({
      modelId: 'fx-renewal-horizon',
      modelName: 'Renewal at the forecast horizon (fixture)',
      forecast: {
        startDate: '2026-01-01',
        months: 12,
        fiscalYearStartMonth: 1,
        proration: 'actual_days',
      },
      property: { id: 'P1', name: 'Fixture', propertyType: 'office', rentableArea: '12000' },
      spaces: [{ id: 'S1', code: 'Whole building', area: '12000' }],
      tenants: [{ id: 'T1', name: 'Sole tenant' }],
      leases: [
        {
          id: 'L1',
          tenantId: 'T1',
          spaceIds: ['S1'],
          status: 'occupied',
          area: '12000',
          commencementDate: '2026-01-01',
          expirationDate: '2026-12-31',
          baseRent: '12.00',
          baseRentBasis: 'per_area_per_year',
          excludeFromRollover: true,
          options: [
            {
              id: 'OPT-RENEW',
              type: 'renewal',
              exerciseDate: '2026-06-01',
              probability,
              termMonths: 12,
              rentMethod: 'fixed',
              rentAmount: '15.00',
              rentBasis: 'per_area_per_year',
              cost: '0',
            },
          ],
        },
      ],
      valuation: {
        discountRate: '0.08',
        saleCostPercent: '0',
        directCapAdjustments: '0',
        acquisitionCosts: '0',
        acquisitionPrice: '1500000',
        saleMonth: 12,
      },
    });
  }

  it('keeps the full weight of the already-elapsed term at 60% renewal probability', () => {
    // Hand-derived: $12.00/sqft/year x 12,000 sqft = $144,000/year, exactly
    // $12,000/month for 12 whole calendar months. The extension is entirely
    // beyond the forecast, so exercised and lapsed branches are
    // indistinguishable in the visible cash flow — the correct total is the
    // full $144,000 regardless of the 60% probability, not 60% of it.
    const result = calculate(model('0.6'));
    const totalBaseRent = result.monthly.contractualBaseRent.reduce((acc, v) => acc + Number(v), 0);
    expect(totalBaseRent).toBeCloseTo(144_000, 2);
  });

  it('does not erase the lease from the forecast at 100% renewal probability', () => {
    // At probability 1 the lapsed branch carries zero weight, so if the
    // exercised branch's weight is also dropped (the bug), nothing survives
    // `expandOptions` for this lease at all: zero rent for the whole term.
    const result = calculate(model('1'));
    const totalBaseRent = result.monthly.contractualBaseRent.reduce((acc, v) => acc + Number(v), 0);
    expect(totalBaseRent).toBeCloseTo(144_000, 2);
  });
});

describe('a termination option with a nonzero exercise cost', () => {
  it('applies the termination fee to the tenant-improvements cash-flow line', () => {
    // 12-month forecast; the lease terminates mid-term (July 1, 2026) with a
    // $50,000 landlord payment to the tenant. Before the fix this cost was
    // recorded only in the trace's "result" field and never reached
    // `tenantImprovements` at all.
    const model = buildModel({
      modelId: 'fx-termination-fee',
      modelName: 'Termination fee (fixture)',
      forecast: {
        startDate: '2026-01-01',
        months: 12,
        fiscalYearStartMonth: 1,
        proration: 'actual_days',
      },
      property: { id: 'P1', name: 'Fixture', propertyType: 'office', rentableArea: '12000' },
      spaces: [{ id: 'S1', code: 'Whole building', area: '12000' }],
      tenants: [{ id: 'T1', name: 'Sole tenant' }],
      leases: [
        {
          id: 'L1',
          tenantId: 'T1',
          spaceIds: ['S1'],
          status: 'occupied',
          area: '12000',
          commencementDate: '2026-01-01',
          expirationDate: '2030-12-31',
          baseRent: '12.00',
          baseRentBasis: 'per_area_per_year',
          excludeFromRollover: true,
          options: [
            {
              id: 'OPT-TERM',
              type: 'termination',
              exerciseDate: '2026-07-01',
              probability: '1',
              cost: '50000',
            },
          ],
        },
      ],
      valuation: {
        discountRate: '0.08',
        saleCostPercent: '0',
        directCapAdjustments: '0',
        acquisitionCosts: '0',
        acquisitionPrice: '1500000',
        saleMonth: 12,
      },
    });
    const result = calculate(model);

    // Reported as a cost (negative), landed on the exercise month (July,
    // index 6) — not spread, not dropped, not dated to the lease's original
    // commencement.
    expect(result.monthly.tenantImprovements[6]).toBe('-50000.00');
    for (let i = 0; i < 12; i += 1) {
      if (i === 6) continue;
      expect(result.monthly.tenantImprovements[i]).toBe('0.00');
    }

    // The fee occurrence contributes no rent or occupancy of its own — a
    // regression this specific to catch would be the fee being applied via
    // a phantom extra day of billed rent instead of a clean, zero-footprint
    // cost entry.
    expect(result.monthly.contractualBaseRent[0]).toBe('12000.00');
    expect(result.monthly.contractualBaseRent[7]).toBe('0.00');
  });
});

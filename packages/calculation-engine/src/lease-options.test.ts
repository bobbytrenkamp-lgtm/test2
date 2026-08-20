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

describe('a terminated lease with a nonzero exercise cost, rolled over rather than excluded', () => {
  it('lets the space roll over onto the new-lease market terms instead of staying zero forever', () => {
    // Same termination as above (July 1, 2026, $50,000 fee) but this time
    // `excludeFromRollover` is left at its default `false`, and a market
    // leasing profile is configured. Before the fix, the zero-area "fee"
    // marker occurrence — pushed *after* `ended` whenever the cost is
    // nonzero — became the rollover seed instead of `ended`, so every
    // occurrence rollover generated from it inherited `area: 0` and stayed
    // zero for the rest of the forecast, no matter what the market leasing
    // profile said.
    //
    // Hand-derived: renewalProbability is 0, so the full weight goes to the
    // "new lease" branch, starting `downtimeMonths` (3) after the day after
    // termination (2026-07-02) -> 2026-10-02. August and September (indices
    // 7 and 8) are wholly within the vacancy, so contractual rent is zero.
    // November (index 10) is the first full calendar month entirely inside
    // the new lease: 12,000 sqft x $32.00/sqft/yr / 12 = $32,000.00 exactly.
    const model = buildModel({
      modelId: 'fx-termination-fee-rollover',
      modelName: 'Termination fee with rollover (fixture)',
      forecast: {
        startDate: '2026-01-01',
        months: 24,
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
      marketLeasingProfiles: [
        {
          id: 'MLA-1',
          name: 'Fixture market',
          marketRent: '32.00',
          marketRentBasis: 'per_area_per_year',
          renewalProbability: '0',
          renewalTermMonths: 60,
          newLeaseTermMonths: 60,
          downtimeMonths: 3,
          newFreeRentMonths: 0,
          newTiPerArea: '0',
          newLcPercent: '0',
          recovery: { method: 'none' },
        },
      ],
      defaultMarketLeasingProfileId: 'MLA-1',
      valuation: {
        discountRate: '0.08',
        saleCostPercent: '0',
        directCapAdjustments: '0',
        acquisitionCosts: '0',
        acquisitionPrice: '1500000',
        saleMonth: 24,
      },
    });
    const result = calculate(model);

    expect(result.monthly.contractualBaseRent[7]).toBe('0.00');
    expect(result.monthly.contractualBaseRent[8]).toBe('0.00');
    expect(result.monthly.contractualBaseRent[10]).toBe('32000.00');
  });
});

/**
 * An expansion option that names a real space — the case the engine refused
 * outright before `expansionSpaceIds` existed. A two-suite property: the
 * tenant holds an 8,000 sf suite (S1) and expands into a vacant 2,000 sf
 * suite (S2) exactly at the mid-year exercise date.
 */
describe('an expansion option naming a real, vacant space', () => {
  function twoSuiteModel(options: unknown[], secondLease: unknown[] = []) {
    return buildModel({
      modelId: 'fx-expansion',
      modelName: 'Expansion via space reference (fixture)',
      forecast: {
        startDate: '2026-01-01',
        months: 12,
        fiscalYearStartMonth: 1,
        proration: 'actual_days',
      },
      property: { id: 'P1', name: 'Fixture', propertyType: 'office', rentableArea: '10000' },
      spaces: [
        { id: 'S1', code: 'Suite 1', area: '8000' },
        { id: 'S2', code: 'Suite 2', area: '2000' },
      ],
      tenants: [
        { id: 'T1', name: 'Sole tenant' },
        { id: 'T2', name: 'Other tenant' },
      ],
      leases: [
        {
          id: 'L1',
          tenantId: 'T1',
          spaceIds: ['S1'],
          status: 'occupied',
          area: '8000',
          commencementDate: '2026-01-01',
          expirationDate: '2030-12-31',
          baseRent: '12.00',
          baseRentBasis: 'per_area_per_year',
          excludeFromRollover: true,
          options,
        },
        ...secondLease,
      ],
      valuation: {
        discountRate: '0.08',
        saleCostPercent: '0',
        directCapAdjustments: '0',
        acquisitionCosts: '0',
        acquisitionPrice: '1500000',
        saleMonth: 12,
      },
    } as Parameters<typeof buildModel>[0]);
  }

  it('adds the named space’s area to rent from the exercise date, and pays its TI cost once', () => {
    // Hand-derived: $12.00/sf/yr, per_area_per_year.
    // Jan-Jun (indices 0-5): 8,000 sf x 12 / 12 = $8,000.00/month.
    // Jul-Dec (indices 6-11): (8,000 + 2,000) sf x 12 / 12 = $10,000.00/month,
    // priced at the same $12.00 rate the tenant already pays -- expansion does
    // not reprice the added space (see the module comment for why).
    const model = twoSuiteModel([
      {
        id: 'OPT-EXPAND',
        type: 'expansion',
        exerciseDate: '2026-07-01',
        probability: '1',
        expansionSpaceIds: ['S2'],
        cost: '20000',
      },
    ]);
    const result = calculate(model);

    for (let i = 0; i < 6; i += 1) {
      expect(result.monthly.contractualBaseRent[i]).toBe('8000.00');
    }
    for (let i = 6; i < 12; i += 1) {
      expect(result.monthly.contractualBaseRent[i]).toBe('10000.00');
    }

    // The TI cost lands once, on the exercise month, as a cost (negative).
    expect(result.monthly.tenantImprovements[6]).toBe('-20000.00');
    for (let i = 0; i < 12; i += 1) {
      if (i === 6) continue;
      expect(result.monthly.tenantImprovements[i]).toBe('0.00');
    }

    expect(result.diagnostics.some((entry) => entry.code === 'LEASE_OPTION_NOT_MODELLED')).toBe(
      false,
    );
  });

  it('is not honoured, and warns, when the named space does not exist on the property', () => {
    const model = twoSuiteModel([
      {
        id: 'OPT-EXPAND',
        type: 'expansion',
        exerciseDate: '2026-07-01',
        probability: '1',
        expansionSpaceIds: ['S-NOPE'],
      },
    ]);
    const result = calculate(model);

    const warning = result.diagnostics.find((entry) => entry.code === 'EXPANSION_SPACE_INVALID');
    expect(warning?.message).toContain('S-NOPE');
    expect(warning?.message).toContain('no such space');

    // Unaffected: the lease's own 8,000 sf, all twelve months.
    for (let i = 0; i < 12; i += 1) {
      expect(result.monthly.contractualBaseRent[i]).toBe('8000.00');
    }
  });

  it('is not honoured, and warns, when the named space is already part of this lease', () => {
    const model = twoSuiteModel([
      {
        id: 'OPT-EXPAND',
        type: 'expansion',
        exerciseDate: '2026-07-01',
        probability: '1',
        expansionSpaceIds: ['S1'],
      },
    ]);
    const result = calculate(model);

    const warning = result.diagnostics.find((entry) => entry.code === 'EXPANSION_SPACE_INVALID');
    expect(warning?.message).toContain('S1');
    expect(warning?.message).toContain('already part of this lease');

    for (let i = 0; i < 12; i += 1) {
      expect(result.monthly.contractualBaseRent[i]).toBe('8000.00');
    }
  });

  it('still trips the existing double-let diagnostic when the claimed space overlaps another lease’s term', () => {
    // S2 is already let, whole forecast, to a second tenant. L1's expansion
    // claims it anyway from July 1 -- this is not a structural error the
    // option's own validation catches (S2 is a real space L1 does not yet
    // hold), so it is honoured, and the resulting overlap is exactly what
    // the engine's own SPACE_DOUBLE_LET check exists to catch.
    const model = twoSuiteModel(
      [
        {
          id: 'OPT-EXPAND',
          type: 'expansion',
          exerciseDate: '2026-07-01',
          probability: '1',
          expansionSpaceIds: ['S2'],
        },
      ],
      [
        {
          id: 'L2',
          tenantId: 'T2',
          spaceIds: ['S2'],
          status: 'occupied',
          area: '2000',
          commencementDate: '2025-01-01',
          expirationDate: '2031-12-31',
          baseRent: '14.00',
          baseRentBasis: 'per_area_per_year',
          excludeFromRollover: true,
          options: [],
        },
      ],
    );
    const result = calculate(model);

    const warning = result.diagnostics.find((entry) => entry.code === 'SPACE_DOUBLE_LET');
    expect(warning).toBeTruthy();
  });
});

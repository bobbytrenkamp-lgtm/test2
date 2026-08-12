import { describe, expect, it } from 'vitest';
import { calculate } from './engine.js';
import { buildModel } from './__fixtures__/builders.js';

/**
 * A base-year (or expense-stop) recovery pool whose first billed year
 * settles at exactly zero, followed by a cap.
 *
 * Found by a fourth audit pass targeted at recovery pool boundary cases:
 * the cap/floor check gated on `priorRecovery !== null && firstRecovery !==
 * null`, but a base-year pool's own first billed year settles at exactly
 * zero by definition — the entitlement is the excess over the base year, and
 * the base year has no excess over itself. Zero is not `null`, so the check
 * passed, and a multiplicative ceiling anchored at a zero baseline
 * (`0 x (1 + capPercent) = 0`) pinned every later year's recovery at zero
 * forever, regardless of how much expenses actually grew — silently
 * eliminating the entire recovery line rather than limiting its growth.
 */
describe('a base-year recovery pool with a cap, whose base year settles at zero', () => {
  it('does not pin every later year at zero once the cap has a real baseline to grow from', () => {
    // 36-month forecast, 3 full fiscal years. Single tenant occupying the
    // whole building, so proRataShare is exactly 1 and every dollar of the
    // recoverable pool is the tenant's own entitlement basis, with nothing
    // else to hand-derive around gross-up or occupancy.
    //
    // Hand-derived, independent of the engine:
    //   FY2026 (base year):      $480,000 recoverable pool -> entitlement $0
    //     (by definition: base year has no excess over itself)
    //   FY2027: $540,000 pool -> entitlement = 540,000 - 480,000 = $60,000.
    //     The base year settled at $0, so a 5% cap has no baseline to
    //     constrain growth from: this year is billed uncapped.
    //   FY2028: $600,000 pool -> entitlement = 600,000 - 480,000 = $120,000.
    //     Now there is a real prior year ($60,000) to cap against:
    //     ceiling = 60,000 x 1.05 = $63,000, so this year settles at $63,000.
    const monthlySchedule = [
      ...Array.from({ length: 12 }, () => '40000'), // FY2026: 12 x 40,000 = 480,000
      ...Array.from({ length: 12 }, () => '45000'), // FY2027: 12 x 45,000 = 540,000
      ...Array.from({ length: 12 }, () => '50000'), // FY2028: 12 x 50,000 = 600,000
    ];

    const model = buildModel({
      modelId: 'fx-base-year-cap-zero-baseline',
      modelName: 'Base-year cap off a zero baseline (fixture)',
      forecast: {
        startDate: '2026-01-01',
        months: 36,
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
          baseRent: '0.01',
          baseRentBasis: 'per_area_per_year',
          excludeFromRollover: true,
          recovery: {
            method: 'base_year',
            baseYear: 2026,
            capPercent: '0.05',
            capIsCumulative: false,
          },
        },
      ],
      expenses: [
        {
          id: 'E1',
          name: 'Operating expenses',
          category: 'cam',
          method: 'custom_monthly_schedule',
          monthlySchedule,
          recoverableShare: '1',
          variableShare: '0',
        },
      ],
      valuation: {
        discountRate: '0.08',
        saleCostPercent: '0',
        directCapAdjustments: '0',
        acquisitionCosts: '0',
        acquisitionPrice: '1000000',
        saleMonth: 36,
      },
    });

    const result = calculate(model);
    const byYear = new Map(result.recoveryDetail.map((row) => [row.fiscalYear, row]));

    expect(Number(byYear.get(2026)?.finalRecovery)).toBeCloseTo(0, 2);
    expect(Number(byYear.get(2027)?.finalRecovery)).toBeCloseTo(60_000, 2);
    expect(Number(byYear.get(2028)?.finalRecovery)).toBeCloseTo(63_000, 2);

    // The zero-baseline year is named, not just silently uncapped.
    const zeroBaselineWarning = result.diagnostics.find(
      (entry) => entry.code === 'RECOVERY_CAP_ZERO_BASELINE',
    );
    expect(zeroBaselineWarning?.severity).toBe('warning');
  });
});

/**
 * Two explicit recovery pools on the same lease that both claim the same
 * expense category.
 *
 * Found by the same audit pass: a pool with an empty `includedCategories`
 * falls back to "every category flagged recoverable", which is easy to
 * collide with a second, more specific pool that names one of those same
 * categories explicitly — an easy misconfiguration, not a contrived one, and
 * one the engine gave no diagnostic for even though it silently doubles the
 * tenant's bill for that category.
 */
describe('two recovery pools on one lease that claim the same expense category', () => {
  it('warns that the category is billed once per pool that claims it', () => {
    const model = buildModel({
      modelId: 'fx-recovery-pool-overlap',
      modelName: 'Overlapping recovery pools (fixture)',
      forecast: {
        startDate: '2026-01-01',
        months: 12,
        fiscalYearStartMonth: 1,
        proration: 'actual_days',
      },
      property: { id: 'P1', name: 'Fixture', propertyType: 'office', rentableArea: '10000' },
      spaces: [{ id: 'S1', code: 'Whole building', area: '10000' }],
      tenants: [{ id: 'T1', name: 'Sole tenant' }],
      leases: [
        {
          id: 'L1',
          tenantId: 'T1',
          spaceIds: ['S1'],
          status: 'occupied',
          area: '10000',
          commencementDate: '2026-01-01',
          expirationDate: '2030-12-31',
          baseRent: '0.01',
          baseRentBasis: 'per_area_per_year',
          excludeFromRollover: true,
          recovery: {
            pools: [
              // Left empty: falls back to every category with a positive
              // recoverableShare, which includes "taxes" below too.
              { code: 'ALL', name: 'Everything', method: 'triple_net', includedCategories: [] },
              {
                code: 'TAX',
                name: 'Taxes only',
                method: 'triple_net',
                includedCategories: ['taxes'],
              },
            ],
          },
        },
      ],
      expenses: [
        {
          id: 'E1',
          name: 'Property taxes',
          category: 'taxes',
          method: 'fixed_annual',
          amount: '120000',
          recoverableShare: '1',
          variableShare: '0',
        },
      ],
      valuation: {
        discountRate: '0.08',
        saleCostPercent: '0',
        directCapAdjustments: '0',
        acquisitionCosts: '0',
        acquisitionPrice: '1000000',
        saleMonth: 12,
      },
    });

    const result = calculate(model);
    const diagnostic = result.diagnostics.find(
      (entry) => entry.code === 'RECOVERY_CATEGORY_CLAIMED_BY_MULTIPLE_POOLS',
    );
    expect(diagnostic?.severity).toBe('warning');
    expect(diagnostic?.message).toContain('taxes');
    expect(diagnostic?.message).toContain('ALL');
    expect(diagnostic?.message).toContain('TAX');

    // The double recovery itself: $120,000 of taxes charged through both
    // pools totals $240,000 of recovery revenue for a single $120,000
    // expense.
    const byPool = new Map(result.recoveryDetail.map((row) => [row.poolCode, row]));
    const total =
      Number(byPool.get('ALL')?.finalRecovery) + Number(byPool.get('TAX')?.finalRecovery);
    expect(total).toBeCloseTo(240_000, 2);
  });
});

/**
 * A revenue- or rent-basis expense (e.g. a management fee charged as a
 * percent of base rent), fully recoverable and marked fully occupancy-
 * variable.
 *
 * Found by an eighth audit pass: `computeExpenseSeries` correctly skips the
 * `fixedShare + variableShare x occupancy` scaling for
 * `percent_of_effective_gross_revenue`/`percent_of_base_rent` expenses when
 * computing the expense's own reported amount — `base` (built from actual
 * base rent or actual effective gross revenue) already reflects real
 * occupancy, so scaling it by occupancy again would apply the discount
 * twice. But the *recoverable* split (`recoverableFixed`/
 * `recoverableVariableFull`) made no such exception, applying the
 * `fixedShare`/`variableShare` split unconditionally — and
 * `recoverableVariableFull` is later rescaled by occupancy a second time in
 * `poolForYear`, silently understating recovery revenue (and therefore
 * EGR, NOI and valuation) for exactly this configuration.
 */
describe('a revenue-basis expense, fully recoverable and fully occupancy-variable', () => {
  it('does not apply occupancy to the recoverable split a second time on top of the occupancy already embedded in the expense amount', () => {
    // 12-month forecast. One lease occupying 8,000 of the building's 10,000
    // sqft (a physical occupancy of exactly 0.8), flat $15/sqft/year base
    // rent -> $10,000/month contractual rent, with no escalation or free
    // rent to complicate the monthly figure.
    //
    // Expense: 30% of base rent, 100% recoverable, 100% occupancy-variable
    // (a deliberately extreme setting, chosen so the bug's effect is not
    // diluted by a partial fixed/variable split). `proRataShareOverride:
    // '1'` isolates the test to the bug's own mechanism, independent of the
    // tenant's own (legitimate, unrelated) pro-rata share of the building.
    //
    // Hand-derived: expense amount = 0.30 x $10,000 = $3,000/month, or
    // $36,000/year. 100% recoverable of a $36,000/year expense is $36,000 —
    // the base rent it's computed from already reflects this tenant's own
    // real occupancy, so there is nothing left for a second occupancy
    // discount to legitimately apply to.
    const model = buildModel({
      modelId: 'fx-revenue-basis-expense-occupancy',
      modelName: 'Revenue-basis expense recoverable split (fixture)',
      forecast: {
        startDate: '2026-01-01',
        months: 12,
        fiscalYearStartMonth: 1,
        proration: 'actual_days',
      },
      property: { id: 'P1', name: 'Fixture', propertyType: 'office', rentableArea: '10000' },
      spaces: [{ id: 'S1', code: 'Whole building', area: '10000' }],
      tenants: [{ id: 'T1', name: 'Sole tenant' }],
      leases: [
        {
          id: 'L1',
          tenantId: 'T1',
          spaceIds: ['S1'],
          status: 'occupied',
          area: '8000',
          commencementDate: '2026-01-01',
          expirationDate: '2030-12-31',
          baseRent: '15.00',
          baseRentBasis: 'per_area_per_year',
          excludeFromRollover: true,
          recovery: { method: 'triple_net', proRataShareOverride: '1' },
        },
      ],
      expenses: [
        {
          id: 'E1',
          name: 'Management fee',
          category: 'management',
          method: 'percent_of_base_rent',
          amount: '0.30',
          recoverableShare: '1',
          variableShare: '1',
        },
      ],
      valuation: {
        discountRate: '0.08',
        saleCostPercent: '0',
        directCapAdjustments: '0',
        acquisitionCosts: '0',
        acquisitionPrice: '1000000',
        saleMonth: 12,
      },
    });

    const result = calculate(model);
    const recovery = result.recoveryDetail.find((row) => row.fiscalYear === 2026);
    expect(Number(recovery?.finalRecovery)).toBeCloseTo(36_000, 2);
  });
});

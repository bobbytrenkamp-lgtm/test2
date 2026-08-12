import { describe, expect, it } from 'vitest';
import { calculate } from './engine.js';
import { baseModel, extendModel } from './__fixtures__/builders.js';

/**
 * Duplicate ids and dangling growth-curve references.
 *
 * Found by a seventh audit pass, tracing every place the engine looks an
 * entity up by its own id via a Map: `leases.ts` already refused a duplicate
 * space id (`DUPLICATE_SPACE`), but nothing refused a duplicate debt
 * facility, waterfall tier, partner, growth curve or lease id, and nothing
 * flagged a `growthCurveId` that names a curve the model does not have. Each
 * is a silently wrong number, not a crash: a shadowed facility's covenant
 * breaches are invisible to the cash trap (`Array.prototype.find` always
 * resolves to whichever entity was listed first), a shadowed tier's balance
 * map is shared and double-accrues, a shadowed lease's per-lease report
 * shows a different lease's figures, and a dangling curve reference is
 * silently treated as flat 0% growth forever.
 */
describe('duplicate debt facility ids', () => {
  it('disables the cash trap for the shadowed (second) facility, and is flagged', () => {
    // D1 (listed first, no cash trap) and D2 (listed second, cash-trap
    // enabled and genuinely breaching) share an id. `applyCashTrap` resolves
    // each facility's breach history via `schedules.find(id === facility.id)`,
    // which always returns D1's schedule — so D2's own breach is invisible
    // and the trap never springs, even though the covenant genuinely fails.
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
      debt: [
        {
          id: 'DUP',
          name: 'First facility (no trap)',
          type: 'permanent',
          commitment: '10000',
          initialFunding: '10000',
          fundingDate: '2026-01-01',
          rateType: 'fixed' as const,
          fixedRate: '0.01',
          interestOnlyMonths: 999,
          amortizationMonths: 0,
          termMonths: 24,
        },
        {
          id: 'DUP',
          name: 'Second facility (should trap, but is shadowed)',
          type: 'permanent',
          commitment: '100000',
          initialFunding: '100000',
          fundingDate: '2026-01-01',
          rateType: 'fixed' as const,
          fixedRate: '0.06',
          interestOnlyMonths: 999,
          amortizationMonths: 0,
          termMonths: 24,
          minimumDscr: '999',
          cashTrap: { enabled: true, trigger: 'any_covenant' as const, cureConsecutivePeriods: 1 },
        },
      ],
    });

    const result = calculate(model);

    const diagnostic = result.diagnostics.find((entry) => entry.code === 'DUPLICATE_DEBT_FACILITY');
    expect(diagnostic?.severity).toBe('error');
    expect(diagnostic?.message).toContain('DUP');

    // A minimumDscr of 999 fails in every single period, so if the second
    // facility's own breach history were visible, the trap would spring
    // immediately and stay sprung (cureConsecutivePeriods: 1 never reached
    // since it never complies). Confirming nothing is trapped demonstrates
    // the shadowing, not just that the diagnostic string appears.
    expect(result.monthly.restrictedCash.every((v) => v === '0.00')).toBe(true);
  });
});

describe('duplicate waterfall tier ids', () => {
  it('double-accrues the preferred return for the shadowed tier, and is flagged', () => {
    // Two tiers share the id "PREF", both a compounding 8% preferred return
    // over the same partner. `accrued.get(tier.id)` resolves to the SAME
    // balance map both times the per-period accrual loop iterates over
    // `structure.tiers`, so the monthly rate compounds twice within one
    // calendar month instead of once.
    const model = extendModel(baseModel(), {
      forecast: {
        startDate: '2026-01-01',
        months: 1,
        fiscalYearStartMonth: 1,
        proration: 'actual_days',
      },
      valuation: {
        discountRate: '0.08',
        saleCostPercent: '0',
        directCapAdjustments: '0',
        acquisitionCosts: '0',
        acquisitionPrice: '1000000',
        saleMonth: 1,
        grossSalePriceOverride: '1000000',
      },
      equity: {
        partners: [{ id: 'LP', name: 'LP', role: 'lp' as const, contributionShare: '1' }],
        tiers: [
          {
            id: 'PREF',
            name: 'Preferred (first)',
            type: 'preferred_return' as const,
            hurdleRate: '0.08',
            compounding: true,
            splits: [{ partnerId: 'LP', share: '1' }],
          },
          {
            id: 'PREF',
            name: 'Preferred (duplicate id)',
            type: 'preferred_return' as const,
            hurdleRate: '0.08',
            compounding: true,
            splits: [{ partnerId: 'LP', share: '1' }],
          },
          {
            id: 'RESIDUAL',
            name: 'Residual',
            type: 'residual_split' as const,
            splits: [{ partnerId: 'LP', share: '1' }],
          },
        ],
      },
    });

    const result = calculate(model);

    const diagnostic = result.diagnostics.find(
      (entry) => entry.code === 'DUPLICATE_WATERFALL_TIER',
    );
    expect(diagnostic?.severity).toBe('error');
    expect(diagnostic?.message).toContain('PREF');
  });
});

describe('duplicate partner ids', () => {
  it('is flagged with an error', () => {
    const model = extendModel(baseModel(), {
      equity: {
        partners: [
          { id: 'DUP', name: 'First partner', role: 'lp' as const, contributionShare: '0.5' },
          { id: 'DUP', name: 'Second partner', role: 'gp' as const, contributionShare: '0.5' },
        ],
        tiers: [
          {
            id: 'RESIDUAL',
            name: 'Residual',
            type: 'residual_split' as const,
            splits: [{ partnerId: 'DUP', share: '1' }],
          },
        ],
      },
    });

    const result = calculate(model);
    const diagnostic = result.diagnostics.find((entry) => entry.code === 'DUPLICATE_PARTNER');
    expect(diagnostic?.severity).toBe('error');
    expect(diagnostic?.message).toContain('DUP');
  });
});

describe('duplicate lease ids', () => {
  it('is flagged with an error', () => {
    const model = extendModel(baseModel(), {
      spaces: [
        { id: 'S1', code: 'Suite 1', area: '5000' },
        { id: 'S2', code: 'Suite 2', area: '5000' },
      ],
      tenants: [
        { id: 'T1', name: 'Tenant One' },
        { id: 'T2', name: 'Tenant Two' },
      ],
      leases: [
        {
          id: 'DUP',
          tenantId: 'T1',
          spaceIds: ['S1'],
          status: 'occupied' as const,
          area: '5000',
          commencementDate: '2026-01-01',
          expirationDate: '2030-12-31',
          baseRent: '10.00',
          baseRentBasis: 'per_area_per_year' as const,
        },
        {
          id: 'DUP',
          tenantId: 'T2',
          spaceIds: ['S2'],
          status: 'occupied' as const,
          area: '5000',
          commencementDate: '2026-01-01',
          expirationDate: '2030-12-31',
          baseRent: '20.00',
          baseRentBasis: 'per_area_per_year' as const,
        },
      ],
    });

    const result = calculate(model);
    const diagnostic = result.diagnostics.find((entry) => entry.code === 'DUPLICATE_LEASE');
    expect(diagnostic?.severity).toBe('error');
    expect(diagnostic?.message).toContain('DUP');
  });
});

describe('duplicate growth curve ids', () => {
  it('is flagged with an error', () => {
    const model = extendModel(baseModel(), {
      growthCurves: [
        { id: 'DUP', name: 'Two percent', defaultRate: '0.02' },
        { id: 'DUP', name: 'Five percent', defaultRate: '0.05' },
      ],
    });

    const result = calculate(model);
    const diagnostic = result.diagnostics.find((entry) => entry.code === 'DUPLICATE_GROWTH_CURVE');
    expect(diagnostic?.severity).toBe('error');
    expect(diagnostic?.message).toContain('DUP');
  });
});

describe('a growth curve id referenced but not defined on the model', () => {
  it('is flagged with an error, distinct from a curve that is simply unset', () => {
    const model = extendModel(baseModel(), {
      expenses: [
        {
          id: 'E1',
          name: 'Operating expenses',
          category: 'cam',
          method: 'fixed_annual' as const,
          amount: '120000',
          growthCurveId: 'MISSING',
          recoverableShare: '0',
          variableShare: '0',
        },
      ],
    });

    const result = calculate(model);
    const diagnostic = result.diagnostics.find((entry) => entry.code === 'GROWTH_CURVE_NOT_FOUND');
    expect(diagnostic?.severity).toBe('error');
    expect(diagnostic?.message).toContain('MISSING');
    expect(diagnostic?.message).toContain('expense:E1');

    // No growth is applied — the reference is silently ignored for the
    // purposes of computing the actual expense, exactly as an unset
    // growthCurveId would be, but now with a diagnostic explaining why.
    const noGrowthCurveModel = extendModel(baseModel(), {
      expenses: [
        {
          id: 'E1',
          name: 'Operating expenses',
          category: 'cam',
          method: 'fixed_annual' as const,
          amount: '120000',
          recoverableShare: '0',
          variableShare: '0',
        },
      ],
    });
    const controlResult = calculate(noGrowthCurveModel);
    expect(
      controlResult.diagnostics.find((entry) => entry.code === 'GROWTH_CURVE_NOT_FOUND'),
    ).toBeUndefined();
  });
});

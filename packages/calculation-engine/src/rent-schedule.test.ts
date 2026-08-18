import { describe, expect, it } from 'vitest';
import { calculate } from './engine.js';
import { baseModel, extendModel } from './__fixtures__/builders.js';

/**
 * Escalation floors and caps.
 *
 * `clampRate` in `rent-schedule.ts` has clamped a `fixed_percent` or `index`
 * escalation's step rate against `floorRate`/`capRate` since the schema first
 * offered them, but no fixture ever set either field — every escalation
 * fixture in the regression library escalates at its stated rate with
 * nothing to clamp, so the clamp itself was never exercised.
 */
describe('escalation floors and caps', () => {
  const model = extendModel(baseModel(), {
    forecast: {
      startDate: '2026-01-01',
      months: 25,
      fiscalYearStartMonth: 1,
      proration: 'actual_days',
    },
    spaces: [{ id: 'S1', code: 'Suite 100', area: '10000', spaceType: 'office' }],
    tenants: [{ id: 'T1', name: 'Fixture Tenant' }],
    leases: [
      {
        id: 'L1',
        tenantId: 'T1',
        spaceIds: ['S1'],
        status: 'occupied',
        area: '10000',
        commencementDate: '2026-01-01',
        expirationDate: '2030-12-31',
        baseRent: '10.00',
        baseRentBasis: 'per_area_per_year',
        escalation: {
          type: 'fixed_percent',
          rate: '0.05',
          capRate: '0.03',
          frequencyMonths: 12,
          compounding: true,
        },
      },
    ],
  });

  const result = calculate(model);

  it('escalates at the cap rather than the stated rate once the stated rate exceeds it', () => {
    // Hand-derived: $10.00/sf x 10,000 sf = $100,000/yr contract. The
    // escalation states 5%, but the 3% cap governs, compounding each
    // January: $100,000, then $103,000, then $106,090 — never the $105,000
    // and $110,250 an uncapped 5% would produce.
    expect(result.monthly.scheduledBaseRent[0]).toBe('8333.33');
    // Month 13 (index 12) is the first escalation: the second January.
    expect(Number(result.monthly.scheduledBaseRent[12])).toBeCloseTo(103_000 / 12, 2);
    // Month 25 (index 24) is the second escalation: the third January.
    expect(Number(result.monthly.scheduledBaseRent[24])).toBeCloseTo(106_090 / 12, 2);
  });

  it('never lets the capped rate reach what the stated 5% would have produced', () => {
    const uncapped5PercentYear2 = 105_000 / 12;
    const uncapped5PercentYear3 = 110_250 / 12;
    expect(Number(result.monthly.scheduledBaseRent[12])).toBeLessThan(uncapped5PercentYear2);
    expect(Number(result.monthly.scheduledBaseRent[24])).toBeLessThan(uncapped5PercentYear3);
  });
});

describe('escalation floors', () => {
  const model = extendModel(baseModel(), {
    forecast: {
      startDate: '2026-01-01',
      months: 25,
      fiscalYearStartMonth: 1,
      proration: 'actual_days',
    },
    spaces: [{ id: 'S1', code: 'Suite 100', area: '10000', spaceType: 'office' }],
    tenants: [{ id: 'T1', name: 'Fixture Tenant' }],
    leases: [
      {
        id: 'L1',
        tenantId: 'T1',
        spaceIds: ['S1'],
        status: 'occupied',
        area: '10000',
        commencementDate: '2026-01-01',
        expirationDate: '2030-12-31',
        baseRent: '10.00',
        baseRentBasis: 'per_area_per_year',
        // A negative index reading (a deflationary index year) would otherwise
        // reduce rent below the floor a landlord actually negotiated.
        escalation: {
          type: 'fixed_percent',
          rate: '-0.02',
          floorRate: '0.01',
          frequencyMonths: 12,
          compounding: true,
        },
      },
    ],
  });

  const result = calculate(model);

  it('escalates at the floor rather than a stated negative rate', () => {
    // Hand-derived: $100,000/yr contract. The stated rate is -2%, which
    // would reduce rent, but the 1% floor governs: $100,000, then $101,000.
    expect(result.monthly.scheduledBaseRent[0]).toBe('8333.33');
    expect(Number(result.monthly.scheduledBaseRent[12])).toBeCloseTo(101_000 / 12, 2);
  });
});

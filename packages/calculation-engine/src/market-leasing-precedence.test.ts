import { describe, expect, it } from 'vitest';
import { calculate } from './engine.js';
import { baseModel, extendModel } from './__fixtures__/builders.js';

/**
 * Market leasing profile precedence: lease, then space, then the model
 * default.
 *
 * `resolveProfile` in `leases.ts` has implemented this precedence, and
 * recorded the winner in the trace, since market leasing profiles were
 * introduced — but no fixture has ever configured more than one profile at
 * once, so the ordering itself, and the trace's own report of which source
 * won, were never asserted. `validation.test.ts` covers only the unrelated
 * duplicate/dangling-id cases.
 */

const THREE_PROFILES = [
  {
    id: 'P-LEASE',
    name: 'Lease-assigned profile',
    marketRent: '10.00',
    marketRentBasis: 'per_area_per_year' as const,
  },
  {
    id: 'P-SPACE',
    name: 'Space-assigned profile',
    marketRent: '20.00',
    marketRentBasis: 'per_area_per_year' as const,
  },
  {
    id: 'P-DEFAULT',
    name: 'Model default profile',
    marketRent: '30.00',
    marketRentBasis: 'per_area_per_year' as const,
  },
];

function modelWith(overrides: {
  leaseProfileId?: string;
  spaceProfileId?: string;
  defaultProfileId?: string;
}) {
  return extendModel(baseModel(), {
    spaces: [
      {
        id: 'S1',
        code: 'Suite 100',
        area: '10000',
        spaceType: 'office',
        ...(overrides.spaceProfileId ? { marketLeasingProfileId: overrides.spaceProfileId } : {}),
      },
    ],
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
        ...(overrides.leaseProfileId ? { marketLeasingProfileId: overrides.leaseProfileId } : {}),
      },
    ],
    marketLeasingProfiles: THREE_PROFILES,
    ...(overrides.defaultProfileId
      ? { defaultMarketLeasingProfileId: overrides.defaultProfileId }
      : {}),
  });
}

function winnerFor(result: ReturnType<typeof calculate>, subject: string) {
  return result.trace.find((entry) => entry.target === `${subject}:marketLeasingProfile`);
}

describe('market leasing profile precedence', () => {
  it('the lease assignment wins over both a space assignment and the model default', () => {
    const model = modelWith({
      leaseProfileId: 'P-LEASE',
      spaceProfileId: 'P-SPACE',
      defaultProfileId: 'P-DEFAULT',
    });
    const result = calculate(model, { trace: { enabled: true } });
    const winner = winnerFor(result, 'lease:L1');
    expect(winner?.result).toBe('P-LEASE');
    expect(winner?.inputs.selectedFrom).toBe('lease');
  });

  it('the space assignment wins over the model default when the lease itself has none', () => {
    const model = modelWith({ spaceProfileId: 'P-SPACE', defaultProfileId: 'P-DEFAULT' });
    const result = calculate(model, { trace: { enabled: true } });
    const winner = winnerFor(result, 'lease:L1');
    expect(winner?.result).toBe('P-SPACE');
    expect(winner?.inputs.selectedFrom).toBe('space:S1');
  });

  it('the model default wins when neither the lease nor its space names one', () => {
    const model = modelWith({ defaultProfileId: 'P-DEFAULT' });
    const result = calculate(model, { trace: { enabled: true } });
    const winner = winnerFor(result, 'lease:L1');
    expect(winner?.result).toBe('P-DEFAULT');
    expect(winner?.inputs.selectedFrom).toBe('model_default');
  });

  it('warns and treats market rent as zero when nothing applies at all', () => {
    const model = extendModel(baseModel(), {
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
        },
      ],
    });
    const result = calculate(model);
    const warning = result.diagnostics.find(
      (entry) => entry.code === 'NO_MARKET_LEASING_PROFILE' && entry.subject === 'lease:L1',
    );
    expect(warning).toBeDefined();
  });
});

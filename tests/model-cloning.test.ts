import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  authed,
  createTestContext,
  hasDatabase,
  registerActor,
  type Actor,
  type TestContext,
} from './helpers.js';

/**
 * Cloning a model.
 *
 * `POST /models/:id/clone` copies eleven tables inside one transaction and
 * remaps two foreign keys along the way (a lease's own market leasing
 * profile, and the model's default one) rather than a bare copy, because
 * `market_leasing_profiles` rows are model-scoped: the clone gets its own
 * rows with the same codes, and anything that pointed at the source's row by
 * id has to be repointed at the clone's row of the same code, not left
 * dangling or pointed back at the source. Exercised only incidentally
 * elsewhere (`tests/scenario-comparison.test.ts` clones a model and checks
 * the response is 201) — this is the first test of what actually got
 * copied, whether it copied correctly, and whether editing the clone
 * reaches back into the source.
 */
describe.skipIf(!hasDatabase)('model cloning', () => {
  let ctx: TestContext;
  let owner: Actor;
  let organizationId: string;
  let sourceId: string;
  let sourceProfileId: string;

  async function createOrganization(name: string): Promise<string> {
    const response = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/organizations',
      headers: authed(owner.cookie),
      payload: { name },
    });
    return (response.json() as { organization: { id: string } }).organization.id;
  }

  async function put(url: string, payload: unknown) {
    return ctx.app.inject({ method: 'PUT', url, headers: authed(owner.cookie), payload });
  }

  async function get(url: string) {
    return ctx.app.inject({ method: 'GET', url, headers: authed(owner.cookie) });
  }

  beforeAll(async () => {
    ctx = await createTestContext();
    owner = await registerActor(ctx.app, 'clone-owner@example.invalid', 'Clone Owner');
    organizationId = await createOrganization('Clone Test Partners');

    const property = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/properties',
      headers: authed(owner.cookie),
      payload: { name: 'Clone House', propertyType: 'office', rentableArea: '10000' },
    });
    const propertyId = (property.json() as { property: { id: string } }).property.id;
    await put(`/api/v1/properties/${propertyId}/spaces`, {
      spaces: [{ code: 'WHOLE', spaceType: 'office', area: '10000' }],
    });

    const tenant = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/tenants',
      headers: authed(owner.cookie),
      payload: { name: 'Acme Tenant' },
    });
    const tenantId = (tenant.json() as { tenant: { id: string } }).tenant.id;

    const model = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/models',
      headers: authed(owner.cookie),
      payload: {
        propertyId,
        name: 'Source model',
        classification: 'valuation',
        valuationDate: '2026-01-01',
        forecastStartDate: '2026-01-01',
        forecastMonths: 24,
        discountRate: '0.08',
        terminalCapRate: '0.07',
      },
    });
    sourceId = (model.json() as { model: { id: string } }).model.id;

    await put(`/api/v1/models/${sourceId}/growth-curves/cpi`, {
      name: 'CPI, 3%',
      defaultRate: '0.03',
      byYear: [],
    });

    const profile = await put(`/api/v1/models/${sourceId}/market-leasing/mlp-1`, {
      name: 'Office standard',
      marketRent: '28.00',
      marketRentBasis: 'per_area_per_year',
      renewalProbability: '0.5',
      downtimeMonths: 2,
    });
    sourceProfileId = (profile.json() as { item: { id: string } }).item.id;

    await put(`/api/v1/models/${sourceId}/expenses/insurance`, {
      name: 'Insurance',
      category: 'insurance',
      method: 'fixed_annual',
      amount: '42000',
      growthCurve: 'cpi',
    });
    await put(`/api/v1/models/${sourceId}/other-revenue/parking`, {
      name: 'Parking income',
      method: 'fixed_annual',
      amount: '12000',
    });
    await put(`/api/v1/models/${sourceId}/capital/roof`, {
      name: 'Roof replacement',
      category: 'major_project',
      method: 'one_time',
      amount: '250000',
    });
    await put(`/api/v1/models/${sourceId}/debt/senior`, {
      name: 'Senior loan',
      type: 'permanent',
      commitment: '5000000',
      fundingDate: '2026-01-01',
      termMonths: 120,
      rateType: 'fixed',
      fixedRate: '0.055',
    });
    await put(`/api/v1/models/${sourceId}/leases/L-1`, {
      tenantId,
      status: 'occupied',
      area: '10000',
      spaceIds: ['WHOLE'],
      commencementDate: '2026-01-01',
      expirationDate: '2030-12-31',
      baseRent: '30.00',
      baseRentBasis: 'per_area_per_year',
      rentSteps: [{ startDate: '2027-01-01', amount: '31.00', basis: 'per_area_per_year' }],
      marketLeasingProfileId: sourceProfileId,
    });

    // No API route sets a model's default leasing profile (only the seed
    // script does, directly); this is the one piece of setup that has to
    // reach past the API to exist at all.
    await ctx.sql`UPDATE models SET default_market_leasing_profile_id = ${sourceProfileId} WHERE id = ${sourceId}`;
  }, 90_000);

  afterAll(async () => {
    await ctx?.close();
  });

  it('refuses to clone a model in another organization, as not found', async () => {
    const outsider = await registerActor(ctx.app, 'clone-outsider@example.invalid', 'Outsider');
    const outsiderOrg = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/organizations',
      headers: authed(outsider.cookie),
      payload: { name: 'Outsider Partners' },
    });
    expect(outsiderOrg.statusCode).toBe(201);

    const response = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/models/${sourceId}/clone`,
      headers: authed(outsider.cookie),
      payload: { name: 'Should not exist' },
    });
    expect(response.statusCode).toBe(404);
  });

  describe('a real clone', () => {
    let cloneId: string;

    beforeAll(async () => {
      const response = await ctx.app.inject({
        method: 'POST',
        url: `/api/v1/models/${sourceId}/clone`,
        headers: authed(owner.cookie),
        payload: { name: 'Downside case' },
      });
      expect(response.statusCode, response.body).toBe(201);
      const body = response.json() as {
        model: {
          id: string;
          name: string;
          classification: string;
          status: string;
          default_market_leasing_profile_id: string | null;
        };
      };
      cloneId = body.model.id;

      expect(cloneId).not.toBe(sourceId);
      expect(body.model.name).toBe('Downside case');
      // Not supplied on this clone call, so it falls back to the source's own.
      expect(body.model.classification).toBe('valuation');
      // A clone always starts a fresh draft, whatever the source's own status is.
      expect(body.model.status).toBe('draft');
      expect(body.model.default_market_leasing_profile_id).not.toBeNull();
      expect(body.model.default_market_leasing_profile_id).not.toBe(sourceProfileId);
    });

    it('copies the growth curve', async () => {
      const response = await get(`/api/v1/models/${cloneId}/growth-curves`);
      const items = (response.json() as { items: Array<Record<string, unknown>> }).items;
      expect(items).toHaveLength(1);
      expect(items[0]?.code).toBe('cpi');
      expect(items[0]?.default_rate).toBe('0.03000000');
    });

    it('copies the market leasing profile under a new row, same code', async () => {
      const response = await get(`/api/v1/models/${cloneId}/market-leasing`);
      const items = (response.json() as { items: Array<Record<string, unknown>> }).items;
      expect(items).toHaveLength(1);
      expect(items[0]?.code).toBe('mlp-1');
      expect(items[0]?.market_rent).toBe('28.000000');
      // A real new row, not a shared reference to the source's.
      expect(items[0]?.id).not.toBe(sourceProfileId);
    });

    it('copies the expense, its growth-curve reference intact by code', async () => {
      const response = await get(`/api/v1/models/${cloneId}/expenses`);
      const items = (response.json() as { items: Array<Record<string, unknown>> }).items;
      expect(items).toHaveLength(1);
      expect(items[0]?.code).toBe('insurance');
      expect(items[0]?.amount).toBe('42000.000000');
      expect(items[0]?.growth_curve).toBe('cpi');
    });

    it('copies the other-revenue item, the capital item and the debt facility', async () => {
      const [otherRevenue, capital, debt] = await Promise.all([
        get(`/api/v1/models/${cloneId}/other-revenue`),
        get(`/api/v1/models/${cloneId}/capital`),
        get(`/api/v1/models/${cloneId}/debt`),
      ]);
      expect(
        (otherRevenue.json() as { items: Array<Record<string, unknown>> }).items.map((i) => i.code),
      ).toEqual(['parking']);
      expect(
        (capital.json() as { items: Array<Record<string, unknown>> }).items.map((i) => i.code),
      ).toEqual(['roof']);
      expect(
        (debt.json() as { items: Array<Record<string, unknown>> }).items.map((i) => i.code),
      ).toEqual(['senior']);
    });

    it('copies the lease with its rent steps and spaces, market-leasing reference remapped to the clone', async () => {
      const response = await get(`/api/v1/models/${cloneId}/leases`);
      const leases = (response.json() as { leases: Array<Record<string, unknown>> }).leases;
      expect(leases).toHaveLength(1);
      const lease = leases[0] as Record<string, unknown>;
      expect(lease.code).toBe('L-1');
      expect(lease.tenant_name).toBe('Acme Tenant');
      expect(lease.space_codes).toEqual(['WHOLE']);
      expect(lease.rent_steps).toEqual([
        { startDate: '2027-01-01', amount: '31.000000', basis: 'per_area_per_year' },
      ]);

      // The clone's own profile row for the same code, not the source's.
      const profiles = await get(`/api/v1/models/${cloneId}/market-leasing`);
      const cloneProfileId = (
        (profiles.json() as { items: Array<Record<string, unknown>> }).items[0] as {
          id: string;
        }
      ).id;
      expect(lease.market_leasing_profile_id).toBe(cloneProfileId);
      expect(lease.market_leasing_profile_id).not.toBe(sourceProfileId);
    });

    it('is independent: editing the clone does not touch the source', async () => {
      const before = (
        (await get(`/api/v1/models/${cloneId}/leases`)).json() as {
          leases: Array<{ tenant_id: string }>;
        }
      ).leases;
      const tenantId = before[0]?.tenant_id;

      await put(`/api/v1/models/${cloneId}/leases/L-1`, {
        tenantId,
        status: 'occupied',
        area: '10000',
        spaceIds: ['WHOLE'],
        commencementDate: '2026-01-01',
        expirationDate: '2030-12-31',
        baseRent: '99.00',
        baseRentBasis: 'per_area_per_year',
      });

      const cloneLeases = (
        (await get(`/api/v1/models/${cloneId}/leases`)).json() as {
          leases: Array<Record<string, unknown>>;
        }
      ).leases;
      expect(cloneLeases[0]?.base_rent).toBe('99.000000');

      const sourceLeases = (
        (await get(`/api/v1/models/${sourceId}/leases`)).json() as {
          leases: Array<Record<string, unknown>>;
        }
      ).leases;
      expect(sourceLeases[0]?.base_rent).toBe('30.000000');
    });

    it('records an audit entry naming what it was cloned from', async () => {
      const rows = await ctx.sql`
        SELECT entity_id, metadata FROM audit_log
        WHERE organization_id = ${organizationId} AND action = 'model.cloned' AND entity_id = ${cloneId}
      `;
      expect(rows).toHaveLength(1);
      expect((rows[0] as { metadata: { clonedFrom: string } }).metadata.clonedFrom).toBe(sourceId);
    });
  });
});

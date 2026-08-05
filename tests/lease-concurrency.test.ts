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
 * Optimistic concurrency control on leases.
 *
 * The concurrency test measured ten simultaneous writes to one lease: all ten
 * succeeded and the last one won, so an analyst's work vanished without anyone
 * being told. A lease decides what a property is worth; losing an edit silently
 * is not an acceptable way to resolve a collision.
 *
 * A caller that read the lease sends the version it saw. If the stored version
 * has moved, the write is refused with 409 and the current version, so the
 * client can show what changed instead of guessing.
 */
describe.skipIf(!hasDatabase)('lease optimistic locking', () => {
  let ctx: TestContext;
  let owner: Actor;
  let modelId: string;
  let tenantId: string;

  beforeAll(async () => {
    ctx = await createTestContext();
    owner = await registerActor(ctx.app, 'lease-lock@example.invalid', 'Lease Lock');

    await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/organizations',
      headers: authed(owner.cookie),
      payload: { name: 'Marlowe Estates' },
    });

    const property = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/properties',
      headers: authed(owner.cookie),
      payload: { name: 'Marlowe House', propertyType: 'office', rentableArea: '10000' },
    });
    const propertyId = (property.json() as { property: { id: string } }).property.id;

    const model = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/models',
      headers: authed(owner.cookie),
      payload: {
        propertyId,
        name: 'Base case',
        classification: 'valuation',
        valuationDate: '2026-01-01',
        forecastStartDate: '2026-01-01',
        forecastMonths: 24,
        discountRate: '0.08',
        terminalCapRate: '0.07',
        saleMonth: 24,
      },
    });
    modelId = (model.json() as { model: { id: string } }).model.id;

    const tenant = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/tenants',
      headers: authed(owner.cookie),
      payload: { name: 'Marlowe Tenant' },
    });
    tenantId = (tenant.json() as { tenant: { id: string } }).tenant.id;
  }, 60_000);

  afterAll(async () => {
    await ctx?.close();
  });

  function payload(rent: string, expectedVersion?: number | null): Record<string, unknown> {
    return {
      tenantId,
      status: 'occupied',
      area: '10000',
      spaceIds: [],
      commencementDate: '2026-01-01',
      expirationDate: '2031-12-31',
      baseRent: rent,
      baseRentBasis: 'per_area_per_year',
      ...(expectedVersion === undefined ? {} : { expectedVersion }),
    };
  }

  async function save(
    code: string,
    rent: string,
    expectedVersion?: number | null,
  ): Promise<{ statusCode: number; body: string }> {
    const response = await ctx.app.inject({
      method: 'PUT',
      url: `/api/v1/models/${modelId}/leases/${code}`,
      headers: authed(owner.cookie),
      payload: payload(rent, expectedVersion),
    });
    return { statusCode: response.statusCode, body: response.body };
  }

  async function read(code: string): Promise<{ version: number; base_rent: string }> {
    const response = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/models/${modelId}/leases`,
      headers: authed(owner.cookie),
    });
    const body = response.json() as {
      leases: Array<{ code: string; version: number; base_rent: string }>;
    };
    const lease = body.leases.find((entry) => entry.code === code);
    if (!lease) throw new Error(`Lease ${code} not found`);
    return lease;
  }

  /* ---------------------------------------------------------------------- */

  it('starts a new lease at version 1 and increments on each write', async () => {
    await save('L-VERSION', '30.00');
    expect((await read('L-VERSION')).version).toBe(1);

    await save('L-VERSION', '31.00', 1);
    expect((await read('L-VERSION')).version).toBe(2);

    await save('L-VERSION', '32.00', 2);
    const after = await read('L-VERSION');
    expect(after.version).toBe(3);
    expect(after.base_rent).toBe('32.000000');
  });

  it('refuses a write whose version has been overtaken', async () => {
    await save('L-STALE', '30.00');
    const opened = await read('L-STALE');

    // Someone else saves while this editor is open.
    const theirs = await save('L-STALE', '45.00', opened.version);
    expect(theirs.statusCode).toBe(200);

    // The stale editor now tries to save the version it opened.
    const mine = await save('L-STALE', '99.00', opened.version);
    expect(mine.statusCode).toBe(409);
    expect(mine.body).toContain('changed by someone else');

    // Their figure survives. Nothing was written over.
    const current = await read('L-STALE');
    expect(current.base_rent).toBe('45.000000');
    expect(current.version).toBe(2);
  });

  it('reports the current version so the client can show what changed', async () => {
    await save('L-REPORT', '30.00');
    await save('L-REPORT', '40.00', 1);

    const stale = await save('L-REPORT', '50.00', 1);
    const error = JSON.parse(stale.body) as {
      error: { code: string; details: { expectedVersion: number; currentVersion: number } };
    };
    expect(error.error.code).toBe('LEASE_VERSION_CONFLICT');
    expect(error.error.details.expectedVersion).toBe(1);
    expect(error.error.details.currentVersion).toBe(2);
  });

  it('lets exactly one of two simultaneous writers win', async () => {
    // The case the concurrency test found: two editors that both read version 1
    // and both save. Before this, both succeeded and one analyst's work
    // disappeared. Now one is refused and told why.
    await save('L-RACE', '30.00');

    const [first, second] = await Promise.all([
      save('L-RACE', '60.00', 1),
      save('L-RACE', '70.00', 1),
    ]);
    const statuses = [first.statusCode, second.statusCode].sort();
    expect(statuses).toEqual([200, 409]);

    const current = await read('L-RACE');
    expect(current.version).toBe(2);
    // Whichever won, the surviving rent is one of the two that were attempted —
    // not a blend, and not the pre-existing value.
    expect(['60.000000', '70.000000']).toContain(current.base_rent);
  });

  it('accepts a write with no version, which is what bulk import needs', async () => {
    // Import is a deliberate "replace these rows" and has nothing to have read.
    // Opting out has to stay possible, but it has to be explicit.
    await save('L-IMPORT', '30.00');
    await save('L-IMPORT', '40.00', 1);

    const forced = await save('L-IMPORT', '55.00');
    expect(forced.statusCode).toBe(200);
    expect((await read('L-IMPORT')).base_rent).toBe('55.000000');
  });

  it('ignores a version supplied when creating a lease that does not exist', async () => {
    // Nobody can have changed a lease that was never there, so a stale version
    // on a creation is not a conflict.
    const created = await save('L-BRAND-NEW', '30.00', 7);
    expect(created.statusCode).toBe(200);
    expect((await read('L-BRAND-NEW')).version).toBe(1);
  });

  /* ---------------------------------------------------------------------- */
  /* Models                                                                  */
  /* ---------------------------------------------------------------------- */

  describe('on a model', () => {
    async function patch(
      discountRate: string,
      expectedVersion?: number,
    ): Promise<{ statusCode: number; body: string }> {
      const response = await ctx.app.inject({
        method: 'PATCH',
        url: `/api/v1/models/${modelId}`,
        headers: authed(owner.cookie),
        payload: {
          discountRate,
          ...(expectedVersion === undefined ? {} : { expectedVersion }),
        },
      });
      return { statusCode: response.statusCode, body: response.body };
    }

    async function version(): Promise<number> {
      const response = await ctx.app.inject({
        method: 'GET',
        url: `/api/v1/models/${modelId}`,
        headers: authed(owner.cookie),
      });
      return (response.json() as { model: { version: number } }).model.version;
    }

    it('refuses an assumption change whose version has been overtaken', async () => {
      // A discount rate moves every figure in the valuation at once, so two
      // people adjusting assumptions simultaneously is the collision most worth
      // refusing.
      const opened = await version();

      const theirs = await patch('0.09', opened);
      expect(theirs.statusCode).toBe(200);
      expect(await version()).toBe(opened + 1);

      const mine = await patch('0.11', opened);
      expect(mine.statusCode).toBe(409);
      const error = JSON.parse(mine.body) as { error: { code: string } };
      expect(error.error.code).toBe('MODEL_VERSION_CONFLICT');
    });

    it('lets exactly one of two simultaneous assumption writers win', async () => {
      const opened = await version();
      const [first, second] = await Promise.all([patch('0.07', opened), patch('0.12', opened)]);
      expect([first.statusCode, second.statusCode].sort()).toEqual([200, 409]);
      expect(await version()).toBe(opened + 1);
    });

    it('accepts a change with no version, for scripted callers', async () => {
      const before = await version();
      const forced = await patch('0.085');
      expect(forced.statusCode).toBe(200);
      expect(await version()).toBe(before + 1);
    });
  });
});

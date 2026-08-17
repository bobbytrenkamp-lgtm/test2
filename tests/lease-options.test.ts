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
 * Lease options through the API.
 *
 * The engine has simulated renewal, termination and contraction as
 * probability-weighted branches since `lease-options.ts` was written
 * (`packages/calculation-engine/src/lease-options.test.ts` covers the
 * branching itself), and `leaseOptionSchema` has always described the full
 * shape — but the write route accepted `z.array(z.record(z.unknown()))`,
 * which is to say it accepted anything at all and validated nothing. These
 * tests are about the boundary now that it actually checks the shape: a
 * well-formed option of any of the seven named types is accepted and reads
 * back exactly (expansion/purchase/ROFR/ROFO are real values the schema has
 * always allowed, even though the engine itself still declines to simulate
 * them — that refusal is `lease-options.ts`'s to make, not this route's),
 * and a malformed one is refused rather than silently stored.
 */
describe.skipIf(!hasDatabase)('lease options through the API', () => {
  let ctx: TestContext;
  let owner: Actor;
  let modelId: string;
  let tenantId: string;

  beforeAll(async () => {
    ctx = await createTestContext();
    owner = await registerActor(ctx.app, 'lease-options@example.invalid', 'Lease Options');

    await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/organizations',
      headers: authed(owner.cookie),
      payload: { name: 'Millbrook Partners' },
    });

    const property = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/properties',
      headers: authed(owner.cookie),
      payload: { name: 'Millbrook Plaza', propertyType: 'office', rentableArea: '30000' },
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
      payload: { name: 'Millbrook Tenant' },
    });
    tenantId = (tenant.json() as { tenant: { id: string } }).tenant.id;
  }, 60_000);

  afterAll(async () => {
    await ctx?.close();
  });

  function put(code: string, options: unknown[]) {
    return ctx.app.inject({
      method: 'PUT',
      url: `/api/v1/models/${modelId}/leases/${code}`,
      headers: authed(owner.cookie),
      payload: {
        tenantId,
        status: 'occupied',
        area: '5000',
        spaceIds: [],
        commencementDate: '2026-01-01',
        expirationDate: '2030-12-31',
        baseRent: '30.00',
        baseRentBasis: 'per_area_per_year',
        options,
      },
    });
  }

  async function readOptions(code: string): Promise<Array<Record<string, unknown>>> {
    const response = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/models/${modelId}/leases`,
      headers: authed(owner.cookie),
    });
    const lease = (
      response.json() as {
        leases: Array<{ code: string; options: Array<Record<string, unknown>> }>;
      }
    ).leases.find((entry) => entry.code === code);
    if (!lease) throw new Error(`Lease ${code} not found`);
    return lease.options;
  }

  it('saves a renewal option and reads it back exactly', async () => {
    const option = {
      id: 'opt-renew-1',
      type: 'renewal',
      exerciseDate: '2029-12-31',
      probability: '0.6',
      termMonths: 60,
      rentMethod: 'fixed',
      rentAmount: '32.00',
      rentBasis: 'per_area_per_year',
      cost: '5.00',
      areaChange: '0',
    };
    const response = await put('L-RENEW', [option]);
    expect(response.statusCode, response.body).toBe(200);
    expect(await readOptions('L-RENEW')).toEqual([option]);
  });

  it('saves termination and contraction options on the same lease', async () => {
    const options = [
      {
        id: 'opt-term-1',
        type: 'termination',
        exerciseDate: '2028-06-30',
        probability: '0.2',
        termMonths: 0,
        rentMethod: 'market',
        rentAmount: null,
        rentBasis: null,
        cost: '-15.00',
        areaChange: '0',
      },
      {
        id: 'opt-contract-1',
        type: 'contraction',
        exerciseDate: '2027-06-30',
        probability: '0.15',
        termMonths: 0,
        rentMethod: 'market',
        rentAmount: null,
        rentBasis: null,
        cost: '2.50',
        areaChange: '1000',
      },
    ];
    const response = await put('L-MULTI', options);
    expect(response.statusCode, response.body).toBe(200);
    expect(await readOptions('L-MULTI')).toEqual(options);
  });

  it('accepts a purchase option — a real value the schema names, even though the engine does not simulate it', async () => {
    // `LEASE_OPTION_NOT_MODELLED` is the engine's own refusal
    // (`packages/calculation-engine/src/lease-options.ts`), not this
    // route's. Tightening `options` from an unchecked record to the real
    // schema must not narrow what the schema itself has always allowed.
    const option = {
      id: 'opt-purchase-1',
      type: 'purchase',
      exerciseDate: '2029-01-01',
      probability: '0.1',
      termMonths: 0,
      rentMethod: 'market',
      rentAmount: null,
      rentBasis: null,
      cost: '0',
      areaChange: '0',
    };
    const response = await put('L-PURCHASE', [option]);
    expect(response.statusCode, response.body).toBe(200);
    expect(await readOptions('L-PURCHASE')).toEqual([option]);
  });

  it('refuses an option missing its exercise date', async () => {
    const response = await put('L-BAD', [{ id: 'opt-bad-1', type: 'renewal', probability: '0.5' }]);
    expect(response.statusCode).toBe(400);
  });

  it('refuses an option naming a type the schema does not recognise', async () => {
    const response = await put('L-BAD-TYPE', [
      { id: 'opt-bad-2', type: 'right_of_first_refusal', exerciseDate: '2029-01-01' },
    ]);
    expect(response.statusCode).toBe(400);
  });
});

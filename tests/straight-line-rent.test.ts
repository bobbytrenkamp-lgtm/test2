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
 * `GET /models/:id/leases/:leaseId/straight-line-rent` through the API.
 *
 * The straight-line arithmetic itself is covered, fully hand-derived and
 * independent of the engine, in
 * `packages/calculation-engine/src/straight-line-rent.test.ts`. This file
 * covers the server glue: that the route reaches the right lease's own
 * stored monthly rent, restricted to the periods it is actually in effect,
 * and combines `baseRent`/`freeRent` in the sign convention the engine
 * actually uses (`freeRent` is stored negative, so the net amount billed is
 * the *sum*, not the difference — confirmed independently below rather than
 * assumed).
 */
describe.skipIf(!hasDatabase)('straight-line rent', () => {
  let ctx: TestContext;
  let owner: Actor;
  let propertyId: string;
  let modelId: string;
  let tenantId: string;

  beforeAll(async () => {
    ctx = await createTestContext();
    owner = await registerActor(ctx.app, 'straight-line-owner@example.invalid', 'SLR Owner');

    await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/organizations',
      headers: authed(owner.cookie),
      payload: { name: 'Ledger Point Holdings' },
    });

    const property = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/properties',
      headers: authed(owner.cookie),
      payload: { name: 'Ledger Point', propertyType: 'office', rentableArea: '50000' },
    });
    propertyId = (property.json() as { property: { id: string } }).property.id;
    await ctx.app.inject({
      method: 'PUT',
      url: `/api/v1/properties/${propertyId}/spaces`,
      headers: authed(owner.cookie),
      payload: { spaces: [{ code: 'WHOLE', area: '50000', spaceType: 'office' }] },
    });

    const tenant = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/tenants',
      headers: authed(owner.cookie),
      payload: { propertyId, name: 'Ledger Point Tenant' },
    });
    tenantId = (tenant.json() as { tenant: { id: string } }).tenant.id;

    const model = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/models',
      headers: authed(owner.cookie),
      payload: {
        propertyId,
        name: 'Base case',
        classification: 'acquisition',
        valuationDate: '2026-01-01',
        forecastStartDate: '2026-01-01',
        forecastMonths: 24,
        saleMonth: 24,
        acquisitionPrice: '10000000',
      },
    });
    modelId = (model.json() as { model: { id: string } }).model.id;

    // 50,000 sf at $20.00/sf/yr ($1,000,000/yr, $83,333.33/mo) for year one,
    // stepping to $24.00/sf/yr ($1,200,000/yr, $100,000.00/mo exactly) for
    // year two — the same lease shape `tests/vertical-slice.test.ts` already
    // confirms produces exactly these monthly figures. One month free at the
    // start, so the sign convention combining `baseRent` and `freeRent` is
    // actually exercised rather than trivially true at zero free rent.
    await ctx.app.inject({
      method: 'PUT',
      url: `/api/v1/models/${modelId}/leases/L-1`,
      headers: authed(owner.cookie),
      payload: {
        tenantId,
        status: 'occupied',
        area: '50000',
        spaceIds: ['WHOLE'],
        commencementDate: '2026-01-01',
        expirationDate: '2035-12-31',
        baseRent: '20.00',
        baseRentBasis: 'per_area_per_year',
        rentSteps: [{ startDate: '2027-01-01', amount: '24.00', basis: 'per_area_per_year' }],
        freeRent: [{ startDate: '2026-01-01', months: 1 }],
        escalation: { type: 'none' },
        recovery: { method: 'none' },
        excludeFromRollover: true,
      },
    });

    await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/models/${modelId}/calculate`,
      headers: authed(owner.cookie),
    });
  }, 60_000);

  afterAll(async () => {
    await ctx?.close();
  });

  it('straight-lines the stepped rent across the full 24-month forecast', async () => {
    const response = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/models/${modelId}/leases/L-1/straight-line-rent`,
      headers: authed(owner.cookie),
    });
    expect(response.statusCode).toBe(200);
    const body = response.json() as {
      leaseId: string;
      periodIndices: number[];
      straightLineMonthlyRent: string;
      recognizedRent: string[];
      actualRent: string[];
      deferredRentBalance: string[];
    };

    expect(body.leaseId).toBe('L-1');
    // Present for all 24 months: a sole tenant occupying the whole building
    // for the whole term.
    expect(body.periodIndices).toHaveLength(24);
    expect(body.periodIndices[0]).toBe(1);
    expect(body.periodIndices[23]).toBe(24);

    // Sign convention, confirmed independently: `freeRent` is stored signed
    // negative (an abatement credit). Month 1 is fully free, so the actual
    // amount billed is baseRent (83,333.33) + freeRent (-83,333.33) = 0 — if
    // the route instead subtracted freeRent, this would read 166,666.66
    // instead, double-counting the abatement rather than applying it.
    expect(body.actualRent[0]).toBe('0');
    expect(body.actualRent[1]).toBe('83333.33');
    expect(body.actualRent[12]).toBe('100000');

    // Hand-derived (independent of computeStraightLineRent, via plain
    // arithmetic on the same monthly figures vertical-slice.test.ts already
    // confirms, adjusted for one free month): 0 + 11 x 83,333.33 +
    // 12 x 100,000.00 = 2,116,666.63 total; / 24 = 88,194.4429..., which
    // rounds to 88,194.44. 23 periods at 88,194.44 leaves
    // 2,116,666.63 - 2,028,472.12 = 88,194.51 for the last period.
    expect(body.straightLineMonthlyRent).toBe('88194.44');
    expect(body.recognizedRent[0]).toBe('88194.44');
    expect(body.recognizedRent[11]).toBe('88194.44');
    expect(body.recognizedRent[12]).toBe('88194.44');
    expect(body.recognizedRent[23]).toBe('88194.51');

    // Deferred rent balance: an asset from month one (recognising 88,194.44
    // against nothing actually billed in the free month), growing through
    // year one, then unwinding once the step lands. Month 1: 88,194.44 - 0 =
    // 88,194.44. End of year one (index 11): 88,194.44 (month 1) +
    // 11 x (88,194.44 - 83,333.33) = 88,194.44 + 53,472.21 = 141,666.65.
    // Month 13 (index 12): 141,666.65 + (88,194.44 - 100,000.00) =
    // 129,861.09. Ends at exactly zero by construction.
    expect(body.deferredRentBalance[0]).toBe('88194.44');
    expect(body.deferredRentBalance[11]).toBe('141666.65');
    expect(body.deferredRentBalance[12]).toBe('129861.09');
    expect(body.deferredRentBalance[23]).toBe('0');
  });

  it('404s for a lease id the model does not have', async () => {
    const response = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/models/${modelId}/leases/NOPE/straight-line-rent`,
      headers: authed(owner.cookie),
    });
    expect(response.statusCode).toBe(404);
  });

  it("404s for a model outside the caller's organization", async () => {
    const stranger = await registerActor(
      ctx.app,
      'straight-line-stranger@example.invalid',
      'Stranger',
    );
    await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/organizations',
      headers: authed(stranger.cookie),
      payload: { name: 'Unrelated Holdings' },
    });

    const response = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/models/${modelId}/leases/L-1/straight-line-rent`,
      headers: authed(stranger.cookie),
    });
    expect(response.statusCode).toBe(404);
  });

  it('cannot be reached without a session', async () => {
    const response = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/models/${modelId}/leases/L-1/straight-line-rent`,
    });
    expect(response.statusCode).toBe(401);
  });
});

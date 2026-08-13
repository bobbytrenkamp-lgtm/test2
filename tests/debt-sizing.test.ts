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
 * `POST /models/:id/debt/size` through the API.
 *
 * The sizing arithmetic itself is covered, hand-derived, in
 * `packages/calculation-engine/src/debt-sizing.test.ts`. This file covers
 * the server glue instead: that the route requires the model to exist in the
 * caller's own organization, that it needs no stored calculation (unlike
 * `/health` and `/drivers`, which both read one), and that a value it is
 * handed reaches `sizeLoan` unchanged.
 */
describe.skipIf(!hasDatabase)('loan sizing', () => {
  let ctx: TestContext;
  let owner: Actor;
  let modelId: string;

  beforeAll(async () => {
    ctx = await createTestContext();
    owner = await registerActor(ctx.app, 'loan-sizing-owner@example.invalid', 'Loan Sizing Owner');

    await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/organizations',
      headers: authed(owner.cookie),
      payload: { name: 'Marsh Point Capital' },
    });

    const property = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/properties',
      headers: authed(owner.cookie),
      payload: { name: 'Marsh Point', propertyType: 'office', rentableArea: '120000' },
    });
    const propertyId = (property.json() as { property: { id: string } }).property.id;

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
        forecastMonths: 60,
        saleMonth: 60,
      },
    });
    modelId = (model.json() as { model: { id: string } }).model.id;
  }, 60_000);

  afterAll(async () => {
    await ctx?.close();
  });

  it('sizes a loan against a single constraint, with no calculation run first', async () => {
    // A freshly created model has never been calculated — unlike /health and
    // /drivers, this route needs no stored result to size against.
    const response = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/models/${modelId}/debt/size`,
      headers: authed(owner.cookie),
      payload: {
        sizingNoi: '1000000',
        propertyValue: '10000000',
        annualRate: '0.06',
        amortizationMonths: 360,
        maximumLtv: '0.65',
      },
    });
    expect(response.statusCode).toBe(200);
    // Hand-derived: 10,000,000 x 0.65 = 6,500,000.
    const body = response.json() as { sizedAmount: string; bindingConstraints: string[] };
    expect(body.sizedAmount).toBe('6500000');
    expect(body.bindingConstraints).toEqual(['maximum_ltv']);
  });

  it('binds on the smallest of several constraints passed together', async () => {
    const response = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/models/${modelId}/debt/size`,
      headers: authed(owner.cookie),
      payload: {
        sizingNoi: '1000000',
        propertyValue: '10000000',
        totalCost: '9000000',
        annualRate: '0.05',
        amortizationMonths: 0,
        minimumDscr: '1.25',
        maximumLtv: '0.65',
        maximumLtc: '0.70',
        minimumDebtYield: '0.08',
      },
    });
    expect(response.statusCode).toBe(200);
    // Hand-derived, same figures as the engine-level test: LTV -> 6,500,000,
    // LTC -> 6,300,000, debt yield -> 12,500,000, interest-only DSCR ->
    // 16,000,000. The smallest is the LTC constraint.
    const body = response.json() as { sizedAmount: string; bindingConstraints: string[] };
    expect(body.sizedAmount).toBe('6300000');
    expect(body.bindingConstraints).toEqual(['maximum_ltc']);
  });

  it('404s for a model outside the caller’s organization', async () => {
    const stranger = await registerActor(
      ctx.app,
      'loan-sizing-stranger@example.invalid',
      'Stranger',
    );
    await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/organizations',
      headers: authed(stranger.cookie),
      payload: { name: 'Unrelated Holdings' },
    });

    const response = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/models/${modelId}/debt/size`,
      headers: authed(stranger.cookie),
      payload: { sizingNoi: '1000000', annualRate: '0.06', amortizationMonths: 360 },
    });
    expect(response.statusCode).toBe(404);
  });

  it('cannot be reached without a session', async () => {
    const response = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/models/${modelId}/debt/size`,
      // The CSRF header alone, no cookie — isolates this from the 403 a
      // missing X-Requested-With would produce first, which is covered
      // separately by every state-changing route in route-inventory.test.ts.
      headers: { 'x-requested-with': 'cre-platform' },
      payload: { sizingNoi: '1000000', annualRate: '0.06', amortizationMonths: 360 },
    });
    expect(response.statusCode).toBe(401);
  });

  it('rejects a malformed body rather than sizing against garbage', async () => {
    const response = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/models/${modelId}/debt/size`,
      headers: authed(owner.cookie),
      // amortizationMonths must be an integer; sizingNoi and annualRate are required.
      payload: { amortizationMonths: 'not-a-number' },
    });
    expect(response.statusCode).toBe(400);
  });
});

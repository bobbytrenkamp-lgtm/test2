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
 * `POST /models/:id/cost-approach` through the API.
 *
 * The depreciation and reconciliation arithmetic itself is covered,
 * hand-derived, in `packages/calculation-engine/src/cost-approach.test.ts`.
 * This file covers the server glue: that the route requires the model to
 * exist in the caller's own organization, that it needs no stored
 * calculation, that a malformed value is rejected before it reaches the
 * calculator, and that a value it is handed reaches `computeCostApproach`
 * unchanged.
 */
describe.skipIf(!hasDatabase)('cost approach', () => {
  let ctx: TestContext;
  let owner: Actor;
  let modelId: string;

  beforeAll(async () => {
    ctx = await createTestContext();
    owner = await registerActor(
      ctx.app,
      'cost-approach-owner@example.invalid',
      'Cost Approach Owner',
    );

    await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/organizations',
      headers: authed(owner.cookie),
      payload: { name: 'Replacement Cost Capital' },
    });

    const property = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/properties',
      headers: authed(owner.cookie),
      payload: { name: 'Replacement Cost Building', propertyType: 'office', rentableArea: '50000' },
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

  it('reconciles land and depreciated improvements to an indicated value, with no calculation run first', async () => {
    const response = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/models/${modelId}/cost-approach`,
      headers: authed(owner.cookie),
      payload: {
        landValue: '1500000',
        entrepreneurialProfitPercent: '0.10',
        improvements: [
          {
            id: 'A',
            replacementCostNew: '8000000',
            physicalDeterioration: '0.10',
            functionalObsolescence: '0.05',
            externalObsolescence: '0.02',
          },
          { id: 'B', replacementCostNew: '2000000', physicalDeterioration: '0.20' },
        ],
      },
    });
    expect(response.statusCode).toBe(200);
    // Hand-derived, matching the engine-level test: 8,240,000 total
    // depreciated cost + 1,000,000 entrepreneurial profit + 1,500,000 land.
    const body = response.json() as { totalDepreciatedCost: string; indicatedValue: string };
    expect(body.totalDepreciatedCost).toBe('8240000');
    expect(body.indicatedValue).toBe('10740000');
  });

  it('values raw land with no improvements at all', async () => {
    const response = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/models/${modelId}/cost-approach`,
      headers: authed(owner.cookie),
      payload: { landValue: '1200000', improvements: [] },
    });
    expect(response.statusCode).toBe(200);
    const body = response.json() as { indicatedValue: string };
    expect(body.indicatedValue).toBe('1200000');
  });

  it('rejects a non-numeric replacement cost before it reaches the calculator', async () => {
    const response = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/models/${modelId}/cost-approach`,
      headers: authed(owner.cookie),
      payload: {
        landValue: '0',
        improvements: [{ id: 'A', replacementCostNew: 'not-a-number' }],
      },
    });
    expect(response.statusCode).toBe(400);
  });

  it('rejects a negative land value', async () => {
    const response = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/models/${modelId}/cost-approach`,
      headers: authed(owner.cookie),
      payload: { landValue: '-1', improvements: [] },
    });
    expect(response.statusCode).toBe(400);
    const body = response.json() as { error: { message: string } };
    expect(body.error.message).toContain('landValue');
  });

  it('404s for a model outside the caller’s organization', async () => {
    const stranger = await registerActor(
      ctx.app,
      'cost-approach-stranger@example.invalid',
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
      url: `/api/v1/models/${modelId}/cost-approach`,
      headers: authed(stranger.cookie),
      payload: { landValue: '0', improvements: [] },
    });
    expect(response.statusCode).toBe(404);
  });

  it('cannot be reached without a session', async () => {
    const response = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/models/${modelId}/cost-approach`,
      headers: { 'x-requested-with': 'cre-platform' },
      payload: { landValue: '0', improvements: [] },
    });
    expect(response.statusCode).toBe(401);
  });
});

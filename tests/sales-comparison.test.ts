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
 * `POST /models/:id/sales-comparison` through the API.
 *
 * The reconciliation arithmetic itself is covered, hand-derived, in
 * `packages/calculation-engine/src/sales-comparison.test.ts`. This file
 * covers the server glue: that the route requires the model to exist in the
 * caller's own organization, that it needs no stored calculation (unlike
 * `/health` and `/drivers`), that a malformed adjustment value is rejected
 * before it reaches the calculator, and that a value it is handed reaches
 * `computeSalesComparison` unchanged.
 */
describe.skipIf(!hasDatabase)('sales comparison approach', () => {
  let ctx: TestContext;
  let owner: Actor;
  let modelId: string;

  beforeAll(async () => {
    ctx = await createTestContext();
    owner = await registerActor(
      ctx.app,
      'sales-comparison-owner@example.invalid',
      'Sales Comparison Owner',
    );

    await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/organizations',
      headers: authed(owner.cookie),
      payload: { name: 'Comparable Sales Capital' },
    });

    const property = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/properties',
      headers: authed(owner.cookie),
      payload: { name: 'Comparable Sales Building', propertyType: 'office', rentableArea: '50000' },
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

  it('reconciles a set of comparables to an indicated value, with no calculation run first', async () => {
    const response = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/models/${modelId}/sales-comparison`,
      headers: authed(owner.cookie),
      payload: {
        subjectUnitsOfComparison: '50000',
        comparables: [
          {
            id: 'A',
            salePrice: '5000000',
            unitsOfComparison: '50000',
            adjustments: {
              marketConditions: '0.02',
              location: '-0.01',
              physicalCharacteristics: '0.03',
            },
          },
          {
            id: 'B',
            salePrice: '4500000',
            unitsOfComparison: '45000',
            adjustments: { marketConditions: '0.01', conditionQuality: '-0.02' },
          },
        ],
      },
    });
    expect(response.statusCode).toBe(200);
    // Hand-derived, matching the engine-level test: adjusted prices 104 and
    // 99 per SF, equal-weighted average 101.50, x 50,000 SF = 5,075,000.
    const body = response.json() as { indicatedValuePerUnit: string; indicatedValue: string };
    expect(body.indicatedValuePerUnit).toBe('101.5');
    expect(body.indicatedValue).toBe('5075000');
  });

  it('rejects a non-numeric adjustment before it reaches the calculator', async () => {
    const response = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/models/${modelId}/sales-comparison`,
      headers: authed(owner.cookie),
      payload: {
        subjectUnitsOfComparison: '50000',
        comparables: [
          {
            id: 'A',
            salePrice: '5000000',
            unitsOfComparison: '50000',
            adjustments: { marketConditions: 'not-a-number' },
          },
        ],
      },
    });
    expect(response.statusCode).toBe(400);
  });

  it('rejects a comparable with a zero units of comparison, rather than dividing by zero', async () => {
    const response = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/models/${modelId}/sales-comparison`,
      headers: authed(owner.cookie),
      payload: {
        subjectUnitsOfComparison: '50000',
        comparables: [{ id: 'A', salePrice: '5000000', unitsOfComparison: '0', adjustments: {} }],
      },
    });
    expect(response.statusCode).toBe(400);
    const body = response.json() as { error: { message: string } };
    expect(body.error.message).toContain('Comparable "A"');
  });

  it('404s for a model outside the caller’s organization', async () => {
    const stranger = await registerActor(
      ctx.app,
      'sales-comparison-stranger@example.invalid',
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
      url: `/api/v1/models/${modelId}/sales-comparison`,
      headers: authed(stranger.cookie),
      payload: {
        subjectUnitsOfComparison: '50000',
        comparables: [
          { id: 'A', salePrice: '5000000', unitsOfComparison: '50000', adjustments: {} },
        ],
      },
    });
    expect(response.statusCode).toBe(404);
  });

  it('cannot be reached without a session', async () => {
    const response = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/models/${modelId}/sales-comparison`,
      headers: { 'x-requested-with': 'cre-platform' },
      payload: {
        subjectUnitsOfComparison: '50000',
        comparables: [
          { id: 'A', salePrice: '5000000', unitsOfComparison: '50000', adjustments: {} },
        ],
      },
    });
    expect(response.statusCode).toBe(401);
  });
});

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
 * Comparing two frozen versions through the API.
 *
 * The engine's own tests prove the comparison arithmetic. These prove what only
 * the route can get wrong: that both versions are recalculated under the
 * current engine rather than read from whatever was stored, that a version from
 * another model cannot be reached, and that comparing a version with itself is
 * refused rather than answered with a page of zeroes.
 */
describe.skipIf(!hasDatabase)('version comparison', () => {
  let ctx: TestContext;
  let owner: Actor;
  let modelId: string;
  let firstVersionId: string;
  let secondVersionId: string;

  beforeAll(async () => {
    ctx = await createTestContext();
    owner = await registerActor(ctx.app, 'compare@example.invalid', 'Compare Owner');

    await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/organizations',
      headers: authed(owner.cookie),
      payload: { name: 'Compare Partners' },
    });

    const property = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/properties',
      headers: authed(owner.cookie),
      payload: { name: 'Compare House', propertyType: 'office', rentableArea: '50000' },
    });
    const propertyId = (property.json() as { property: { id: string } }).property.id;

    await ctx.app.inject({
      method: 'PUT',
      url: `/api/v1/properties/${propertyId}/spaces`,
      headers: authed(owner.cookie),
      payload: { spaces: [{ code: 'WHOLE', area: '50000', spaceType: 'office' }] },
    });

    const model = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/models',
      headers: authed(owner.cookie),
      payload: {
        propertyId,
        name: 'Comparable',
        classification: 'valuation',
        valuationDate: '2026-01-01',
        forecastStartDate: '2026-01-01',
        forecastMonths: 60,
        discountRate: '0.08',
        terminalCapRate: '0.07',
        saleMonth: 60,
      },
    });
    modelId = (model.json() as { model: { id: string } }).model.id;

    const tenant = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/tenants',
      headers: authed(owner.cookie),
      payload: { propertyId, name: 'Compare Tenant' },
    });
    const tenantId = (tenant.json() as { tenant: { id: string } }).tenant.id;

    // 50,000 sqft at $20.00 is 1,000,000 a year.
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
        excludeFromRollover: true,
      },
    });

    const first = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/models/${modelId}/versions`,
      headers: authed(owner.cookie),
      payload: { label: 'Original underwriting' },
    });
    firstVersionId = (first.json() as { version: { id: string } }).version.id;

    // The edit: rent to $24.00, so 1,200,000 a year, and the discount rate up
    // two hundred basis points.
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
        baseRent: '24.00',
        baseRentBasis: 'per_area_per_year',
        excludeFromRollover: true,
      },
    });
    await ctx.app.inject({
      method: 'PATCH',
      url: `/api/v1/models/${modelId}`,
      headers: authed(owner.cookie),
      payload: { discountRate: '0.10' },
    });

    const second = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/models/${modelId}/versions`,
      headers: authed(owner.cookie),
      payload: { label: 'Revised rent and discount rate' },
    });
    secondVersionId = (second.json() as { version: { id: string } }).version.id;
  }, 90_000);

  afterAll(async () => {
    await ctx?.close();
  });

  async function compare(
    beforeId = firstVersionId,
    afterId = secondVersionId,
  ): Promise<{ statusCode: number; body: string }> {
    const response = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/models/${modelId}/versions/${beforeId}/compare/${afterId}`,
      headers: authed(owner.cookie),
    });
    return { statusCode: response.statusCode, body: response.body };
  }

  interface Comparison {
    comparison: {
      inputChanges: Array<{
        kind: string;
        entity: string;
        code: string;
        fields: Array<{ path: string; before: string | null; after: string | null; delta: string }>;
      }>;
      annual: Array<{ fiscalYear: number; lines: Array<{ line: string; delta: string }> }>;
      headline: { value: { delta: string } };
      engineChanged: boolean;
    };
  }

  it('reports both edits, in the units they were made in', async () => {
    const result = await compare();
    expect(result.statusCode).toBe(200);
    const { comparison } = JSON.parse(result.body) as Comparison;

    const assumption = comparison.inputChanges.find((entry) => entry.entity === 'assumption');
    const rate = assumption?.fields.find((field) => field.path === 'valuation.discountRate');
    // Values arrive in the precision the column stores them at, so they are
    // read as numbers rather than compared as strings.
    expect(Number(rate?.before)).toBeCloseTo(0.08, 12);
    expect(Number(rate?.after)).toBeCloseTo(0.1, 12);
    expect(Number(rate?.delta)).toBeCloseTo(0.02, 12);

    const lease = comparison.inputChanges.find((entry) => entry.entity === 'lease');
    expect(lease?.kind).toBe('changed');
    const rent = lease?.fields.find((field) => field.path.endsWith('.baseRent'));
    expect(Number(rent?.delta)).toBeCloseTo(4, 6);
  });

  it('reports what the edits did to the cash flow', async () => {
    // 50,000 sqft going from $20.00 to $24.00 is 200,000 more rent a year.
    const { comparison } = JSON.parse((await compare()).body) as Comparison;
    const year2027 = comparison.annual.find((entry) => entry.fiscalYear === 2027);
    const noi = year2027?.lines.find((line) => line.line === 'netOperatingIncome');
    expect(Number(noi?.delta)).toBeCloseTo(200000, 2);
  });

  it('recalculates both versions under one engine, so the difference is the edit', async () => {
    // Reading each version's stored result would mix an engine change into the
    // comparison, and someone would attribute it to an assumption.
    const { comparison } = JSON.parse((await compare()).body) as Comparison;
    expect(comparison.engineChanged).toBe(false);
  });

  it('refuses to compare a version with itself', async () => {
    // A page of zeroes is not an answer to a question nobody meant to ask.
    const result = await compare(firstVersionId, firstVersionId);
    expect(result.statusCode).toBe(400);
    expect(result.body).toContain('itself');
  });

  it('refuses a version identifier that belongs to no version of this model', async () => {
    const result = await compare(firstVersionId, '00000000-0000-0000-0000-000000000000');
    expect(result.statusCode).toBe(404);
  });

  it('reads the comparison in the direction it was asked for', async () => {
    // Reversing the arguments reverses every sign. A comparison that returned
    // the same answer either way would be reporting a distance, not a change.
    const forward = (JSON.parse((await compare()).body) as Comparison).comparison;
    const backward = (
      JSON.parse((await compare(secondVersionId, firstVersionId)).body) as Comparison
    ).comparison;

    expect(Number(backward.headline.value.delta)).toBeCloseTo(
      -Number(forward.headline.value.delta),
      2,
    );
  });

  it('keeps one organization out of another’s versions', async () => {
    const stranger = await registerActor(ctx.app, 'compare-stranger@example.invalid', 'Stranger');
    await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/organizations',
      headers: authed(stranger.cookie),
      payload: { name: 'Unrelated Compare Co' },
    });

    const response = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/models/${modelId}/versions/${firstVersionId}/compare/${secondVersionId}`,
      headers: authed(stranger.cookie),
    });
    expect(response.statusCode).toBe(404);
  });
});

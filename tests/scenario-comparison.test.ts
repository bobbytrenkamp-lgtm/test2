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
 * `GET /properties/:id/scenario-comparison`: what a Base/Upside/Downside set
 * of scenarios actually calculated to, side by side. `ScenariosTab`'s clone
 * button already makes the siblings cheap to build; this route is the
 * missing decision-support step -- reading each model's own latest
 * *succeeded* calculation exactly as stored, through the same
 * `extractMetric` switch the sensitivity grid already uses, so it can never
 * disagree with what a reader would find by opening that model directly.
 */
describe.skipIf(!hasDatabase)('scenario comparison', () => {
  let ctx: TestContext;
  let owner: Actor;
  let propertyId: string;
  let baseModelId: string;

  const MODEL_PAYLOAD = {
    classification: 'valuation' as const,
    valuationDate: '2026-01-01',
    forecastStartDate: '2026-01-01',
    forecastMonths: 36,
    discountRate: '0.08',
    terminalCapRate: '0.07',
    generalVacancyRate: '0.05',
    saleMonth: 36,
  };

  interface Scenario {
    modelId: string;
    modelName: string;
    status: string;
    calculated: boolean;
    dcfValue: string | null;
    unleveredIrr: string | null;
    leveredIrr: string | null;
    equityMultiple: string | null;
    year1Noi: string | null;
  }

  async function comparison(): Promise<{ statusCode: number; scenarios: Scenario[] }> {
    const response = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/properties/${propertyId}/scenario-comparison`,
      headers: authed(owner.cookie),
    });
    return {
      statusCode: response.statusCode,
      scenarios:
        response.statusCode === 200 ? (response.json() as { scenarios: Scenario[] }).scenarios : [],
    };
  }

  beforeAll(async () => {
    ctx = await createTestContext();
    owner = await registerActor(ctx.app, 'scenario-cmp@example.invalid', 'Comparison Owner');

    await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/organizations',
      headers: authed(owner.cookie),
      payload: { name: 'Millrace Holdings' },
    });

    const property = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/properties',
      headers: authed(owner.cookie),
      payload: { name: 'Millrace Center', propertyType: 'office', rentableArea: '90000' },
    });
    propertyId = (property.json() as { property: { id: string } }).property.id;

    const model = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/models',
      headers: authed(owner.cookie),
      payload: { propertyId, name: 'Base case', ...MODEL_PAYLOAD },
    });
    baseModelId = (model.json() as { model: { id: string } }).model.id;
  }, 60_000);

  afterAll(async () => {
    await ctx?.close();
  });

  it('lists a single model as not yet calculated', async () => {
    const result = await comparison();
    expect(result.statusCode).toBe(200);
    expect(result.scenarios).toHaveLength(1);
    expect(result.scenarios[0]?.modelId).toBe(baseModelId);
    expect(result.scenarios[0]?.calculated).toBe(false);
    expect(result.scenarios[0]?.dcfValue).toBeNull();
  });

  it('reads exactly what the model’s own cash flow reports, never recomputing', async () => {
    const calc = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/models/${baseModelId}/calculate`,
      headers: authed(owner.cookie),
      payload: {},
    });
    expect(calc.statusCode).toBe(200);

    const cashflow = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/models/${baseModelId}/cashflow`,
      headers: authed(owner.cookie),
    });
    const { valuations, returns, annual } = cashflow.json() as {
      valuations: Array<{ method: string; value: string }>;
      returns: {
        unleveredIrr: string | null;
        leveredIrr: string | null;
        equityMultiple: string | null;
      };
      annual: Array<{ lines: { netOperatingIncome: string } }>;
    };
    const expectedDcf = valuations.find((entry) => entry.method === 'dcf')?.value;

    const result = await comparison();
    const scenario = result.scenarios.find((entry) => entry.modelId === baseModelId);
    expect(scenario?.calculated).toBe(true);
    expect(scenario?.dcfValue).toBe(expectedDcf);
    // extractMetric (shared with the sensitivity grid) coerces an absent
    // return to '' rather than null -- this model has no acquisition price,
    // so there is no initial investment basis for an IRR or multiple, and
    // '' is the correct reading of that, not a mismatch with the cash flow
    // endpoint's own null.
    expect(scenario?.unleveredIrr).toBe(returns.unleveredIrr ?? '');
    expect(scenario?.equityMultiple).toBe(returns.equityMultiple ?? '');
    expect(scenario?.year1Noi).toBe(annual[0]?.lines.netOperatingIncome);
  });

  it('lists a cloned sibling scenario alongside the calculated one', async () => {
    const clone = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/models/${baseModelId}/clone`,
      headers: authed(owner.cookie),
      payload: { name: 'Downside case' },
    });
    expect(clone.statusCode).toBe(201);
    const downsideId = (clone.json() as { model: { id: string } }).model.id;

    const result = await comparison();
    expect(result.scenarios).toHaveLength(2);

    const base = result.scenarios.find((entry) => entry.modelId === baseModelId);
    const downside = result.scenarios.find((entry) => entry.modelId === downsideId);
    expect(base?.calculated).toBe(true);
    // A clone is not itself calculated until it is run — this is a distinct
    // scenario, not a live view of the one it was copied from.
    expect(downside?.calculated).toBe(false);
    expect(downside?.modelName).toBe('Downside case');
  });

  it('cannot be read for a property in another organization', async () => {
    const stranger = await registerActor(ctx.app, 'stranger-cmp@example.invalid', 'Stranger');
    await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/organizations',
      headers: authed(stranger.cookie),
      payload: { name: 'Unrelated Holdings' },
    });

    const result = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/properties/${propertyId}/scenario-comparison`,
      headers: authed(stranger.cookie),
    });
    expect(result.statusCode).toBe(404);
  });

  it('refuses an unauthenticated caller', async () => {
    const response = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/properties/${propertyId}/scenario-comparison`,
    });
    expect(response.statusCode).toBe(401);
  });
});

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
 * The organization-wide queue behind `ProvenanceTab`'s per-model list:
 * "what needs deciding," without already knowing which model to open.
 * Read-only — every decision still only happens through the per-model
 * decision route, already covered by `assumption-proposals.test.ts`.
 */
describe.skipIf(!hasDatabase)('pending assumption proposals, organization-wide', () => {
  let ctx: TestContext;
  let owner: Actor;
  let orgId: string;
  let firstModelId: string;
  let secondModelId: string;

  async function createModel(propertyName: string, modelName: string): Promise<string> {
    const property = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/properties',
      headers: authed(owner.cookie),
      payload: { name: propertyName, propertyType: 'office', rentableArea: '60000' },
    });
    const propertyId = (property.json() as { property: { id: string } }).property.id;

    const model = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/models',
      headers: authed(owner.cookie),
      payload: {
        propertyId,
        name: modelName,
        classification: 'valuation',
        valuationDate: '2026-01-01',
        forecastStartDate: '2026-01-01',
        forecastMonths: 60,
        discountRate: '0.085',
        terminalCapRate: '0.06',
        generalVacancyRate: '0.05',
        saleMonth: 60,
      },
    });
    return (model.json() as { model: { id: string } }).model.id;
  }

  async function propose(modelId: string, target: string, value: string): Promise<void> {
    const result = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/models/${modelId}/assumption-proposals`,
      headers: authed(owner.cookie),
      payload: {
        proposals: [
          { target, value, sourceKind: 'market_data', sourceName: 'test3', evidence: {} },
        ],
      },
    });
    expect(result.statusCode).toBe(201);
  }

  interface Pending {
    id: string;
    model_id: string;
    model_name: string;
    property_id: string;
    property_name: string;
    target: string;
    value: string | null;
    status: string;
    current: string | null;
    created_at: string;
  }

  async function pending(actor = owner): Promise<{ statusCode: number; proposals: Pending[] }> {
    const response = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/organizations/${orgId}/assumption-proposals/pending`,
      headers: authed(actor.cookie),
    });
    return {
      statusCode: response.statusCode,
      proposals:
        response.statusCode === 200 ? (response.json() as { proposals: Pending[] }).proposals : [],
    };
  }

  beforeAll(async () => {
    ctx = await createTestContext();
    owner = await registerActor(ctx.app, 'pending-queue@example.invalid', 'Queue Owner');

    const organization = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/organizations',
      headers: authed(owner.cookie),
      payload: { name: 'Larkspur Capital' },
    });
    orgId = (organization.json() as { organization: { id: string } }).organization.id;

    firstModelId = await createModel('Larkspur Plaza', 'Base case A');
    secondModelId = await createModel('Millbrook Yards', 'Base case B');
  }, 60_000);

  afterAll(async () => {
    await ctx?.close();
  });

  it('is empty before anything is proposed', async () => {
    const result = await pending();
    expect(result.statusCode).toBe(200);
    expect(result.proposals).toEqual([]);
  });

  it('lists pending proposals across every model in the organization, oldest first', async () => {
    await propose(firstModelId, 'valuation.terminalCapRate', '0.0575');
    await propose(secondModelId, 'vacancy.generalVacancyRate', '0.08');
    await propose(firstModelId, 'valuation.discountRate', '0.09');

    const { proposals } = await pending();
    expect(proposals).toHaveLength(3);
    expect(proposals.map((entry) => entry.target)).toEqual([
      'valuation.terminalCapRate',
      'vacancy.generalVacancyRate',
      'valuation.discountRate',
    ]);
  });

  it('carries the property and model each proposal belongs to', async () => {
    const { proposals } = await pending();
    const onFirst = proposals.find((entry) => entry.target === 'valuation.terminalCapRate');
    expect(onFirst?.model_id).toBe(firstModelId);
    expect(onFirst?.model_name).toBe('Base case A');
    expect(onFirst?.property_name).toBe('Larkspur Plaza');

    const onSecond = proposals.find((entry) => entry.target === 'vacancy.generalVacancyRate');
    expect(onSecond?.model_id).toBe(secondModelId);
    expect(onSecond?.property_name).toBe('Millbrook Yards');
  });

  it('compares each proposal against its own model’s current value', async () => {
    // The same read-from-ModelInput guarantee as the per-model list: comparing
    // against anything else would compare against a number the model does not
    // use, and two different models in the same queue must not be conflated.
    const { proposals } = await pending();
    const onFirst = proposals.find((entry) => entry.target === 'valuation.terminalCapRate');
    expect(Number(onFirst?.current)).toBeCloseTo(0.06, 8);

    const onSecond = proposals.find((entry) => entry.target === 'vacancy.generalVacancyRate');
    expect(Number(onSecond?.current)).toBeCloseTo(0.05, 8);
  });

  it('drops out of the queue once decided', async () => {
    const before = await pending();
    const target = before.proposals.find((entry) => entry.target === 'valuation.discountRate');
    expect(target).toBeDefined();

    const decision = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/models/${firstModelId}/assumption-proposals/${target?.id}/decision`,
      headers: authed(owner.cookie),
      payload: { decision: 'rejected', note: 'Staying with the underwritten rate.' },
    });
    expect(decision.statusCode).toBe(200);

    const after = await pending();
    expect(after.proposals.some((entry) => entry.id === target?.id)).toBe(false);
    expect(after.proposals).toHaveLength(2);
  });

  it('cannot be read for another organization, even by its own member', async () => {
    const stranger = await registerActor(ctx.app, 'stranger-queue@example.invalid', 'Stranger');
    await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/organizations',
      headers: authed(stranger.cookie),
      payload: { name: 'Unrelated Holdings' },
    });

    const result = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/organizations/${orgId}/assumption-proposals/pending`,
      headers: authed(stranger.cookie),
    });
    expect(result.statusCode).toBe(403);
  });

  it('refuses an unauthenticated caller', async () => {
    const response = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/organizations/${orgId}/assumption-proposals/pending`,
    });
    expect(response.statusCode).toBe(401);
  });
});

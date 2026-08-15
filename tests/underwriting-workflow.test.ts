import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  authed,
  createTestContext,
  hasDatabase,
  registerActor,
  type Actor,
  type TestContext,
} from './helpers.js';

interface WorkflowStep {
  key: string;
  label: string;
  tab: string;
  optional: boolean;
  done: boolean;
  detail: string;
}

/**
 * The workflow/progress surface (`GET /models/:id/workflow`).
 *
 * Every assertion here checks that a step flips from not-done to done only
 * once the *real row* behind it exists — never on a page visit, since there
 * is no page here at all, only API calls in a deliberate order. A step that
 * flipped early (or never flipped) would mean the query behind it is
 * reading the wrong table, the wrong scope, or a stale cache instead of the
 * live count.
 */
describe.skipIf(!hasDatabase)('underwriting workflow progress', () => {
  let ctx: TestContext;
  let owner: Actor;
  let organizationId: string;
  let propertyId: string;
  let modelId: string;
  let tenantId: string;

  beforeAll(async () => {
    ctx = await createTestContext();
    owner = await registerActor(ctx.app, 'workflow-owner@example.invalid', 'Workflow Owner');
    const org = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/organizations',
      headers: authed(owner.cookie),
      payload: { name: 'Cortland Ridge Advisors' },
    });
    organizationId = (org.json() as { organization: { id: string } }).organization.id;

    const property = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/properties',
      headers: authed(owner.cookie),
      payload: { name: 'Workflow Test Tower', propertyType: 'office' },
    });
    propertyId = (property.json() as { property: { id: string } }).property.id;

    const model = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/models',
      headers: authed(owner.cookie),
      payload: {
        propertyId,
        name: 'Workflow base case',
        classification: 'acquisition',
        valuationDate: '2026-01-01',
        forecastStartDate: '2026-01-01',
        forecastMonths: 36,
        discountRate: '0.08',
        terminalCapRate: '0.065',
        saleMonth: 36,
        saleCostPercent: '0.01',
        acquisitionPrice: '9000000',
      },
    });
    modelId = (model.json() as { model: { id: string } }).model.id;

    const tenant = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/tenants',
      headers: authed(owner.cookie),
      payload: { propertyId, name: 'Workflow Tenant Co' },
    });
    tenantId = (tenant.json() as { tenant: { id: string } }).tenant.id;
  }, 60_000);

  afterAll(async () => {
    await ctx?.close();
  });

  async function workflow(): Promise<WorkflowStep[]> {
    const response = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/models/${modelId}/workflow`,
      headers: authed(owner.cookie),
    });
    expect(response.statusCode).toBe(200);
    return (response.json() as { steps: WorkflowStep[] }).steps;
  }

  function step(steps: WorkflowStep[], key: string): WorkflowStep {
    const found = steps.find((entry) => entry.key === key);
    if (!found) throw new Error(`No step "${key}" in the workflow response.`);
    return found;
  }

  it('starts with every step undone on a brand-new model', async () => {
    const steps = await workflow();
    expect(steps).toHaveLength(10);
    expect(steps.map((entry) => entry.key)).toEqual([
      'setup',
      'rent_roll',
      'imports',
      'operating',
      'capital',
      'debt',
      'calculate',
      'scenarios',
      'review',
      'output',
    ]);
    for (const entry of steps) {
      expect(entry.done, entry.key).toBe(false);
    }
    expect(step(steps, 'setup').optional).toBe(false);
    expect(step(steps, 'imports').optional).toBe(true);
    expect(step(steps, 'capital').optional).toBe(true);
    expect(step(steps, 'debt').optional).toBe(true);
    expect(step(steps, 'scenarios').optional).toBe(true);
    expect(step(steps, 'output').optional).toBe(true);
  });

  it('flips "setup" once the property has a space, and nothing else', async () => {
    await ctx.app.inject({
      method: 'PUT',
      url: `/api/v1/properties/${propertyId}/spaces`,
      headers: authed(owner.cookie),
      payload: { spaces: [{ code: 'WHOLE', area: '80000', spaceType: 'office' }] },
    });
    const steps = await workflow();
    expect(step(steps, 'setup').done).toBe(true);
    expect(step(steps, 'setup').detail).toBe('1 space defined');
    expect(step(steps, 'rent_roll').done).toBe(false);
  });

  it('flips "rent_roll" once a lease exists, and nothing else', async () => {
    await ctx.app.inject({
      method: 'PUT',
      url: `/api/v1/models/${modelId}/leases/L-1`,
      headers: authed(owner.cookie),
      payload: {
        tenantId,
        status: 'occupied',
        area: '80000',
        spaceIds: ['WHOLE'],
        commencementDate: '2026-01-01',
        expirationDate: '2033-12-31',
        baseRent: '32',
        baseRentBasis: 'per_area_per_year',
        excludeFromRollover: true,
      },
    });
    const steps = await workflow();
    expect(step(steps, 'rent_roll').done).toBe(true);
    expect(step(steps, 'operating').done).toBe(false);
    expect(step(steps, 'calculate').done).toBe(false);
  });

  it('flips "operating" once an expense exists', async () => {
    await ctx.app.inject({
      method: 'PUT',
      url: `/api/v1/models/${modelId}/expenses/opex`,
      headers: authed(owner.cookie),
      payload: {
        name: 'Property taxes',
        category: 'taxes',
        method: 'fixed_annual',
        amount: '100000',
      },
    });
    const steps = await workflow();
    expect(step(steps, 'operating').done).toBe(true);
    expect(step(steps, 'capital').done).toBe(false);
    expect(step(steps, 'debt').done).toBe(false);
  });

  it('flips "capital" once a capital item exists, and "debt" only once a facility exists', async () => {
    await ctx.app.inject({
      method: 'PUT',
      url: `/api/v1/models/${modelId}/capital/roof`,
      headers: authed(owner.cookie),
      payload: {
        name: 'Roof replacement',
        category: 'major_project',
        method: 'one_time',
        amount: '250000',
      },
    });
    let steps = await workflow();
    expect(step(steps, 'capital').done).toBe(true);
    expect(step(steps, 'debt').done).toBe(false);

    await ctx.app.inject({
      method: 'PUT',
      url: `/api/v1/models/${modelId}/debt/loan`,
      headers: authed(owner.cookie),
      payload: {
        name: 'Acquisition loan',
        type: 'permanent',
        commitment: '5000000',
        fundingDate: '2026-01-01',
        termMonths: 36,
        rateType: 'fixed',
        fixedRate: '0.06',
      },
    });
    steps = await workflow();
    expect(step(steps, 'debt').done).toBe(true);
  });

  it('flips "calculate" only after a calculation actually succeeds', async () => {
    let steps = await workflow();
    expect(step(steps, 'calculate').done).toBe(false);

    const run = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/models/${modelId}/calculate`,
      headers: authed(owner.cookie),
      payload: { withTrace: false },
    });
    expect(run.statusCode).toBe(200);

    steps = await workflow();
    expect(step(steps, 'calculate').done).toBe(true);
    expect(step(steps, 'calculate').detail).toBe('Calculated at least once');
  });

  it('does not count a failed calculation run as progress', async () => {
    // A separate property/model, so this does not add a sibling to the
    // shared modelId's own property and perturb the "scenarios" test below.
    const property = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/properties',
      headers: authed(owner.cookie),
      payload: { name: 'Isolated Failure Tower', propertyType: 'office' },
    });
    const isolatedPropertyId = (property.json() as { property: { id: string } }).property.id;
    const brokenModel = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/models',
      headers: authed(owner.cookie),
      payload: {
        propertyId: isolatedPropertyId,
        name: 'Deliberately broken',
        classification: 'acquisition',
        valuationDate: '2026-01-01',
        forecastStartDate: '2026-01-01',
        forecastMonths: 12,
      },
    });
    const brokenId = (brokenModel.json() as { model: { id: string } }).model.id;

    // A genuine "queued/failed" run, inserted directly rather than through
    // the API — proves `hasSucceededCalculation` filters on
    // `status = 'succeeded'` rather than "a row exists for this model",
    // which an attempted-but-failed run would otherwise satisfy.
    await ctx.sql`
      INSERT INTO calculation_runs (model_id, engine_version, status, error_message)
      VALUES (${brokenId}, '0.0.0-test', 'failed', 'deliberately induced for this test')
    `;

    const response = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/models/${brokenId}/workflow`,
      headers: authed(owner.cookie),
    });
    const steps = (response.json() as { steps: WorkflowStep[] }).steps;
    expect(step(steps, 'calculate').done).toBe(false);
  });

  it('flips "scenarios" once a sibling model exists on the same property', async () => {
    let steps = await workflow();
    expect(step(steps, 'scenarios').done).toBe(false);

    const clone = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/models/${modelId}/clone`,
      headers: authed(owner.cookie),
      payload: { name: 'Workflow upside case' },
    });
    expect(clone.statusCode).toBe(201);

    steps = await workflow();
    expect(step(steps, 'scenarios').done).toBe(true);
    expect(step(steps, 'scenarios').detail).toBe('1 other model on this property');
  });

  it('flips "review" once the model is submitted, and "output" only once it is published', async () => {
    let steps = await workflow();
    expect(step(steps, 'review').done).toBe(false);
    expect(step(steps, 'output').done).toBe(false);

    const submitted = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/models/${modelId}/transition`,
      headers: authed(owner.cookie),
      payload: { to: 'analyst_review' },
    });
    expect(submitted.statusCode).toBe(200);

    steps = await workflow();
    expect(step(steps, 'review').done).toBe(true);
    expect(step(steps, 'output').done).toBe(false);
  });

  it('reports the applied-import count from real import_sessions rows, not a UI flag', async () => {
    let steps = await workflow();
    expect(step(steps, 'imports').done).toBe(false);

    // Exercising the full analyze/apply pipeline belongs to
    // tests/assumption-import.test.ts; this only has to prove the workflow
    // query reads the same applied_count > 0 signal that pipeline writes.
    await ctx.sql`
      INSERT INTO import_sessions (organization_id, model_id, applied_count)
      VALUES (${organizationId}, ${modelId}, 3)
    `;

    steps = await workflow();
    expect(step(steps, 'imports').done).toBe(true);
    expect(step(steps, 'imports').detail).toBe('1 import applied');
  });

  it('is scoped to the organization: a stranger cannot read another org’s workflow', async () => {
    const stranger = await registerActor(
      ctx.app,
      'workflow-stranger@example.invalid',
      'Workflow Stranger',
    );
    await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/organizations',
      headers: authed(stranger.cookie),
      payload: { name: 'Unrelated Holdings' },
    });

    const response = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/models/${modelId}/workflow`,
      headers: authed(stranger.cookie),
    });
    expect(response.statusCode).toBe(404);
  });

  it('cannot be read without a session', async () => {
    const response = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/models/${modelId}/workflow`,
    });
    expect(response.statusCode).toBe(401);
  });
});

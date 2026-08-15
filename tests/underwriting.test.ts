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
 * "New Underwriting": one request that creates a property and its first
 * model together, atomically, replacing the two-screen "create a property,
 * then remember to also create a model" flow with a single guided step.
 *
 * The interesting behaviour to check isn't the individual field writes —
 * `POST /properties` and `POST /models` already cover those — it's that the
 * two rows land together, linked, audited twice, and that a validation
 * failure on either half leaves neither behind.
 */
describe.skipIf(!hasDatabase)('new underwriting (atomic property + model creation)', () => {
  let ctx: TestContext;
  let owner: Actor;
  let organizationId: string;

  beforeAll(async () => {
    ctx = await createTestContext();
    owner = await registerActor(ctx.app, 'nu-owner@example.invalid', 'Underwriting Owner');
    const org = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/organizations',
      headers: authed(owner.cookie),
      payload: { name: 'Cortland Ridge Advisors' },
    });
    organizationId = (org.json() as { organization: { id: string } }).organization.id;
  }, 60_000);

  afterAll(async () => {
    await ctx?.close();
  });

  function payload(
    overrides: {
      property?: Record<string, unknown>;
      model?: Record<string, unknown>;
    } = {},
  ) {
    return {
      property: {
        name: 'Cortland Ridge Office Park',
        propertyType: 'office',
        city: 'Denver',
        rentableArea: '250000',
        ...overrides.property,
      },
      model: {
        name: 'Acquisition underwriting',
        classification: 'acquisition',
        valuationDate: '2026-01-01',
        forecastStartDate: '2026-01-01',
        forecastMonths: 84,
        discountRate: '0.08',
        terminalCapRate: '0.065',
        saleMonth: 60,
        saleCostPercent: '0.01',
        acquisitionPrice: '65000000',
        ...overrides.model,
      },
    };
  }

  it('creates a property and a model together, linked', async () => {
    const response = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/underwriting',
      headers: authed(owner.cookie),
      payload: payload(),
    });
    expect(response.statusCode).toBe(201);
    const body = response.json() as {
      property: { id: string; name: string; property_type: string };
      model: { id: string; property_id: string; name: string; classification: string };
    };
    expect(body.property.name).toBe('Cortland Ridge Office Park');
    expect(body.property.property_type).toBe('office');
    expect(body.model.name).toBe('Acquisition underwriting');
    expect(body.model.classification).toBe('acquisition');
    // The whole point: the model is already pointed at the property this
    // same request just created, with no second call in between.
    expect(body.model.property_id).toBe(body.property.id);

    // And it is actually readable through the normal routes afterward, not
    // just returned once and never persisted.
    const readProperty = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/properties/${body.property.id}`,
      headers: authed(owner.cookie),
    });
    expect(readProperty.statusCode).toBe(200);
    const readModel = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/models/${body.model.id}`,
      headers: authed(owner.cookie),
    });
    expect(readModel.statusCode).toBe(200);
  });

  it('writes an audit entry for both the property and the model', async () => {
    const response = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/underwriting',
      headers: authed(owner.cookie),
      payload: payload({ property: { name: 'Audit Check Tower' } }),
    });
    const body = response.json() as { property: { id: string }; model: { id: string } };

    const audit = await ctx.app.inject({
      method: 'GET',
      url: '/api/v1/audit?limit=10',
      headers: authed(owner.cookie),
    });
    const entries = (audit.json() as { entries: Array<Record<string, unknown>> }).entries;
    expect(entries).toContainEqual(
      expect.objectContaining({ action: 'property.created', entity_id: body.property.id }),
    );
    expect(entries).toContainEqual(
      expect.objectContaining({ action: 'model.created', entity_id: body.model.id }),
    );
  });

  it('rolls back the property when the model half fails validation', async () => {
    const before = await ctx.app.inject({
      method: 'GET',
      url: '/api/v1/properties?search=No Model Behind Me',
      headers: authed(owner.cookie),
    });
    expect((before.json() as { total: number }).total).toBe(0);

    const response = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/underwriting',
      headers: authed(owner.cookie),
      payload: payload({
        property: { name: 'No Model Behind Me' },
        // forecastMonths must be at least 1 — this is refused by zod before
        // the transaction even opens, so nothing should be written.
        model: { forecastMonths: 0 },
      }),
    });
    expect(response.statusCode).toBe(400);

    const after = await ctx.app.inject({
      method: 'GET',
      url: '/api/v1/properties?search=No Model Behind Me',
      headers: authed(owner.cookie),
    });
    expect((after.json() as { total: number }).total).toBe(0);
  });

  it('is scoped to the organization: a stranger cannot create against it', async () => {
    const stranger = await registerActor(
      ctx.app,
      'nu-stranger@example.invalid',
      'Underwriting Stranger',
    );
    await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/organizations',
      headers: authed(stranger.cookie),
      payload: { name: 'Unrelated Holdings' },
    });

    const response = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/underwriting',
      headers: authed(stranger.cookie),
      payload: payload({ property: { name: 'Should Land In My Own Org' } }),
    });
    expect(response.statusCode).toBe(201);
    const body = response.json() as { property: { id: string } };

    // Written into the stranger's own organization, not Cortland Ridge's —
    // the owner cannot see it.
    const asOwner = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/properties/${body.property.id}`,
      headers: authed(owner.cookie),
    });
    expect(asOwner.statusCode).toBe(404);
  });

  it('cannot be reached without a session', async () => {
    const response = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/underwriting',
      headers: { 'x-requested-with': 'cre-platform', 'content-type': 'application/json' },
      payload: payload(),
    });
    expect(response.statusCode).toBe(401);
  });

  it('is refused for a reviewer, who holds neither property:write nor model:write', async () => {
    const reviewer = await registerActor(
      ctx.app,
      'nu-reviewer@example.invalid',
      'Underwriting Reviewer',
    );
    const invitation = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/organizations/${organizationId}/invitations`,
      headers: authed(owner.cookie),
      payload: { email: reviewer.email, role: 'reviewer' },
    });
    const token = (invitation.json() as { token: string }).token;
    await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/invitations/accept',
      headers: authed(reviewer.cookie),
      payload: { token },
    });

    const response = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/underwriting',
      headers: authed(reviewer.cookie),
      payload: payload({ property: { name: 'Should Never Be Written' } }),
    });
    expect(response.statusCode).toBe(403);

    const search = await ctx.app.inject({
      method: 'GET',
      url: '/api/v1/properties?search=Should Never Be Written',
      headers: authed(owner.cookie),
    });
    expect((search.json() as { total: number }).total).toBe(0);
  });
});

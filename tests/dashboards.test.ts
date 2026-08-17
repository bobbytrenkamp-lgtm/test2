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
 * Personal dashboard layouts.
 *
 * `dashboards` has existed since this platform's first migration, designed
 * but never wired to a route. Small on purpose: the interesting behaviour
 * is that the upsert really is an upsert (one row per person per
 * organization, not a new one every save), that it never crosses an
 * organization boundary even for the same person, and that resetting
 * really does return to nothing saved rather than an empty array that
 * looks the same to a shallow read but means something different.
 */
describe.skipIf(!hasDatabase)('dashboards', () => {
  let ctx: TestContext;
  let owner: Actor;
  let organizationAId: string;

  beforeAll(async () => {
    ctx = await createTestContext();
    owner = await registerActor(ctx.app, 'dashboards-owner@example.invalid', 'Dashboards Owner');

    const organization = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/organizations',
      headers: authed(owner.cookie),
      payload: { name: 'Dashboards Partners' },
    });
    organizationAId = (organization.json() as { organization: { id: string } }).organization.id;
  }, 60_000);

  afterAll(async () => {
    await ctx?.close();
  });

  async function get(
    actor: Actor,
  ): Promise<{ layout: Array<{ id: string; visible: boolean }> } | null> {
    const response = await ctx.app.inject({
      method: 'GET',
      url: '/api/v1/dashboards?scope=organization',
      headers: authed(actor.cookie),
    });
    return (
      response.json() as { dashboard: { layout: Array<{ id: string; visible: boolean }> } | null }
    ).dashboard;
  }

  it('starts with nothing saved', async () => {
    expect(await get(owner)).toBeNull();
  });

  it('saves a layout and reads it back', async () => {
    const layout = [
      { id: 'metrics', visible: true },
      { id: 'assetsByType', visible: false },
    ];
    const response = await ctx.app.inject({
      method: 'PUT',
      url: '/api/v1/dashboards',
      headers: authed(owner.cookie),
      payload: { scope: 'organization', layout },
    });
    expect(response.statusCode, response.body).toBe(200);

    const saved = await get(owner);
    expect(saved?.layout).toEqual(layout);
  });

  it('saving again replaces the layout rather than adding a second row', async () => {
    const layout = [{ id: 'recentProperties', visible: true }];
    await ctx.app.inject({
      method: 'PUT',
      url: '/api/v1/dashboards',
      headers: authed(owner.cookie),
      payload: { scope: 'organization', layout },
    });
    // If the upsert had failed and inserted a second row instead, exactly
    // which one a plain read returns would be undefined — this only ever
    // matches the second write if there really is just the one row.
    expect((await get(owner))?.layout).toEqual(layout);
  });

  it('is personal: a different member of the same organization has their own layout', async () => {
    const analyst = await registerActor(
      ctx.app,
      'dashboards-analyst@example.invalid',
      'Dashboards Analyst',
    );
    const invitation = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/organizations/${organizationAId}/invitations`,
      headers: authed(owner.cookie),
      payload: { email: 'dashboards-analyst@example.invalid', role: 'analyst' },
    });
    await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/invitations/accept',
      headers: authed(analyst.cookie),
      payload: { token: (invitation.json() as { token: string }).token },
    });

    expect(await get(analyst)).toBeNull();
    expect(await get(owner)).not.toBeNull();
  });

  it('never crosses an organization boundary, even for the same person', async () => {
    const second = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/organizations',
      headers: authed(owner.cookie),
      payload: { name: 'Owner’s Second Organization' },
    });
    const organizationBId = (second.json() as { organization: { id: string } }).organization.id;

    // Still switched into the second organization from here on.
    await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/organizations/${organizationBId}/switch`,
      headers: authed(owner.cookie),
    });
    expect(await get(owner)).toBeNull();

    await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/organizations/${organizationAId}/switch`,
      headers: authed(owner.cookie),
    });
    expect(await get(owner)).not.toBeNull();
  });

  it('resets to nothing saved, not an empty layout', async () => {
    const deleted = await ctx.app.inject({
      method: 'DELETE',
      url: '/api/v1/dashboards?scope=organization',
      headers: authed(owner.cookie),
    });
    expect(deleted.statusCode).toBe(200);
    expect(await get(owner)).toBeNull();

    // Already gone; resetting an already-default dashboard is not an error.
    const again = await ctx.app.inject({
      method: 'DELETE',
      url: '/api/v1/dashboards?scope=organization',
      headers: authed(owner.cookie),
    });
    expect(again.statusCode).toBe(200);
  });

  it('refuses a malformed layout', async () => {
    const response = await ctx.app.inject({
      method: 'PUT',
      url: '/api/v1/dashboards',
      headers: authed(owner.cookie),
      payload: { scope: 'organization', layout: [{ id: 'metrics', visible: 'yes' }] },
    });
    expect(response.statusCode).toBe(400);
  });

  it('cannot be read without a session', async () => {
    const response = await ctx.app.inject({
      method: 'GET',
      url: '/api/v1/dashboards?scope=organization',
    });
    expect(response.statusCode).toBe(401);
  });
});

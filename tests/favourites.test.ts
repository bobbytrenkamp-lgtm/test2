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
 * Pinned properties and models.
 *
 * Small on purpose: the interesting behaviour is the toggle's idempotence, the
 * organization scoping, and that a pin cannot be used to probe for a uuid this
 * caller cannot otherwise see. The star control and the dashboard's recents
 * section are covered in `e2e/favourites.spec.ts`.
 */
describe.skipIf(!hasDatabase)('favourites', () => {
  let ctx: TestContext;
  let owner: Actor;
  let propertyId: string;
  let modelId: string;

  beforeAll(async () => {
    ctx = await createTestContext();
    owner = await registerActor(ctx.app, 'favourites-owner@example.invalid', 'Favourites Owner');

    await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/organizations',
      headers: authed(owner.cookie),
      payload: { name: 'Cortland Ridge Advisors' },
    });

    const property = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/properties',
      headers: authed(owner.cookie),
      payload: { name: 'Cortland Ridge', propertyType: 'industrial', rentableArea: '210000' },
    });
    propertyId = (property.json() as { property: { id: string } }).property.id;

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

  async function list(): Promise<Array<{ entity_type: string; entity_id: string; name: string }>> {
    const response = await ctx.app.inject({
      method: 'GET',
      url: '/api/v1/favourites',
      headers: authed(owner.cookie),
    });
    return (
      response.json() as {
        favourites: Array<{ entity_type: string; entity_id: string; name: string }>;
      }
    ).favourites;
  }

  it('starts empty', async () => {
    expect(await list()).toEqual([]);
  });

  it('pins a property and a model', async () => {
    expect(
      (
        await ctx.app.inject({
          method: 'PUT',
          url: `/api/v1/favourites/property/${propertyId}`,
          headers: authed(owner.cookie),
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (
        await ctx.app.inject({
          method: 'PUT',
          url: `/api/v1/favourites/model/${modelId}`,
          headers: authed(owner.cookie),
        })
      ).statusCode,
    ).toBe(200);

    const favourites = await list();
    expect(favourites).toHaveLength(2);
    expect(favourites.map((entry) => entry.entity_type).sort()).toEqual(['model', 'property']);
    const property = favourites.find((entry) => entry.entity_type === 'property');
    // Resolved by joining to the real table, not stored as a copy: renaming the
    // property would change this without a second write.
    expect(property?.name).toBe('Cortland Ridge');
  });

  it('pinning twice is the same as pinning once', async () => {
    // The toggle depends on this. A double click — or a retried request after
    // a flaky connection — must not produce two rows or an error.
    await ctx.app.inject({
      method: 'PUT',
      url: `/api/v1/favourites/property/${propertyId}`,
      headers: authed(owner.cookie),
    });
    const favourites = await list();
    expect(favourites.filter((entry) => entry.entity_id === propertyId)).toHaveLength(1);
  });

  it('unpins, and unpinning again is not an error', async () => {
    expect(
      (
        await ctx.app.inject({
          method: 'DELETE',
          url: `/api/v1/favourites/property/${propertyId}`,
          headers: authed(owner.cookie),
        })
      ).statusCode,
    ).toBe(200);
    expect((await list()).some((entry) => entry.entity_id === propertyId)).toBe(false);

    // Already gone; the control is a toggle, not a claim that a row existed.
    expect(
      (
        await ctx.app.inject({
          method: 'DELETE',
          url: `/api/v1/favourites/property/${propertyId}`,
          headers: authed(owner.cookie),
        })
      ).statusCode,
    ).toBe(200);
  });

  it('refuses to pin something outside the caller’s organization', async () => {
    /*
     * Without the existence check this would succeed and quietly store an id
     * belonging to a different tenant — and the read would then confirm the
     * property exists by resolving its name, which is exactly the kind of leak
     * a 404 here is supposed to prevent.
     */
    const stranger = await registerActor(
      ctx.app,
      'favourites-stranger@example.invalid',
      'Stranger',
    );
    await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/organizations',
      headers: authed(stranger.cookie),
      payload: { name: 'Unrelated Holdings' },
    });

    const result = await ctx.app.inject({
      method: 'PUT',
      url: `/api/v1/favourites/property/${propertyId}`,
      headers: authed(stranger.cookie),
    });
    expect(result.statusCode).toBe(404);

    const strangerResponse = await ctx.app.inject({
      method: 'GET',
      url: '/api/v1/favourites',
      headers: authed(stranger.cookie),
    });
    expect((strangerResponse.json() as { favourites: unknown[] }).favourites).toEqual([]);
  });

  it('a deleted property disappears from the list on its own', async () => {
    /*
     * No foreign key can point at "whichever table entity_type names", so the
     * read resolves each row by joining to the real table and silently drops
     * one whose target is gone. This is the test that proves it rather than
     * assumes it.
     */
    const property = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/properties',
      headers: authed(owner.cookie),
      payload: { name: 'Disposable Asset', propertyType: 'office', rentableArea: '40000' },
    });
    const disposableId = (property.json() as { property: { id: string } }).property.id;

    await ctx.app.inject({
      method: 'PUT',
      url: `/api/v1/favourites/property/${disposableId}`,
      headers: authed(owner.cookie),
    });
    expect((await list()).some((entry) => entry.entity_id === disposableId)).toBe(true);

    const deleted = await ctx.app.inject({
      method: 'DELETE',
      url: `/api/v1/properties/${disposableId}`,
      headers: authed(owner.cookie),
    });
    expect(deleted.statusCode).toBe(200);

    expect((await list()).some((entry) => entry.entity_id === disposableId)).toBe(false);
  });

  it('cannot be read without a session', async () => {
    const result = await ctx.app.inject({ method: 'GET', url: '/api/v1/favourites' });
    expect(result.statusCode).toBe(401);
  });
});

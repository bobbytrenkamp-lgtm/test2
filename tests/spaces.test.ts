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
 * `PUT /properties/:id/spaces` writes its whole batch in one transaction, so
 * a failure partway through a save leaves either every space in the request
 * applied or none of them — never some. This was not always true: the route
 * used to upsert each space in a plain loop with no transaction around it,
 * so a later row's failure (a negative area, which the database's own CHECK
 * constraint refuses even though `decimalString` itself allows a leading
 * `-`) left the earlier rows in the same request committed regardless.
 */
describe.skipIf(!hasDatabase)('property spaces', () => {
  let ctx: TestContext;
  let owner: Actor;
  let propertyId: string;

  beforeAll(async () => {
    ctx = await createTestContext();
    owner = await registerActor(ctx.app, 'spaces@example.invalid', 'Spaces Owner');

    await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/organizations',
      headers: authed(owner.cookie),
      payload: { name: 'Fenwick Holdings' },
    });

    const property = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/properties',
      headers: authed(owner.cookie),
      payload: { name: 'Fenwick Tower', propertyType: 'office', rentableArea: '40000' },
    });
    propertyId = (property.json() as { property: { id: string } }).property.id;
  }, 60_000);

  afterAll(async () => {
    await ctx?.close();
  });

  async function listSpaceCodes(): Promise<string[]> {
    const response = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/properties/${propertyId}`,
      headers: authed(owner.cookie),
    });
    const body = response.json() as { spaces: Array<{ code: string }> };
    return body.spaces.map((space) => space.code).sort();
  }

  it('saves a batch of spaces atomically', async () => {
    const response = await ctx.app.inject({
      method: 'PUT',
      url: `/api/v1/properties/${propertyId}/spaces`,
      headers: authed(owner.cookie),
      payload: {
        spaces: [
          { code: 'FW-100', area: '10000', spaceType: 'office' },
          { code: 'FW-200', area: '15000', spaceType: 'office' },
        ],
      },
    });
    expect(response.statusCode, response.body).toBe(200);
    expect(await listSpaceCodes()).toEqual(['FW-100', 'FW-200']);
  });

  it('rolls back the whole batch when a later row fails, not just the bad one', async () => {
    // FW-300 would save fine on its own; FW-BAD violates the database's
    // `spaces_area_non_negative` check (migration 0002) — a negative area
    // passes `decimalString`'s own format check (it allows a leading `-`) so
    // this fails inside the database, not at the zod boundary, which is
    // exactly the case a route-level try/catch cannot turn into a clean
    // per-row skip: the whole request must fail, and it must fail as one unit.
    const response = await ctx.app.inject({
      method: 'PUT',
      url: `/api/v1/properties/${propertyId}/spaces`,
      headers: authed(owner.cookie),
      payload: {
        spaces: [
          { code: 'FW-300', area: '5000', spaceType: 'office' },
          { code: 'FW-BAD', area: '-1', spaceType: 'office' },
        ],
      },
    });
    expect(response.statusCode).toBeGreaterThanOrEqual(400);

    // Neither FW-300 nor FW-BAD made it in — the pre-existing FW-100/FW-200
    // from the previous test are exactly what survives.
    expect(await listSpaceCodes()).toEqual(['FW-100', 'FW-200']);
  });
});

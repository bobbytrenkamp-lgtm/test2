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
 * Updating a property.
 *
 * `updateProperty` writes every field a `PATCH` might touch in one
 * statement, and has to tell three states apart for each of them: the key
 * was not sent (leave it), the key was sent as `null` (clear it -- most of
 * these fields are `.nullish()` in the write schema precisely so a client
 * can), and the key was sent with a real value (change it). `COALESCE(new,
 * old)` can only tell "not sent" and "sent as null" apart from a change --
 * it cannot tell them apart from *each other* -- so a client clearing
 * `submarket` by sending `null` got a 200 back with the old value still
 * sitting there, silently unchanged.
 */
describe.skipIf(!hasDatabase)('updating a property', () => {
  let ctx: TestContext;
  let owner: Actor;
  let propertyId: string;

  beforeAll(async () => {
    ctx = await createTestContext();
    owner = await registerActor(ctx.app, 'properties-owner@example.invalid', 'Properties Owner');
    await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/organizations',
      headers: authed(owner.cookie),
      payload: { name: 'Properties Partners' },
    });
  }, 60_000);

  afterAll(async () => {
    await ctx?.close();
  });

  beforeAll(async () => {
    const created = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/properties',
      headers: authed(owner.cookie),
      payload: {
        name: 'Marlowe Tower',
        propertyType: 'office',
        rentableArea: '50000',
        market: 'Metro',
        submarket: 'Downtown',
      },
    });
    propertyId = (created.json() as { property: { id: string } }).property.id;
  });

  async function get(): Promise<Record<string, unknown>> {
    const response = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/properties/${propertyId}`,
      headers: authed(owner.cookie),
    });
    return (response.json() as { property: Record<string, unknown> }).property;
  }

  async function patch(
    body: Record<string, unknown>,
  ): Promise<{ statusCode: number; property: Record<string, unknown> }> {
    const response = await ctx.app.inject({
      method: 'PATCH',
      url: `/api/v1/properties/${propertyId}`,
      headers: authed(owner.cookie),
      payload: body,
    });
    return {
      statusCode: response.statusCode,
      property: (response.json() as { property: Record<string, unknown> }).property,
    };
  }

  it('leaves a field alone when the key is omitted from the patch', async () => {
    const result = await patch({ market: 'Metro Core' });
    expect(result.statusCode).toBe(200);
    expect(result.property.market).toBe('Metro Core');
    expect(result.property.submarket).toBe('Downtown');
    expect((await get()).submarket).toBe('Downtown');
  });

  it('clears a nullish field when the patch sends an explicit null, rather than silently keeping the old value', async () => {
    expect((await get()).submarket).toBe('Downtown');

    const result = await patch({ submarket: null });
    expect(result.statusCode).toBe(200);
    expect(result.property.submarket).toBeNull();
    // Not just the response -- the stored row actually changed.
    expect((await get()).submarket).toBeNull();
    // A field not named in this patch is untouched, same as any other patch.
    expect((await get()).market).toBe('Metro Core');
  });

  it('sets a nullish field to a new value the ordinary way', async () => {
    const result = await patch({ submarket: 'Riverside' });
    expect(result.statusCode).toBe(200);
    expect(result.property.submarket).toBe('Riverside');
    expect((await get()).submarket).toBe('Riverside');
  });
});

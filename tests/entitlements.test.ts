import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  applyPlanDefaults,
  getEntitlements,
  updateEntitlements,
} from '../packages/database/src/index.js';
import {
  authed,
  createTestContext,
  hasDatabase,
  registerActor,
  type Actor,
  type TestContext,
} from './helpers.js';

/**
 * Organization entitlements: the row every organization gets at creation
 * (`createOrganization`), what `/auth/me` exposes, and the one feature gate
 * currently wired to it — `POST .../assumption-import/apply`, gated on the
 * `assumption_import` feature. See `packages/domain-models/src/
 * entitlements.ts` for `canUseFeature`'s own unit tests, which this file
 * does not repeat; this file only has to prove the plumbing between a real
 * organization row and a real route.
 */
describe.skipIf(!hasDatabase)('entitlements', () => {
  let ctx: TestContext;
  let owner: Actor;
  let orgId: string;

  beforeAll(async () => {
    ctx = await createTestContext();
    owner = await registerActor(
      ctx.app,
      'entitlements-owner@example.invalid',
      'Entitlements Owner',
    );

    const organization = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/organizations',
      headers: authed(owner.cookie),
      payload: { name: 'Piedmont Capital Partners' },
    });
    orgId = (organization.json() as { organization: { id: string } }).organization.id;
  }, 60_000);

  afterAll(async () => {
    await ctx?.close();
  });

  async function me(actor: Actor = owner): Promise<Record<string, unknown>> {
    const response = await ctx.app.inject({
      method: 'GET',
      url: '/api/v1/auth/me',
      headers: authed(actor.cookie),
    });
    return response.json() as Record<string, unknown>;
  }

  it('creating an organization creates a trial entitlements row', async () => {
    const entitlements = await getEntitlements(ctx.sql, orgId);
    expect(entitlements).not.toBeNull();
    expect(entitlements?.status).toBe('trial');
    expect(entitlements?.plan).toBe('starter');
    expect(entitlements?.features).toEqual([]);
    expect(entitlements?.trialEndsAt).not.toBeNull();
  });

  it('/auth/me returns the caller organization entitlements', async () => {
    const body = await me();
    const entitlements = body.entitlements as Record<string, unknown>;
    expect(entitlements.organizationId).toBe(orgId);
    expect(entitlements.status).toBe('trial');
  });

  it('returns null entitlements when no organization is selected', async () => {
    const solo = await registerActor(ctx.app, 'entitlements-solo@example.invalid', 'Solo');
    const body = await me(solo);
    expect(body.organizationId).toBeNull();
    expect(body.entitlements).toBeNull();
  });

  it('applyPlanDefaults sets a plan and its documented feature list together', async () => {
    const updated = await applyPlanDefaults(ctx.sql, orgId, 'professional');
    expect(updated?.plan).toBe('professional');
    expect(updated?.features).toEqual(
      expect.arrayContaining(['portfolio_analytics', 'assumption_import']),
    );

    // Restore the trial fixture other tests in this file rely on.
    await updateEntitlements(ctx.sql, orgId, { plan: 'starter' });
    await applyPlanDefaults(ctx.sql, orgId, 'starter');
  });

  describe('assumption_import gate on the apply route', () => {
    let modelId: string;

    beforeAll(async () => {
      const property = await ctx.app.inject({
        method: 'POST',
        url: '/api/v1/properties',
        headers: authed(owner.cookie),
        payload: { name: 'Gate Test Property', propertyType: 'office', rentableArea: '90000' },
      });
      const propertyId = (property.json() as { property: { id: string } }).property.id;

      const model = await ctx.app.inject({
        method: 'POST',
        url: '/api/v1/models',
        headers: authed(owner.cookie),
        payload: {
          propertyId,
          name: 'Gate Test Model',
          classification: 'acquisition',
          valuationDate: '2026-01-01',
          forecastStartDate: '2026-01-01',
          forecastMonths: 12,
          saleMonth: 12,
        },
      });
      modelId = (model.json() as { model: { id: string } }).model.id;
    });

    // Each call proposes a different discount rate: applying the same value
    // twice is a no-op the analyzer marks "kept" rather than "changed", which
    // the apply route refuses (there is nothing to apply) — a false failure
    // that has nothing to do with the entitlements gate this suite tests.
    const paste = (rate: string): string =>
      JSON.stringify({
        format: 'cre-assumption-import',
        version: 1,
        source: { kind: 'imported', system: 'Claude Skill' },
        property: { name: 'Gate Test Property' },
        assumptions: [{ target: 'valuation.discountRate', value: rate, valueType: 'decimal' }],
        records: [],
      });

    async function apply(
      rate: string,
    ): Promise<{ statusCode: number; body: Record<string, unknown> }> {
      const response = await ctx.app.inject({
        method: 'POST',
        url: `/api/v1/models/${modelId}/assumption-import/apply`,
        headers: authed(owner.cookie),
        payload: { paste: paste(rate), targets: ['valuation.discountRate'] },
      });
      return { statusCode: response.statusCode, body: response.json() as Record<string, unknown> };
    }

    it('a trial organization can use the feature even on the starter plan', async () => {
      const entitlements = await getEntitlements(ctx.sql, orgId);
      expect(entitlements?.status).toBe('trial');
      expect(entitlements?.plan).toBe('starter');

      const result = await apply('0.08');
      expect(result.statusCode).toBe(200);
    });

    it('an active starter organization is refused the feature', async () => {
      await updateEntitlements(ctx.sql, orgId, { status: 'active' });
      await applyPlanDefaults(ctx.sql, orgId, 'starter');

      const result = await apply('0.09');
      expect(result.statusCode).toBe(402);
      expect((result.body.error as { code: string }).code).toBe('FEATURE_NOT_AVAILABLE');
    });

    it('an active professional organization is granted the feature', async () => {
      await applyPlanDefaults(ctx.sql, orgId, 'professional');

      const result = await apply('0.10');
      expect(result.statusCode).toBe(200);

      // Restore the trial fixture for any test file order this suite runs under.
      await updateEntitlements(ctx.sql, orgId, { status: 'trial' });
      await applyPlanDefaults(ctx.sql, orgId, 'starter');
    });
  });
});

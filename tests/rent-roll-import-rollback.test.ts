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
 * Import atomicity and rollback.
 *
 * This module's own doc comment has always claimed the commit "runs in one
 * transaction: either every valid lease lands or none does, which is what
 * makes the rollback offered afterwards meaningful." Neither half was true:
 * the commit loop called `upsertLease`, which opens and commits its own
 * transaction per call, so a failure partway through left the earlier leases
 * standing; and rollback itself — `import_batches.status` has allowed
 * `'rolled_back'` since the table's first migration — was never implemented.
 * Both are fixed together here, because the second cannot mean anything
 * without the first: restoring a lease "to before the import" only makes
 * sense if the import itself either fully happened or fully didn't.
 */
describe.skipIf(!hasDatabase)('import atomicity and rollback', () => {
  let ctx: TestContext;
  let owner: Actor;
  let propertyId: string;
  let modelId: string;
  let tenantId: string;

  const MAPPING = {
    leaseCode: 0,
    tenantName: 1,
    spaceCode: 2,
    area: 3,
    commencementDate: 4,
    expirationDate: 5,
    baseRent: 6,
  };

  function csvOf(rows: string[]): string {
    return ['Lease,Tenant,Suite,Area,Commences,Expires,Base rent', ...rows].join('\n');
  }

  async function analyze(): Promise<string> {
    const analyzed = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/models/${modelId}/imports/analyze`,
      headers: authed(owner.cookie),
      payload: {
        filename: 'roll.csv',
        content: csvOf(['L-1,Placeholder,STE-1,1,2026-01-01,2030-12-31,1']),
      },
    });
    return (analyzed.json() as { batchId: string }).batchId;
  }

  async function commit(content: string, batchId?: string) {
    return ctx.app.inject({
      method: 'POST',
      url: `/api/v1/models/${modelId}/imports/commit`,
      headers: authed(owner.cookie),
      payload: { filename: 'roll.csv', content, mapping: MAPPING, batchId },
    });
  }

  async function leaseRows(): Promise<Array<Record<string, unknown>>> {
    const response = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/models/${modelId}/leases`,
      headers: authed(owner.cookie),
    });
    return (response.json() as { leases: Array<Record<string, unknown>> }).leases;
  }

  beforeAll(async () => {
    ctx = await createTestContext();
    owner = await registerActor(ctx.app, 'rollback-owner@example.invalid', 'Rollback Owner');

    await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/organizations',
      headers: authed(owner.cookie),
      payload: { name: 'Rollback Test Partners' },
    });

    const property = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/properties',
      headers: authed(owner.cookie),
      payload: { name: 'Rollback House', propertyType: 'office', rentableArea: '50000' },
    });
    propertyId = (property.json() as { property: { id: string } }).property.id;
    await ctx.app.inject({
      method: 'PUT',
      url: `/api/v1/properties/${propertyId}/spaces`,
      headers: authed(owner.cookie),
      payload: { spaces: [{ code: 'WHOLE', spaceType: 'office', area: '50000' }] },
    });

    const tenant = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/tenants',
      headers: authed(owner.cookie),
      payload: { name: 'Rollback Tenant' },
    });
    tenantId = (tenant.json() as { tenant: { id: string } }).tenant.id;

    const model = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/models',
      headers: authed(owner.cookie),
      payload: {
        propertyId,
        name: 'Rollback model',
        classification: 'valuation',
        valuationDate: '2026-01-01',
        forecastStartDate: '2026-01-01',
        forecastMonths: 24,
        discountRate: '0.08',
        terminalCapRate: '0.07',
      },
    });
    modelId = (model.json() as { model: { id: string } }).model.id;
  }, 90_000);

  afterAll(async () => {
    await ctx?.close();
  });

  it('a constraint violation partway through the commit leaves no lease and no tenant written', async () => {
    // `mapRows` validates that a rent is present and non-negative, but not
    // that it fits `leases.base_rent numeric(20, 6)` (14 integer digits) --
    // a value with more digits than that passes every application-level
    // check and fails only at the database with "numeric field overflow",
    // on the second row. Before this fix the first row's tenant and lease
    // were already committed by their own separate transaction by the time
    // the second row failed.
    const content = csvOf([
      'L-ATOM-1,Atomic Tenant,STE-900,4000,2026-01-01,2030-12-31,20.00',
      'L-ATOM-2,Atomic Tenant,STE-901,500,2026-01-01,2030-12-31,999999999999999.00',
    ]);
    const response = await commit(content);
    // Specifically not the 400 `mapRows` issues itself pre-write -- proving
    // this reached the database, inside the transaction, past the first row.
    expect(response.statusCode).toBe(500);
    expect(response.body).not.toContain('error(s)');

    const leases = await leaseRows();
    expect(leases.find((l) => l.code === 'L-ATOM-1')).toBeUndefined();

    const tenants = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/tenants?propertyId=${propertyId}`,
      headers: authed(owner.cookie),
    });
    const names = (tenants.json() as { tenants: Array<{ name: string }> }).tenants.map(
      (t) => t.name,
    );
    expect(names).not.toContain('Atomic Tenant');
  });

  it('rollback deletes a lease the batch created fresh', async () => {
    const batchId = await analyze();
    const committed = await commit(
      csvOf(['L-NEW-1,Rollback Tenant,STE-100,5000,2026-01-01,2030-12-31,28.00']),
      batchId,
    );
    expect(committed.statusCode, committed.body).toBe(200);
    expect((await leaseRows()).find((l) => l.code === 'L-NEW-1')).toBeDefined();

    const rollback = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/models/${modelId}/imports/${batchId}/rollback`,
      headers: authed(owner.cookie),
    });
    expect(rollback.statusCode, rollback.body).toBe(200);
    expect(rollback.json()).toEqual({ restored: 0, deleted: 1 });
    expect((await leaseRows()).find((l) => l.code === 'L-NEW-1')).toBeUndefined();

    const batches = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/models/${modelId}/imports`,
      headers: authed(owner.cookie),
    });
    const batch = (
      batches.json() as {
        batches: Array<{ id: string; status: string; rolled_back_at: string | null }>;
      }
    ).batches.find((b) => b.id === batchId);
    expect(batch?.status).toBe('rolled_back');
    expect(batch?.rolled_back_at).not.toBeNull();
  });

  it('rollback restores an updated lease exactly, rent steps and spaces included', async () => {
    // The lease exists first with a hand-entered rent step, area and rent --
    // set directly, not through the import pipeline, so the "before" state
    // is unambiguous.
    await ctx.app.inject({
      method: 'PUT',
      url: `/api/v1/models/${modelId}/leases/L-RESTORE-1`,
      headers: authed(owner.cookie),
      payload: {
        tenantId,
        status: 'occupied',
        area: '5000',
        spaceIds: ['WHOLE'],
        commencementDate: '2026-01-01',
        expirationDate: '2030-12-31',
        baseRent: '25.00',
        baseRentBasis: 'per_area_per_year',
        rentSteps: [{ startDate: '2027-01-01', amount: '26.00', basis: 'per_area_per_year' }],
      },
    });

    // A rent-roll re-import overwrites it: different area and rent, and (the
    // CSV pipeline never carries a rent-step schedule) no rent steps at all.
    const batchId = await analyze();
    const committed = await commit(
      csvOf(['L-RESTORE-1,Rollback Tenant,STE-100,6000,2026-01-01,2030-12-31,30.00']),
      batchId,
    );
    expect(committed.statusCode, committed.body).toBe(200);

    const overwritten = (await leaseRows()).find((l) => l.code === 'L-RESTORE-1') as Record<
      string,
      unknown
    >;
    expect(overwritten.area).toBe('6000.0000');
    expect(overwritten.rent_steps).toEqual([]);

    const rollback = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/models/${modelId}/imports/${batchId}/rollback`,
      headers: authed(owner.cookie),
    });
    expect(rollback.statusCode, rollback.body).toBe(200);
    expect(rollback.json()).toEqual({ restored: 1, deleted: 0 });

    const restored = (await leaseRows()).find((l) => l.code === 'L-RESTORE-1') as Record<
      string,
      unknown
    >;
    expect(restored.area).toBe('5000.0000');
    expect(restored.base_rent).toBe('25.000000');
    expect(restored.space_codes).toEqual(['WHOLE']);
    expect(restored.rent_steps).toEqual([
      { startDate: '2027-01-01', amount: '26.000000', basis: 'per_area_per_year' },
    ]);
  });

  it('refuses to roll back the same batch twice', async () => {
    const batchId = await analyze();
    await commit(
      csvOf(['L-TWICE-1,Rollback Tenant,STE-200,3000,2026-01-01,2030-12-31,22.00']),
      batchId,
    );

    const first = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/models/${modelId}/imports/${batchId}/rollback`,
      headers: authed(owner.cookie),
    });
    expect(first.statusCode).toBe(200);

    const second = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/models/${modelId}/imports/${batchId}/rollback`,
      headers: authed(owner.cookie),
    });
    expect(second.statusCode).toBe(400);
    expect(second.body).toContain('already been rolled back');
  });

  it('refuses to roll back a batch that has no snapshot to restore from', async () => {
    const batchId = await analyze();
    const committed = await commit(
      csvOf(['L-NOSNAP-1,Rollback Tenant,STE-300,2000,2026-01-01,2030-12-31,18.00']),
      batchId,
    );
    expect(committed.statusCode, committed.body).toBe(200);

    // Simulates a batch imported before this feature existed.
    await ctx.sql`UPDATE import_batches SET rollback_snapshot = NULL WHERE id = ${batchId}`;

    const response = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/models/${modelId}/imports/${batchId}/rollback`,
      headers: authed(owner.cookie),
    });
    expect(response.statusCode).toBe(400);
    expect(response.body).toContain('nothing to restore');
  });

  it('refuses to roll back a batch that was never committed', async () => {
    const batchId = await analyze();
    const response = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/models/${modelId}/imports/${batchId}/rollback`,
      headers: authed(owner.cookie),
    });
    expect(response.statusCode).toBe(400);
    expect(response.body).toContain('cannot be rolled back');
  });

  it('refuses to roll back a batch that does not exist in this organization', async () => {
    const response = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/models/${modelId}/imports/00000000-0000-0000-0000-000000000000/rollback`,
      headers: authed(owner.cookie),
    });
    expect(response.statusCode).toBe(404);
  });
});

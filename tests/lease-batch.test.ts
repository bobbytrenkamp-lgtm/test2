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
 * The batch lease write, which is what the rent-roll grid saves through.
 *
 * Filling a value down forty rows is *one* thing the analyst did. Sent as forty
 * requests it could half-succeed, leaving a rent roll in a state nobody chose
 * and no single audit entry describing it. So the endpoint takes the whole set
 * and applies it in one transaction.
 *
 * Three properties matter and each is tested by breaking it:
 *
 * 1. **Only the named fields change.** The grid shows six columns; a lease has
 *    thirty fields. A cell edit that quietly cleared a recovery structure or a
 *    rent step would be far worse than the edit was useful.
 * 2. **Whole-record validation still applies.** A grid cell can only see one
 *    value, but a lease term is a pair, so the server checks the pair.
 * 3. **All or nothing.** One stale or invalid row rejects the batch rather than
 *    leaving half of it written.
 */
describe.skipIf(!hasDatabase)('batch lease writes', () => {
  let ctx: TestContext;
  let owner: Actor;
  let modelId: string;
  let tenantId: string;

  beforeAll(async () => {
    ctx = await createTestContext();
    owner = await registerActor(ctx.app, 'lease-batch@example.invalid', 'Lease Batch');

    await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/organizations',
      headers: authed(owner.cookie),
      payload: { name: 'Ashgrove Partners' },
    });

    const property = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/properties',
      headers: authed(owner.cookie),
      payload: { name: 'Ashgrove Court', propertyType: 'office', rentableArea: '40000' },
    });
    const propertyId = (property.json() as { property: { id: string } }).property.id;

    const model = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/models',
      headers: authed(owner.cookie),
      payload: {
        propertyId,
        name: 'Base case',
        classification: 'valuation',
        valuationDate: '2026-01-01',
        forecastStartDate: '2026-01-01',
        forecastMonths: 24,
        discountRate: '0.08',
        terminalCapRate: '0.07',
        saleMonth: 24,
      },
    });
    modelId = (model.json() as { model: { id: string } }).model.id;

    const tenant = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/tenants',
      headers: authed(owner.cookie),
      payload: { name: 'Ashgrove Tenant' },
    });
    tenantId = (tenant.json() as { tenant: { id: string } }).tenant.id;
  }, 60_000);

  afterAll(async () => {
    await ctx?.close();
  });

  /** Creates a lease carrying structure the grid never shows. */
  async function seed(code: string, rent: string): Promise<void> {
    await ctx.app.inject({
      method: 'PUT',
      url: `/api/v1/models/${modelId}/leases/${code}`,
      headers: authed(owner.cookie),
      payload: {
        tenantId,
        status: 'occupied',
        area: '5000',
        spaceIds: [],
        commencementDate: '2026-01-01',
        expirationDate: '2031-12-31',
        baseRent: rent,
        baseRentBasis: 'per_area_per_year',
        // None of these has a grid column. They are what a careless merge
        // would destroy.
        rentSteps: [{ startDate: '2028-01-01', amount: '35.00', basis: 'per_area_per_year' }],
        escalation: { type: 'fixed_percent', rate: '0.03', frequencyMonths: 12 },
        recovery: { method: 'base_year', baseYear: 2026 },
        notes: 'Carried through.',
      },
    });
  }

  async function readAll(): Promise<
    Array<{
      code: string;
      version: number;
      base_rent: string;
      area: string;
      status: string;
      notes: string | null;
      rent_steps: unknown[];
      escalation: Record<string, unknown>;
      recovery: Record<string, unknown>;
    }>
  > {
    const response = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/models/${modelId}/leases`,
      headers: authed(owner.cookie),
    });
    return (response.json() as { leases: never[] }).leases;
  }

  async function read(code: string): Promise<Awaited<ReturnType<typeof readAll>>[number]> {
    const lease = (await readAll()).find((entry) => entry.code === code);
    if (!lease) throw new Error(`Lease ${code} not found`);
    return lease;
  }

  async function patch(changes: unknown[]): Promise<{ statusCode: number; body: string }> {
    const response = await ctx.app.inject({
      method: 'PATCH',
      url: `/api/v1/models/${modelId}/leases`,
      headers: authed(owner.cookie),
      payload: { changes },
    });
    return { statusCode: response.statusCode, body: response.body };
  }

  /* ---------------------------------------------------------------------- */

  it('applies one field across many leases in a single request', async () => {
    // The fill-down gesture: one value, many rows.
    await seed('B-1', '30.00');
    await seed('B-2', '31.00');
    await seed('B-3', '32.00');
    const before = await readAll();

    const result = await patch(
      ['B-1', 'B-2', 'B-3'].map((code) => ({
        code,
        expectedVersion: before.find((lease) => lease.code === code)?.version ?? null,
        fields: { baseRent: '40.00' },
      })),
    );

    expect(result.statusCode).toBe(200);
    expect(JSON.parse(result.body).count).toBe(3);
    for (const code of ['B-1', 'B-2', 'B-3']) {
      expect(Number((await read(code)).base_rent)).toBeCloseTo(40, 6);
    }
  });

  it('leaves every field the grid does not show exactly as it was', async () => {
    /*
     * The property most worth protecting. A lease has rent steps, an
     * escalation, a recovery structure and notes, none of which has a grid
     * column. Merging a cell edit by rebuilding the record from defaults would
     * silently delete all of them, and the cash flow would change for reasons
     * nobody could see in the diff.
     */
    await seed('B-KEEP', '30.00');
    const before = await read('B-KEEP');

    const result = await patch([
      { code: 'B-KEEP', expectedVersion: before.version, fields: { area: '7500' } },
    ]);
    expect(result.statusCode).toBe(200);

    const after = await read('B-KEEP');
    expect(Number(after.area)).toBeCloseTo(7500, 6);
    expect(after.rent_steps).toEqual(before.rent_steps);
    expect(after.escalation).toEqual(before.escalation);
    expect(after.recovery).toEqual(before.recovery);
    expect(after.notes).toBe('Carried through.');
    expect(Number(after.base_rent)).toBeCloseTo(30, 6);
  });

  it('checks the term across the pair, not just the cell that changed', async () => {
    // A grid cell can only see one date. The lease is the pair, so the server
    // reads the other one off the stored record.
    await seed('B-TERM', '30.00');
    const before = await read('B-TERM');

    const result = await patch([
      {
        code: 'B-TERM',
        expectedVersion: before.version,
        // Commencement stays 2026-01-01; this expiry precedes it.
        fields: { expirationDate: '2025-06-30' },
      },
    ]);

    expect(result.statusCode).toBe(400);
    expect(result.body).toContain('before it commences');
    // And nothing moved.
    expect((await read('B-TERM')).version).toBe(before.version);
  });

  it('validates the whole batch before writing any of it', async () => {
    /*
     * The first change is perfectly good and must still not land, because the
     * analyst asked for one operation and a half-applied rent roll is a state
     * they never chose.
     *
     * This proves the *pre-flight* check specifically: every row is validated
     * before the transaction opens, so an invalid row never reaches a write.
     * It does not prove rollback — removing the transaction entirely leaves
     * this test passing. The stale-version test below is the one that proves
     * that, because a version conflict can only be discovered mid-transaction.
     */
    await seed('B-ATOMIC-1', '30.00');
    await seed('B-ATOMIC-2', '30.00');
    const first = await read('B-ATOMIC-1');
    const second = await read('B-ATOMIC-2');

    const result = await patch([
      { code: 'B-ATOMIC-1', expectedVersion: first.version, fields: { baseRent: '99.00' } },
      {
        code: 'B-ATOMIC-2',
        expectedVersion: second.version,
        fields: { expirationDate: '2020-01-01' },
      },
    ]);

    expect(result.statusCode).toBe(400);
    expect(Number((await read('B-ATOMIC-1')).base_rent)).toBeCloseTo(30, 6);
    expect(Number((await read('B-ATOMIC-2')).base_rent)).toBeCloseTo(30, 6);
  });

  it('rolls back the rows it already wrote when a later one is stale', async () => {
    /*
     * The test that proves the transaction, and the reason it is written with
     * the good row *first*: a version conflict is only detectable once the
     * write is under way, so by the time B-STALE-2 fails, B-STALE-1 has already
     * been written and has to be taken back.
     *
     * Verified by removing `db.begin` from the route, which leaves every other
     * test in this file green and fails this one with B-STALE-1 at 44.
     */
    await seed('B-STALE-1', '30.00');
    await seed('B-STALE-2', '30.00');
    const opened = await readAll();
    const staleVersion = opened.find((lease) => lease.code === 'B-STALE-2')?.version ?? 1;

    // Someone else saves B-STALE-2 while this grid is open.
    await seed('B-STALE-2', '55.00');

    const result = await patch([
      {
        code: 'B-STALE-1',
        expectedVersion: opened.find((lease) => lease.code === 'B-STALE-1')?.version ?? null,
        fields: { baseRent: '44.00' },
      },
      { code: 'B-STALE-2', expectedVersion: staleVersion, fields: { baseRent: '44.00' } },
    ]);

    expect(result.statusCode).toBe(409);
    expect(result.body).toContain('Nothing in this batch was saved');
    // The good row did not land either, which is what "nothing was saved" means.
    expect(Number((await read('B-STALE-1')).base_rent)).toBeCloseTo(30, 6);
    expect(Number((await read('B-STALE-2')).base_rent)).toBeCloseTo(55, 6);
  });

  it('refuses a lease that is not on this model rather than creating one', async () => {
    const result = await patch([
      { code: 'B-GHOST', expectedVersion: null, fields: { baseRent: '10.00' } },
    ]);
    expect(result.statusCode).toBe(400);
    expect(result.body).toContain('not on this model');
    expect((await readAll()).some((lease) => lease.code === 'B-GHOST')).toBe(false);
  });

  it('bounds the batch so one request cannot rewrite an unbounded rent roll', async () => {
    const tooMany = Array.from({ length: 501 }, (_, index) => ({
      code: `B-${index}`,
      expectedVersion: null,
      fields: { baseRent: '10.00' },
    }));
    expect((await patch(tooMany)).statusCode).toBe(400);
  });

  it('records the operation, not each of its parts', async () => {
    await seed('B-AUDIT-1', '30.00');
    await seed('B-AUDIT-2', '30.00');
    const leases = await readAll();

    await patch(
      ['B-AUDIT-1', 'B-AUDIT-2'].map((code) => ({
        code,
        expectedVersion: leases.find((lease) => lease.code === code)?.version ?? null,
        fields: { baseRent: '41.00', area: '5100' },
      })),
    );

    const audit = await ctx.app.inject({
      method: 'GET',
      url: '/api/v1/audit?limit=20',
      headers: authed(owner.cookie),
    });
    const entries = (audit.json() as { entries: Array<{ action: string; new_value: unknown }> })
      .entries;
    const bulk = entries.find((entry) => entry.action === 'lease.bulk_saved');
    expect(bulk, 'no bulk audit entry was written').toBeDefined();
    const value = bulk?.new_value as { leaseCodes: string[]; fields: string[] };
    expect(value.leaseCodes).toEqual(['B-AUDIT-1', 'B-AUDIT-2']);
    expect(value.fields.sort()).toEqual(['area', 'baseRent']);
  });
});

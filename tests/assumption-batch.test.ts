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
 * Batched writes to the model-scoped assumption collections.
 *
 * The rent roll's batch endpoint enumerates the fields it accepts because a
 * lease has one shape. These six collections do not, so the endpoint merges
 * whatever fields it is given onto the stored row and lets the collection's own
 * `upsert` be the schema.
 *
 * That makes the merge the thing worth testing hardest. A custom monthly
 * schedule, a draw schedule, a recovery structure and an escalation are all
 * columns the grid never shows, and a merge that rebuilt the row from defaults
 * would silently delete them — changing the cash flow for reasons nobody could
 * see in the diff.
 */
describe.skipIf(!hasDatabase)('batched assumption writes', () => {
  let ctx: TestContext;
  let owner: Actor;
  let modelId: string;

  beforeAll(async () => {
    ctx = await createTestContext();
    owner = await registerActor(ctx.app, 'assumption-batch@example.invalid', 'Assumption Batch');

    await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/organizations',
      headers: authed(owner.cookie),
      payload: { name: 'Windmere Capital' },
    });

    const property = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/properties',
      headers: authed(owner.cookie),
      payload: { name: 'Windmere Park', propertyType: 'office', rentableArea: '60000' },
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
        forecastMonths: 36,
        discountRate: '0.08',
        terminalCapRate: '0.07',
        saleMonth: 36,
      },
    });
    modelId = (model.json() as { model: { id: string } }).model.id;
  }, 60_000);

  afterAll(async () => {
    await ctx?.close();
  });

  async function put(segment: string, code: string, body: unknown): Promise<number> {
    const response = await ctx.app.inject({
      method: 'PUT',
      url: `/api/v1/models/${modelId}/${segment}/${code}`,
      headers: authed(owner.cookie),
      payload: body,
    });
    return response.statusCode;
  }

  async function list(segment: string): Promise<Array<Record<string, unknown>>> {
    const response = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/models/${modelId}/${segment}`,
      headers: authed(owner.cookie),
    });
    return (response.json() as { items: Array<Record<string, unknown>> }).items;
  }

  async function row(segment: string, code: string): Promise<Record<string, unknown>> {
    const found = (await list(segment)).find((entry) => entry.code === code);
    if (!found) throw new Error(`${segment}/${code} not found`);
    return found;
  }

  async function patch(
    segment: string,
    changes: unknown[],
  ): Promise<{ statusCode: number; body: string }> {
    const response = await ctx.app.inject({
      method: 'PATCH',
      url: `/api/v1/models/${modelId}/${segment}`,
      headers: authed(owner.cookie),
      payload: { changes },
    });
    return { statusCode: response.statusCode, body: response.body };
  }

  /* ---------------------------------------------------------------------- */

  it('changes one field across many expenses in a single request', async () => {
    for (const [code, amount] of [
      ['E-1', '100000'],
      ['E-2', '120000'],
      ['E-3', '140000'],
    ]) {
      expect(
        await put('expenses', code as string, {
          name: `Expense ${code}`,
          category: 'operating',
          method: 'fixed_annual',
          amount,
        }),
      ).toBe(200);
    }

    const before = await list('expenses');
    const result = await patch(
      'expenses',
      ['E-1', 'E-2', 'E-3'].map((code) => ({
        code,
        expectedVersion: before.find((entry) => entry.code === code)?.version ?? null,
        fields: { variableShare: '0.4' },
      })),
    );

    expect(result.statusCode).toBe(200);
    expect(JSON.parse(result.body).count).toBe(3);
    for (const code of ['E-1', 'E-2', 'E-3']) {
      expect(Number((await row('expenses', code)).variable_share)).toBeCloseTo(0.4, 8);
    }
  });

  it('leaves a custom monthly schedule alone when a cell beside it changes', async () => {
    /*
     * The merge's whole reason to exist. A twelve-month schedule has no grid
     * column; rebuilding the row from defaults would blank it and the expense
     * would silently become zero for every month of the forecast.
     */
    const schedule = ['1000', '1100', '1200', '1300', '1400', '1500'];
    expect(
      await put('expenses', 'E-SCHEDULE', {
        name: 'Seasonal grounds maintenance',
        category: 'operating',
        method: 'custom_monthly_schedule',
        amount: '0',
        monthlySchedule: schedule,
        accountCode: '6120',
        sortOrder: 7,
      }),
    ).toBe(200);

    const before = await row('expenses', 'E-SCHEDULE');
    expect(before.monthly_schedule).toEqual(schedule);

    const result = await patch('expenses', [
      {
        code: 'E-SCHEDULE',
        expectedVersion: before.version,
        fields: { recoverableShare: '0.85' },
      },
    ]);
    expect(result.statusCode).toBe(200);

    const after = await row('expenses', 'E-SCHEDULE');
    expect(Number(after.recoverable_share)).toBeCloseTo(0.85, 8);
    expect(after.monthly_schedule).toEqual(schedule);
    expect(after.account_code).toBe('6120');
    expect(after.sort_order).toBe(7);
    expect(after.method).toBe('custom_monthly_schedule');
  });

  it('keeps a debt facility’s draw schedule and covenants through a rate edit', async () => {
    const draws = [{ date: '2026-07-01', amount: '2000000' }];
    expect(
      await put('debt', 'D-1', {
        name: 'Construction facility',
        type: 'construction',
        commitment: '12000000',
        initialFunding: '4000000',
        fundingDate: '2026-01-01',
        draws,
        rateType: 'floating',
        indexCurve: 'SOFR',
        spread: '0.025',
        rateFloor: '0.045',
        termMonths: 36,
        interestOnlyMonths: 36,
        minimumDscr: '1.20',
        maximumLtv: '0.65',
        capitalizeInterest: true,
      }),
    ).toBe(200);

    const before = await row('debt', 'D-1');
    const result = await patch('debt', [
      { code: 'D-1', expectedVersion: before.version, fields: { spread: '0.0325' } },
    ]);
    expect(result.statusCode).toBe(200);

    const after = await row('debt', 'D-1');
    expect(Number(after.spread)).toBeCloseTo(0.0325, 8);
    expect(after.draws).toEqual(draws);
    expect(Number(after.minimum_dscr)).toBeCloseTo(1.2, 6);
    expect(Number(after.maximum_ltv)).toBeCloseTo(0.65, 6);
    expect(after.capitalize_interest).toBe(true);
    expect(after.index_curve).toBe('SOFR');
    expect(Number(after.rate_floor)).toBeCloseTo(0.045, 8);
  });

  it('writes a date column back as a date, not as a timestamp', async () => {
    /*
     * A `DATE` column arrives from the driver as a `Date` object. Handing that
     * straight back to an upsert that expects `YYYY-MM-DD` writes a full
     * timestamp — and on a capital item, that silently moves which month the
     * spend lands in.
     */
    expect(
      await put('capital', 'C-1', {
        name: 'Roof replacement',
        category: 'building_improvement',
        method: 'one_time',
        amount: '450000',
        startDate: '2027-04-01',
        endDate: '2027-06-30',
      }),
    ).toBe(200);

    const before = await row('capital', 'C-1');
    expect(
      await patch('capital', [
        { code: 'C-1', expectedVersion: before.version, fields: { amount: '500000' } },
      ]),
    ).toMatchObject({ statusCode: 200 });

    const after = await row('capital', 'C-1');
    expect(Number(after.amount)).toBeCloseTo(500000, 2);
    expect(String(after.start_date)).toContain('2027-04-01');
    expect(String(after.end_date)).toContain('2027-06-30');
  });

  it('refuses a code that is not in the collection rather than creating one', async () => {
    const result = await patch('expenses', [
      { code: 'E-GHOST', expectedVersion: null, fields: { amount: '1' } },
    ]);
    expect(result.statusCode).toBe(400);
    expect(result.body).toContain('is not in this model');
    expect((await list('expenses')).some((entry) => entry.code === 'E-GHOST')).toBe(false);
  });

  it('rolls the batch back when a later row is stale', async () => {
    /*
     * Written with the good row first, so the conflict is only reached after
     * that row has been written and has to be taken back. This is the test that
     * proves the transaction rather than the pre-flight check.
     */
    for (const code of ['E-STALE-1', 'E-STALE-2']) {
      await put('expenses', code, {
        name: code,
        category: 'operating',
        method: 'fixed_annual',
        amount: '50000',
      });
    }
    const opened = await list('expenses');
    const staleVersion = opened.find((entry) => entry.code === 'E-STALE-2')?.version as number;

    // Somebody else saves E-STALE-2 while this grid is open.
    await put('expenses', 'E-STALE-2', {
      name: 'E-STALE-2',
      category: 'operating',
      method: 'fixed_annual',
      amount: '99999',
    });

    const result = await patch('expenses', [
      {
        code: 'E-STALE-1',
        expectedVersion: opened.find((entry) => entry.code === 'E-STALE-1')?.version ?? null,
        fields: { amount: '77777' },
      },
      { code: 'E-STALE-2', expectedVersion: staleVersion, fields: { amount: '77777' } },
    ]);

    expect(result.statusCode).toBe(409);
    expect(result.body).toContain('Nothing in this batch was saved');
    expect(Number((await row('expenses', 'E-STALE-1')).amount)).toBeCloseTo(50000, 2);
  });

  it('records the operation once, naming the rows and the fields', async () => {
    const before = await list('expenses');
    await patch('expenses', [
      {
        code: 'E-1',
        expectedVersion: before.find((entry) => entry.code === 'E-1')?.version ?? null,
        fields: { amount: '111000', recoverableShare: '0.5' },
      },
    ]);

    const audit = await ctx.app.inject({
      method: 'GET',
      url: '/api/v1/audit?limit=20',
      headers: authed(owner.cookie),
    });
    const entries = (audit.json() as { entries: Array<{ action: string; new_value: unknown }> })
      .entries;
    const bulk = entries.find((entry) => entry.action === 'expenses.bulk_saved');
    expect(bulk, 'no bulk audit entry was written').toBeDefined();
    const value = bulk?.new_value as { codes: string[]; fields: string[] };
    expect(value.codes).toEqual(['E-1']);
    expect(value.fields.sort()).toEqual(['amount', 'recoverableShare']);
  });

  it('bounds the batch so one request cannot rewrite an unbounded collection', async () => {
    const tooMany = Array.from({ length: 501 }, (_, index) => ({
      code: `E-${index}`,
      expectedVersion: null,
      fields: { amount: '1' },
    }));
    expect((await patch('expenses', tooMany)).statusCode).toBe(400);
  });

  it('refuses to write to an approved model', async () => {
    // The freeze is what makes an approved valuation reproducible; a batched
    // path around it would be a hole in that guarantee.
    const other = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/models',
      headers: authed(owner.cookie),
      payload: {
        propertyId: (await ctx.app
          .inject({
            method: 'GET',
            url: `/api/v1/models/${modelId}`,
            headers: authed(owner.cookie),
          })
          .then(
            (r) => (r.json() as { model: { property_id: string } }).model.property_id,
          )) as string,
        name: 'To be approved',
        classification: 'valuation',
        valuationDate: '2026-01-01',
        forecastStartDate: '2026-01-01',
        forecastMonths: 12,
      },
    });
    const frozenId = (other.json() as { model: { id: string } }).model.id;

    await ctx.app.inject({
      method: 'PUT',
      url: `/api/v1/models/${frozenId}/expenses/E-F`,
      headers: authed(owner.cookie),
      payload: { name: 'Frozen', category: 'operating', method: 'fixed_annual', amount: '1000' },
    });
    for (const status of ['analyst_review', 'manager_review', 'approved']) {
      await ctx.app.inject({
        method: 'POST',
        url: `/api/v1/models/${frozenId}/transition`,
        headers: authed(owner.cookie),
        payload: { to: status },
      });
    }

    const response = await ctx.app.inject({
      method: 'PATCH',
      url: `/api/v1/models/${frozenId}/expenses`,
      headers: authed(owner.cookie),
      payload: { changes: [{ code: 'E-F', expectedVersion: null, fields: { amount: '2000' } }] },
    });
    // 400, matching every other write path on a frozen model: the request is
    // well formed, the model is simply not editable.
    expect(response.statusCode).toBe(400);
    expect(response.body).toContain('cannot be edited');
  });
});

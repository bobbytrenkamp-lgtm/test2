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
 * The sensitivity grid's own numbers.
 *
 * `tests/scenario-sensitivity.test.ts` covers input validation and that a
 * grid comes back the right shape. Neither that file nor the browser suite
 * (`e2e/scenarios.spec.ts`, which reads rendered cells but derives no
 * independent expectation) checks that a cell actually holds what a real
 * engine run at that assumption produces. These tests do, the same way
 * `docs/feature-status.md` describes "Key value drivers" being verified:
 * by re-running the real engine and comparing, never by approximating.
 *
 * Two checks need no second engine run to be exact: a grid built at the
 * model's own current value must reproduce the model's own stored result
 * (the substitution is a no-op), and year-1 NOI does not depend on the
 * discount rate at all, so a `discountRate` sensitivity read through the
 * `year1Noi` metric must return the identical figure in every cell. A third
 * check cross-validates the two-way grid's composition against a one-way
 * run holding both assumptions at the same pair of values, which is what
 * actually proves rows and columns compose rather than only the diagonal
 * being right.
 */
describe.skipIf(!hasDatabase)('sensitivity grid values', () => {
  let ctx: TestContext;
  let owner: Actor;
  let modelId: string;

  beforeAll(async () => {
    ctx = await createTestContext();
    owner = await registerActor(ctx.app, 'sens-owner@example.invalid', 'Sensitivity Owner');

    const org = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/organizations',
      headers: authed(owner.cookie),
      payload: { name: 'Sensitivity Grid Holdings' },
    });
    expect(org.statusCode).toBe(201);

    const property = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/properties',
      headers: authed(owner.cookie),
      payload: { name: 'Sensitivity Grid Tower', propertyType: 'office', rentableArea: '20000' },
    });
    const propertyId = (property.json() as { property: { id: string } }).property.id;
    await ctx.app.inject({
      method: 'PUT',
      url: `/api/v1/properties/${propertyId}/spaces`,
      headers: authed(owner.cookie),
      payload: { spaces: [{ code: 'WHOLE', spaceType: 'office', area: '20000' }] },
    });

    const tenant = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/tenants',
      headers: authed(owner.cookie),
      payload: { name: 'Grid Anchor Tenant' },
    });
    const tenantId = (tenant.json() as { tenant: { id: string } }).tenant.id;

    const model = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/models',
      headers: authed(owner.cookie),
      payload: {
        propertyId,
        name: 'Sensitivity base case',
        classification: 'acquisition',
        valuationDate: '2026-01-01',
        forecastStartDate: '2026-01-01',
        forecastMonths: 36,
        discountRate: '0.08',
        terminalCapRate: '0.07',
        terminalNoiBasis: 'trailing_12',
        saleMonth: 36,
        saleCostPercent: '0',
        acquisitionPrice: '10000000',
      },
    });
    modelId = (model.json() as { model: { id: string } }).model.id;

    await ctx.app.inject({
      method: 'PUT',
      url: `/api/v1/models/${modelId}/leases/L-1`,
      headers: authed(owner.cookie),
      payload: {
        tenantId,
        status: 'occupied',
        area: '20000',
        spaceIds: ['WHOLE'],
        commencementDate: '2026-01-01',
        expirationDate: '2033-12-31',
        baseRent: '30.00',
        baseRentBasis: 'per_area_per_year',
      },
    });
  }, 90_000);

  afterAll(async () => {
    await ctx?.close();
  });

  async function sensitivity(body: unknown) {
    const response = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/models/${modelId}/sensitivity`,
      headers: authed(owner.cookie),
      payload: body,
    });
    expect(response.statusCode, response.body).toBe(200);
    return (response.json() as { grid: string[][] }).grid;
  }

  it('at the model’s own current value, reproduces the model’s own stored DCF value exactly', async () => {
    const calculated = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/models/${modelId}/calculate`,
      headers: authed(owner.cookie),
    });
    expect(calculated.statusCode, calculated.body).toBe(200);
    const baseline = (
      calculated.json() as { valuations: Array<{ method: string; value: string }> }
    ).valuations.find((v) => v.method === 'dcf')?.value;
    expect(baseline).toBeTruthy();

    const grid = await sensitivity({ rows: { variable: 'discountRate', values: ['0.08'] } });
    expect(grid).toEqual([[baseline]]);
  });

  it('a higher discount rate produces a strictly lower DCF value, cell by cell', async () => {
    const grid = await sensitivity({
      rows: { variable: 'discountRate', values: ['0.06', '0.08', '0.10', '0.12'] },
    });
    const values = grid.map((row) => Number(row[0]));
    for (let i = 1; i < values.length; i += 1) {
      expect(values[i]).toBeLessThan(values[i - 1] as number);
    }
  });

  it('year-1 NOI does not move with the discount rate, so every cell reads identically', async () => {
    const grid = await sensitivity({
      rows: { variable: 'discountRate', values: ['0.06', '0.08', '0.10', '0.12'] },
      metric: 'year1Noi',
    });
    const distinct = new Set(grid.map((row) => row[0]));
    expect(distinct.size).toBe(1);
  });

  it('a two-way cell equals a one-way run holding both assumptions at that same pair', async () => {
    const twoWay = await sensitivity({
      rows: { variable: 'discountRate', values: ['0.07', '0.08', '0.09'] },
      columns: { variable: 'terminalCapRate', values: ['0.065', '0.075'] },
    });
    expect(twoWay).toHaveLength(3);
    expect(twoWay.every((row) => row.length === 2)).toBe(true);

    // Cell [2][1]: discountRate 0.09, terminalCapRate 0.075.
    const composed = await sensitivity({
      rows: { variable: 'discountRate', values: ['0.09'] },
      columns: { variable: 'terminalCapRate', values: ['0.075'] },
    });
    expect(composed).toEqual([[twoWay[2]?.[1]]]);

    // A different pair, to confirm this is not an accident of one cell.
    // Cell [0][0]: discountRate 0.07, terminalCapRate 0.065.
    const composedFirst = await sensitivity({
      rows: { variable: 'discountRate', values: ['0.07'] },
      columns: { variable: 'terminalCapRate', values: ['0.065'] },
    });
    expect(composedFirst).toEqual([[twoWay[0]?.[0]]]);
  });
});

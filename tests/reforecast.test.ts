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
 * Building a reforecast from actuals and a model's forecast.
 *
 * The engine's own tests prove the arithmetic against hand-derived figures.
 * These prove what only the route can get wrong: that a reforecast can only be
 * built from a period of actuals, that the model has to have been calculated,
 * and that the result is written as a real budget period the variance screen
 * can then compare against.
 */
describe.skipIf(!hasDatabase)('reforecast', () => {
  let ctx: TestContext;
  let owner: Actor;
  let propertyId: string;
  let modelId: string;
  let actualsId: string;

  beforeAll(async () => {
    ctx = await createTestContext();
    owner = await registerActor(ctx.app, 'reforecast@example.invalid', 'Reforecast Owner');

    await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/organizations',
      headers: authed(owner.cookie),
      payload: { name: 'Reforecast Partners' },
    });

    const property = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/properties',
      headers: authed(owner.cookie),
      payload: { name: 'Reforecast House', propertyType: 'office', rentableArea: '50000' },
    });
    propertyId = (property.json() as { property: { id: string } }).property.id;

    await ctx.app.inject({
      method: 'PUT',
      url: `/api/v1/properties/${propertyId}/spaces`,
      headers: authed(owner.cookie),
      payload: { spaces: [{ code: 'WHOLE', area: '50000', spaceType: 'office' }] },
    });

    const model = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/models',
      headers: authed(owner.cookie),
      payload: {
        propertyId,
        name: 'FY2026 plan',
        classification: 'budget',
        valuationDate: '2026-01-01',
        forecastStartDate: '2026-01-01',
        forecastMonths: 12,
        discountRate: '0.08',
        terminalCapRate: '0.07',
      },
    });
    modelId = (model.json() as { model: { id: string } }).model.id;

    const tenant = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/tenants',
      headers: authed(owner.cookie),
      payload: { propertyId, name: 'Reforecast Tenant' },
    });
    const tenantId = (tenant.json() as { tenant: { id: string } }).tenant.id;

    // 50,000 sqft at $24.00 is 1,200,000 a year, so 100,000 a month exactly.
    await ctx.app.inject({
      method: 'PUT',
      url: `/api/v1/models/${modelId}/leases/L-1`,
      headers: authed(owner.cookie),
      payload: {
        tenantId,
        status: 'occupied',
        area: '50000',
        spaceIds: ['WHOLE'],
        commencementDate: '2026-01-01',
        expirationDate: '2035-12-31',
        baseRent: '24.00',
        baseRentBasis: 'per_area_per_year',
        excludeFromRollover: true,
      },
    });

    await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/models/${modelId}/calculate`,
      headers: authed(owner.cookie),
      payload: {},
    });

    // Actuals for the first two months: January came in light, February heavy.
    // The account code matches the one the engine's chart uses for scheduled
    // base rent, which is what a ledger mapping is for — a code that does not
    // match is a different case, covered below.
    const actuals = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/budgets',
      headers: authed(owner.cookie),
      payload: { propertyId, kind: 'actual', fiscalYear: 2026, label: 'FY2026 actuals' },
    });
    actualsId = (actuals.json() as { period: { id: string } }).period.id;

    await ctx.app.inject({
      method: 'PUT',
      url: `/api/v1/budgets/${actualsId}/entries`,
      headers: authed(owner.cookie),
      payload: {
        entries: [
          {
            accountCode: '4000',
            accountName: 'Base rent',
            accountCategory: 'revenue',
            periodMonth: '2026-01-01',
            amount: '95000',
          },
          {
            accountCode: '4000',
            accountName: 'Base rent',
            accountCategory: 'revenue',
            periodMonth: '2026-02-01',
            amount: '108000',
          },
        ],
      },
    });
  }, 90_000);

  afterAll(async () => {
    await ctx?.close();
  });

  async function reforecast(
    body: Record<string, unknown>,
  ): Promise<{ statusCode: number; body: string }> {
    const response = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/budgets/${actualsId}/reforecast`,
      headers: authed(owner.cookie),
      payload: body,
    });
    return { statusCode: response.statusCode, body: response.body };
  }

  it('writes a period holding the closed months and the forecast after them', async () => {
    const result = await reforecast({
      modelId,
      closedThrough: '2026-02-01',
      label: 'FY2026 reforecast at February',
    });
    expect(result.statusCode).toBe(201);
    const created = JSON.parse(result.body) as {
      period: { id: string; kind: string };
      actualMonths: number;
      forecastMonths: number;
    };
    expect(created.period.kind).toBe('reforecast');
    expect(created.actualMonths).toBe(2);
    expect(created.forecastMonths).toBe(10);

    const read = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/budgets/${created.period.id}`,
      headers: authed(owner.cookie),
    });
    const entries = (
      read.json() as {
        entries: Array<{ account_code: string; period_month: string; amount: string }>;
      }
    ).entries;

    const rentIn = (month: string): string | undefined =>
      entries.find((entry) => entry.account_code === '4000' && entry.period_month.startsWith(month))
        ?.amount;

    // January and February are what the ledger recorded, not what was planned.
    expect(Number(rentIn('2026-01'))).toBeCloseTo(95000, 2);
    expect(Number(rentIn('2026-02'))).toBeCloseTo(108000, 2);
    // March onwards is still the model: 1,200,000 a year is 100,000 a month.
    expect(Number(rentIn('2026-03'))).toBeCloseTo(100000, 2);
    expect(Number(rentIn('2026-12'))).toBeCloseTo(100000, 2);
  });

  it('names an account the ledger posted that the forecast cannot carry forward', async () => {
    // A code the engine's chart has no line for. It happened, so it belongs in
    // the closed months — but nothing projects it into the rest of the year,
    // and dropping it silently would understate the reforecast.
    await ctx.app.inject({
      method: 'PUT',
      url: `/api/v1/budgets/${actualsId}/entries`,
      headers: authed(owner.cookie),
      payload: {
        entries: [
          {
            accountCode: '9100',
            accountName: 'Legal settlement',
            accountCategory: 'operating_expense',
            periodMonth: '2026-01-01',
            amount: '-12000',
          },
        ],
      },
    });

    const result = await reforecast({
      modelId,
      closedThrough: '2026-02-01',
      label: 'FY2026 reforecast with an unforecast account',
    });
    const created = JSON.parse(result.body) as {
      period: { id: string };
      unforecastAccounts: Array<{ accountCode: string }>;
      unpostedAccounts: Array<{ accountCode: string; months: string[] }>;
    };
    expect(created.unforecastAccounts.map((entry) => entry.accountCode)).toContain('9100');

    // And it is still in the period, because it is part of what happened.
    const read = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/budgets/${created.period.id}`,
      headers: authed(owner.cookie),
    });
    const entries = (read.json() as { entries: Array<{ account_code: string }> }).entries;
    expect(entries.some((entry) => entry.account_code === '9100')).toBe(true);

    // The forecast also expects accounts the ledger posted nothing against —
    // an operating expense line, say — and those are named rather than assumed
    // to be genuine zeroes.
    expect(created.unpostedAccounts.length).toBeGreaterThan(0);
  });

  it('refuses to build one from a plan rather than a record of what happened', async () => {
    const budget = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/budgets',
      headers: authed(owner.cookie),
      payload: { propertyId, kind: 'approved_budget', fiscalYear: 2026, label: 'FY2026 budget' },
    });
    const budgetId = (budget.json() as { period: { id: string } }).period.id;

    const response = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/budgets/${budgetId}/reforecast`,
      headers: authed(owner.cookie),
      payload: { modelId, closedThrough: '2026-02-01', label: 'Nonsense' },
    });
    expect(response.statusCode).toBe(400);
    expect(response.body).toContain('actuals');
  });

  it('refuses when the model has never been calculated', async () => {
    // Carrying forward a forecast that does not exist would produce a
    // reforecast that is only the actuals, silently missing three quarters of
    // the year.
    const uncalculated = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/models',
      headers: authed(owner.cookie),
      payload: {
        propertyId,
        name: 'Never calculated',
        classification: 'budget',
        valuationDate: '2026-01-01',
        forecastStartDate: '2026-01-01',
        forecastMonths: 12,
        discountRate: '0.08',
        terminalCapRate: '0.07',
      },
    });
    const uncalculatedId = (uncalculated.json() as { model: { id: string } }).model.id;

    const result = await reforecast({
      modelId: uncalculatedId,
      closedThrough: '2026-02-01',
      label: 'FY2026 from an uncalculated model',
    });
    expect(result.statusCode).toBe(400);
    expect(result.body).toContain('calculated');
  });

  it('refuses to build a reforecast from a different property’s model', async () => {
    /*
     * Found by a twelfth audit pass: `/variance`'s comparisonModelId branch
     * checks the model and the base budget share a property; this route's
     * only structurally identical branch — a model's forecast is carried
     * forward the same way — had no equivalent check. Without it, a
     * reforecast for this property's actuals could be built entirely from
     * an unrelated property's forecast, with no error and no way to tell
     * from the resulting budget period that it happened.
     */
    const otherProperty = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/properties',
      headers: authed(owner.cookie),
      payload: { name: 'Reforecast Annexe', propertyType: 'office', rentableArea: '20000' },
    });
    const otherPropertyId = (otherProperty.json() as { property: { id: string } }).property.id;

    const otherModel = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/models',
      headers: authed(owner.cookie),
      payload: {
        propertyId: otherPropertyId,
        name: 'Annexe base case',
        classification: 'acquisition',
        valuationDate: '2026-01-01',
        forecastStartDate: '2026-01-01',
        forecastMonths: 12,
        saleMonth: 12,
      },
    });
    const otherModelId = (otherModel.json() as { model: { id: string } }).model.id;
    await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/models/${otherModelId}/calculate`,
      headers: authed(owner.cookie),
    });

    const result = await reforecast({
      modelId: otherModelId,
      closedThrough: '2026-02-01',
      label: 'FY2026 reforecast from the wrong property',
    });
    expect(result.statusCode).toBe(400);
    expect(result.body).toContain('same property');
  });

  it('can then be compared against the original budget', async () => {
    // The point of writing it as a real period: the variance screen treats it
    // like any other, so a reforecast can be reported against without a second
    // mechanism existing.
    const created = JSON.parse(
      (
        await reforecast({
          modelId,
          closedThrough: '2026-02-01',
          label: 'FY2026 reforecast for variance',
        })
      ).body,
    ) as { period: { id: string } };

    const response = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/variance?baseId=${created.period.id}&comparisonModelId=${modelId}`,
      headers: authed(owner.cookie),
    });
    expect(response.statusCode).toBe(200);
    const body = response.json() as { report: { rows: unknown[] } };
    expect(body.report.rows.length).toBeGreaterThan(0);
  });
});

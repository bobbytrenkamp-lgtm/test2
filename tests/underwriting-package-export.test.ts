import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import ExcelJS from 'exceljs';
import {
  authed,
  createTestContext,
  hasDatabase,
  registerActor,
  type Actor,
  type TestContext,
} from './helpers.js';

/**
 * The underwriting package: one workbook, one click, everything a committee
 * needs, instead of a reviewer assembling it by hand from five separate
 * tabs and exports. What this covers is exactly the promise the feature
 * makes: the investment-committee-summary sheet it adds carries the same
 * figures `GET /models/:id/health` and `GET /models/:id/cashflow` already
 * report — nothing here is a second, possibly-disagreeing computation — and
 * the rest of the workbook is the same property reports `/export/workbook`
 * already produces.
 */
describe.skipIf(!hasDatabase)('underwriting package export', () => {
  let ctx: TestContext;
  let owner: Actor;
  let modelId: string;

  beforeAll(async () => {
    ctx = await createTestContext();
    owner = await registerActor(ctx.app, 'package@example.invalid', 'Package Owner');

    await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/organizations',
      headers: authed(owner.cookie),
      payload: { name: 'Underwriting Package Partners' },
    });

    const property = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/properties',
      headers: authed(owner.cookie),
      payload: {
        name: 'Package House',
        propertyType: 'office',
        market: 'Central',
        rentableArea: '40000',
      },
    });
    const propertyId = (property.json() as { property: { id: string } }).property.id;

    await ctx.app.inject({
      method: 'PUT',
      url: `/api/v1/properties/${propertyId}/spaces`,
      headers: authed(owner.cookie),
      payload: { spaces: [{ code: 'WHOLE', area: '40000', spaceType: 'office' }] },
    });

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
        forecastMonths: 60,
        discountRate: '0.08',
        terminalCapRate: '0.065',
        saleMonth: 60,
        acquisitionPrice: '9500000',
      },
    });
    modelId = (model.json() as { model: { id: string } }).model.id;

    const tenant = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/tenants',
      headers: authed(owner.cookie),
      payload: { propertyId, name: 'Anchor Tenant' },
    });
    const tenantId = (tenant.json() as { tenant: { id: string } }).tenant.id;

    await ctx.app.inject({
      method: 'PUT',
      url: `/api/v1/models/${modelId}/leases/L-1`,
      headers: authed(owner.cookie),
      payload: {
        tenantId,
        status: 'occupied',
        area: '40000',
        spaceIds: ['WHOLE'],
        commencementDate: '2026-01-01',
        expirationDate: '2030-12-31',
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
  });

  afterAll(async () => {
    await ctx?.close();
  });

  it('serves a workbook with the summary sheet plus every property report', async () => {
    const response = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/models/${modelId}/export/underwriting-package`,
      headers: authed(owner.cookie),
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain('spreadsheetml.sheet');

    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(response.rawPayload as unknown as ArrayBuffer);

    // Sheet *names* are Excel's own 31-character limit truncating the full
    // report titles, so the full title is read from each sheet's own first
    // row (which `reportToWorkbook` always writes in full) rather than from
    // the truncated name.
    const firstRowText = (index: number): string =>
      String(workbook.worksheets[index]?.getRow(1).getCell(1).value ?? '');

    // The summary leads the workbook, same as a reviewer would want to open
    // it first.
    expect(firstRowText(0)).toContain('investment committee summary');

    const allTitles = workbook.worksheets.map((_, index) => firstRowText(index));
    expect(allTitles.some((title) => title.includes('annual cash flow'))).toBe(true);
    expect(allTitles.some((title) => title.includes('rent roll'))).toBe(true);
    // The summary plus every property-category report.
    expect(workbook.worksheets).toHaveLength(10);
  });

  it('reports the same returns the Returns tab and Health tab already show, never a second computation', async () => {
    const cashflow = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/models/${modelId}/cashflow`,
      headers: authed(owner.cookie),
    });
    const { returns } = cashflow.json() as {
      returns: { unleveredIrr: string | null; equityMultiple: string | null };
    };

    const health = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/models/${modelId}/health`,
      headers: authed(owner.cookie),
    });
    const { findings } = health.json() as {
      findings: Array<{ severity: string; title: string }>;
    };

    const response = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/models/${modelId}/export/underwriting-package`,
      headers: authed(owner.cookie),
    });
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(response.rawPayload as unknown as ArrayBuffer);
    // The summary is always the first sheet added; its truncated name is
    // not a stable lookup key (see the previous test), so it is found by
    // position instead.
    const summary = workbook.worksheets[0];
    expect(summary).toBeDefined();

    // Read as metric -> value pairs (columns are Section, Metric, Value),
    // not flattened into one blob: this model has no debt, so unlevered
    // and levered IRR are legitimately identical, and a flattened
    // substring check could not tell a value in the right row from the
    // same number sitting in the wrong one.
    const byMetric = new Map<string, string>();
    summary?.eachRow((row) => {
      const metric = String(row.getCell(2).value ?? '');
      if (metric) byMetric.set(metric, String(row.getCell(3).value ?? ''));
    });

    expect(byMetric.get('Unlevered IRR')).toBe(returns.unleveredIrr);
    expect(byMetric.get('Equity multiple')).toBe(returns.equityMultiple);

    // Every warning/note the Health tab would show is named on the summary
    // sheet, not silently dropped.
    const metricLabels = [...byMetric.keys()].join(' | ');
    for (const finding of findings.filter((entry) => entry.severity !== 'pass')) {
      expect(metricLabels).toContain(finding.title);
    }
  });

  it('names the file safely and descriptively', async () => {
    const response = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/models/${modelId}/export/underwriting-package`,
      headers: authed(owner.cookie),
    });

    const disposition = String(response.headers['content-disposition']);
    expect(disposition).toMatch(/attachment; filename="package-house-underwriting-package\.xlsx"/);
    expect(disposition).not.toMatch(/[/\\]/);
  });

  it('refuses a model that has never been calculated', async () => {
    const property = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/properties',
      headers: authed(owner.cookie),
      payload: { name: 'Uncalculated Package', propertyType: 'office', rentableArea: '1000' },
    });
    const propertyId = (property.json() as { property: { id: string } }).property.id;

    const model = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/models',
      headers: authed(owner.cookie),
      payload: {
        propertyId,
        name: 'Never run',
        classification: 'valuation',
        valuationDate: '2026-01-01',
        forecastStartDate: '2026-01-01',
        forecastMonths: 12,
        discountRate: '0.08',
      },
    });
    const uncalculated = (model.json() as { model: { id: string } }).model.id;

    const response = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/models/${uncalculated}/export/underwriting-package`,
      headers: authed(owner.cookie),
    });

    expect(response.statusCode).toBe(422);
    expect(response.body).toContain('not been calculated');
  });

  it('cannot be exported from another organization', async () => {
    const stranger = await registerActor(ctx.app, 'stranger-package@example.invalid', 'Stranger');
    await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/organizations',
      headers: authed(stranger.cookie),
      payload: { name: 'Unrelated Holdings' },
    });

    const response = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/models/${modelId}/export/underwriting-package`,
      headers: authed(stranger.cookie),
    });
    expect(response.statusCode).toBe(404);
  });
});

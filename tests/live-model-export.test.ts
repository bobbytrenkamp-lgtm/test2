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
 * The Excel Live Model, downloaded the way a user downloads it.
 *
 * The workbook builder is reconciled to the engine in
 * `packages/reporting/src/excel-model`. What that cannot prove is that the
 * route serves a real file: the right content type, a filename that is safe to
 * write to disk, and bytes a spreadsheet library will actually open. That is
 * what this covers.
 */
describe.skipIf(!hasDatabase)('Excel Live Model export', () => {
  let ctx: TestContext;
  let owner: Actor;
  let modelId: string;

  beforeAll(async () => {
    ctx = await createTestContext();
    owner = await registerActor(ctx.app, 'livemodel@example.invalid', 'Live Model Owner');

    await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/organizations',
      headers: authed(owner.cookie),
      payload: { name: 'Live Model Partners' },
    });

    const property = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/properties',
      headers: authed(owner.cookie),
      payload: {
        name: 'Live Model House',
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

  it('serves a workbook a spreadsheet library can open', async () => {
    const response = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/models/${modelId}/export/live-model`,
      headers: authed(owner.cookie),
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain('spreadsheetml.sheet');

    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(response.rawPayload as unknown as ArrayBuffer);

    // The sheets a reader is promised.
    const names = workbook.worksheets.map((sheet) => sheet.name);
    expect(names).toEqual(
      expect.arrayContaining([
        'Summary',
        'Assumptions',
        'Rent Roll',
        'Recoveries',
        'Revenue',
        'Expenses',
        'Cash Flow',
        'Returns',
      ]),
    );
  });

  it('names the file safely and descriptively', async () => {
    const response = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/models/${modelId}/export/live-model`,
      headers: authed(owner.cookie),
    });

    const disposition = String(response.headers['content-disposition']);
    expect(disposition).toMatch(
      /attachment; filename="Live_Model_House_Base_case_\d{4}-\d{2}-\d{2}\.xlsx"/,
    );
    // A filename containing a separator would let a download escape its folder.
    expect(disposition).not.toMatch(/[/\\]/);
  });

  it('reports its formula coverage rather than leaving the claim unverifiable', async () => {
    const response = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/models/${modelId}/export/live-model`,
      headers: authed(owner.cookie),
    });

    const coverage = Number(response.headers['x-formula-coverage']);
    expect(coverage).toBeGreaterThan(0.5);
    expect(coverage).toBeLessThanOrEqual(1);
    expect(Number(response.headers['x-formula-cells'])).toBeGreaterThan(0);
    expect(Number(response.headers['x-calculated-cells'])).toBeGreaterThanOrEqual(
      Number(response.headers['x-formula-cells']),
    );
  });

  it('contains real formulas, not the numbers they produce', async () => {
    const response = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/models/${modelId}/export/live-model`,
      headers: authed(owner.cookie),
    });

    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(response.rawPayload as unknown as ArrayBuffer);

    // Walk the Cash Flow sheet and confirm a substantial share of its populated
    // cells are formulas. A workbook of pasted values would fail here.
    const sheet = workbook.getWorksheet('Cash Flow');
    let formulas = 0;
    let populated = 0;
    sheet?.eachRow((row) => {
      row.eachCell((cell) => {
        populated += 1;
        if (typeof cell.value === 'object' && cell.value !== null && 'formula' in cell.value) {
          formulas += 1;
        }
      });
    });

    expect(populated).toBeGreaterThan(100);
    expect(formulas / populated).toBeGreaterThan(0.5);
  });

  it('refuses a model that has never been calculated', async () => {
    const property = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/properties',
      headers: authed(owner.cookie),
      payload: { name: 'Uncalculated', propertyType: 'office', rentableArea: '1000' },
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
      url: `/api/v1/models/${uncalculated}/export/live-model`,
      headers: authed(owner.cookie),
    });

    // Better a clear refusal than a workbook of zeroes that looks like a model.
    expect(response.statusCode).toBe(422);
    expect(response.body).toContain('not been calculated');
  });
});

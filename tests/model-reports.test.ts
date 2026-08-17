import ExcelJS from 'exceljs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseCsv } from '../packages/reporting/src/index.js';
import {
  authed,
  createTestContext,
  hasDatabase,
  registerActor,
  type Actor,
  type TestContext,
} from './helpers.js';

/**
 * The general reports/exports engine, at the API layer.
 *
 * `tests/portfolio-reports.test.ts` covers portfolio- and fund-level
 * reports. Nothing exercised the per-model report route
 * (`GET /models/:id/reports/:reportId`) at all — not the report catalogue,
 * not the four output formats, and not the claim its own doc comment
 * makes: "the same report definition serves every format, so JSON, CSV,
 * spreadsheet and print views of a report can never disagree." That claim
 * is exactly what these tests check, by parsing each format's own bytes
 * back into data and comparing it against the JSON format's, rather than
 * trusting that four code paths sharing one `build()` call must agree.
 */
describe.skipIf(!hasDatabase)('model reports and exports', () => {
  let ctx: TestContext;
  let owner: Actor;
  let modelId: string;

  beforeAll(async () => {
    ctx = await createTestContext();
    owner = await registerActor(ctx.app, 'reports-owner@example.invalid', 'Reports Owner');

    const org = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/organizations',
      headers: authed(owner.cookie),
      payload: { name: 'Reports Test Partners' },
    });
    expect(org.statusCode).toBe(201);

    const property = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/properties',
      headers: authed(owner.cookie),
      payload: { name: 'Reports Tower', propertyType: 'office', rentableArea: '15000' },
    });
    const propertyId = (property.json() as { property: { id: string } }).property.id;
    await ctx.app.inject({
      method: 'PUT',
      url: `/api/v1/properties/${propertyId}/spaces`,
      headers: authed(owner.cookie),
      payload: { spaces: [{ code: 'WHOLE', spaceType: 'office', area: '15000' }] },
    });

    const tenant = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/tenants',
      headers: authed(owner.cookie),
      payload: { name: 'Reports Anchor Tenant' },
    });
    const tenantId = (tenant.json() as { tenant: { id: string } }).tenant.id;

    const model = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/models',
      headers: authed(owner.cookie),
      payload: {
        propertyId,
        name: 'Reports base case',
        classification: 'valuation',
        valuationDate: '2026-01-01',
        forecastStartDate: '2026-01-01',
        forecastMonths: 24,
        discountRate: '0.08',
        terminalCapRate: '0.07',
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
        area: '15000',
        spaceIds: ['WHOLE'],
        commencementDate: '2026-01-01',
        expirationDate: '2032-12-31',
        baseRent: '32.00',
        baseRentBasis: 'per_area_per_year',
      },
    });
  }, 90_000);

  afterAll(async () => {
    await ctx?.close();
  });

  it('lists the report catalogue', async () => {
    const response = await ctx.app.inject({
      method: 'GET',
      url: '/api/v1/reports',
      headers: authed(owner.cookie),
    });
    expect(response.statusCode).toBe(200);
    const reports = (response.json() as { reports: Array<{ id: string; category: string }> })
      .reports;
    expect(reports.map((r) => r.id)).toContain('rent-roll');
    expect(reports.every((r) => ['property', 'portfolio'].includes(r.category))).toBe(true);
  });

  it('refuses an unknown report id', async () => {
    const response = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/models/${modelId}/reports/not-a-report`,
      headers: authed(owner.cookie),
    });
    expect(response.statusCode).toBe(404);
  });

  it('refuses to report on a model that has not been calculated', async () => {
    const response = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/models/${modelId}/reports/rent-roll`,
      headers: authed(owner.cookie),
    });
    expect(response.statusCode).toBe(422);
  });

  describe('once calculated', () => {
    beforeAll(async () => {
      const calculated = await ctx.app.inject({
        method: 'POST',
        url: `/api/v1/models/${modelId}/calculate`,
        headers: authed(owner.cookie),
      });
      expect(calculated.statusCode, calculated.body).toBe(200);
    });

    it('JSON, CSV, XLSX and HTML all agree on the same figures', async () => {
      const jsonResponse = await ctx.app.inject({
        method: 'GET',
        url: `/api/v1/models/${modelId}/reports/rent-roll?format=json`,
        headers: authed(owner.cookie),
      });
      expect(jsonResponse.statusCode).toBe(200);
      const table = (
        jsonResponse.json() as {
          report: {
            columns: Array<{ key: string; label: string }>;
            rows: Array<Record<string, string>>;
            totals?: Record<string, string>;
          };
        }
      ).report;
      // A real lease produced a real row — this is not an empty-table pass.
      expect(table.rows.length).toBeGreaterThan(0);
      expect(table.rows[0]?.tenant).toBe('Reports Anchor Tenant');

      const csvResponse = await ctx.app.inject({
        method: 'GET',
        url: `/api/v1/models/${modelId}/reports/rent-roll?format=csv`,
        headers: authed(owner.cookie),
      });
      expect(csvResponse.statusCode).toBe(200);
      expect(csvResponse.headers['content-type']).toContain('text/csv');
      const csvRows = parseCsv(csvResponse.body);
      // Header row matches the JSON format's own column labels.
      expect(csvRows[0]).toEqual(table.columns.map((c) => c.label));
      // Every data row, cell by cell, matches the JSON format's rows.
      table.rows.forEach((row, index) => {
        expect(csvRows[index + 1]).toEqual(table.columns.map((c) => row[c.key] ?? ''));
      });
      if (table.totals) {
        expect(csvRows[csvRows.length - 1]).toEqual(
          table.columns.map((c) => table.totals?.[c.key] ?? ''),
        );
      }

      const xlsxResponse = await ctx.app.inject({
        method: 'GET',
        url: `/api/v1/models/${modelId}/reports/rent-roll?format=xlsx`,
        headers: authed(owner.cookie),
      });
      expect(xlsxResponse.statusCode).toBe(200);
      const workbook = new ExcelJS.Workbook();
      await workbook.xlsx.load(xlsxResponse.rawPayload as unknown as Buffer);
      const sheet = workbook.worksheets[0];
      expect(sheet).toBeDefined();
      // Row 1 is the report title, row 2 its description; the column
      // headers are row 3 (see reportToWorkbook, and the sheet's own
      // ySplit: 3 frozen-rows view).
      const headerRow = (sheet?.getRow(3).values as unknown[]).slice(1).map(String);
      expect(headerRow).toEqual(table.columns.map((c) => c.label));
      table.rows.forEach((row, index) => {
        const sheetRow = (sheet?.getRow(index + 4).values as unknown[]).slice(1);
        table.columns.forEach((column, columnIndex) => {
          const expected = row[column.key] ?? '';
          const actual = sheetRow[columnIndex];
          // A non-text column is written as a real number (reportToWorkbook's
          // own `coerce`), so "32.00" round-trips through the cell as 32 --
          // compared numerically. A text column is compared as the same string.
          if (column.format === 'text') {
            expect(String(actual ?? '')).toBe(expected);
          } else {
            expect(Number(actual)).toBe(Number(expected));
          }
        });
      });

      const htmlResponse = await ctx.app.inject({
        method: 'GET',
        url: `/api/v1/models/${modelId}/reports/rent-roll?format=html`,
        headers: authed(owner.cookie),
      });
      expect(htmlResponse.statusCode).toBe(200);
      expect(htmlResponse.headers['content-type']).toContain('text/html');
      // The tenant name and the total rent both reach the printable view.
      expect(htmlResponse.body).toContain('Reports Anchor Tenant');
      if (table.totals?.annualRent) {
        expect(htmlResponse.body).toContain(table.totals.annualRent);
      }
    });

    it('gates the xlsx format behind export:run, which report:read alone does not carry', async () => {
      const orgResponse = await ctx.app.inject({
        method: 'GET',
        url: '/api/v1/organizations',
        headers: authed(owner.cookie),
      });
      const organizationId = (
        orgResponse.json() as { organizations: Array<{ organization_id: string }> }
      ).organizations[0]?.organization_id;

      const outsider = await registerActor(
        ctx.app,
        'reports-readonly@example.invalid',
        'Read Only',
      );
      const invitation = await ctx.app.inject({
        method: 'POST',
        url: `/api/v1/organizations/${organizationId}/invitations`,
        headers: authed(owner.cookie),
        payload: { email: outsider.email, role: 'read_only' },
      });
      const token = (invitation.json() as { token: string }).token;
      await ctx.app.inject({
        method: 'POST',
        url: '/api/v1/invitations/accept',
        headers: authed(outsider.cookie),
        payload: { token },
      });

      const csvAsReadOnly = await ctx.app.inject({
        method: 'GET',
        url: `/api/v1/models/${modelId}/reports/rent-roll?format=csv`,
        headers: authed(outsider.cookie),
      });
      expect(csvAsReadOnly.statusCode).toBe(200);

      const xlsxAsReadOnly = await ctx.app.inject({
        method: 'GET',
        url: `/api/v1/models/${modelId}/reports/rent-roll?format=xlsx`,
        headers: authed(outsider.cookie),
      });
      expect(xlsxAsReadOnly.statusCode).toBe(403);
    });

    it('bundles every property report into one workbook', async () => {
      const catalogue = await ctx.app.inject({
        method: 'GET',
        url: '/api/v1/reports',
        headers: authed(owner.cookie),
      });
      const propertyReportCount = (
        catalogue.json() as { reports: Array<{ category: string }> }
      ).reports.filter((r) => r.category === 'property').length;

      const response = await ctx.app.inject({
        method: 'GET',
        url: `/api/v1/models/${modelId}/export/workbook`,
        headers: authed(owner.cookie),
      });
      expect(response.statusCode).toBe(200);
      const workbook = new ExcelJS.Workbook();
      await workbook.xlsx.load(response.rawPayload as unknown as Buffer);
      expect(workbook.worksheets).toHaveLength(propertyReportCount);
    });
  });
});

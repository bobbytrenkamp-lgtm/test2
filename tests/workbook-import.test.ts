import ExcelJS from 'exceljs';
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
 * Importing a spreadsheet through the API.
 *
 * The reader is unit-tested against real `.xlsx` bytes in
 * `packages/reporting/src/workbook-import.test.ts`. These are the questions the
 * reader alone cannot answer:
 *
 *   - do all three steps of the wizard read the *same* sheet, so what is
 *     committed is what was previewed;
 *   - does a workbook actually reach the rent roll, dates intact;
 *   - does a client that sends no filename still get CSV behaviour, so the
 *     change is additive rather than breaking.
 *
 * That first one is the reason the dispatcher is one function. Analysing sheet
 * 1 and committing sheet 0 would import something nobody looked at, and every
 * row of it would look plausible.
 */
describe.skipIf(!hasDatabase)('workbook import', () => {
  let ctx: TestContext;
  let owner: Actor;
  let modelId: string;

  /** A workbook with a cover sheet first, which is the awkward common case. */
  async function rentRollWorkbook(): Promise<string> {
    const book = new ExcelJS.Workbook();
    const cover = book.addWorksheet('Cover');
    cover.addRow(['Prepared for the investment committee']);
    cover.addRow(['Valuation date', new Date(Date.UTC(2026, 0, 1))]);

    const roll = book.addWorksheet('Rent Roll');
    // A suite column is required to create a lease — the pipeline's rule, not
    // this reader's, and the fixture has to satisfy it like any real rent roll.
    roll.addRow(['Lease', 'Tenant', 'Suite', 'Area', 'Commences', 'Expires', 'Base rent']);
    roll.addRow([
      'XL-001',
      'Thornbury Legal Services',
      'STE-300',
      12500,
      new Date(Date.UTC(2026, 2, 1)),
      new Date(Date.UTC(2031, 1, 28)),
      41.5,
    ]);
    roll.addRow([
      'XL-002',
      'Halloway Freight',
      'STE-310',
      8200,
      new Date(Date.UTC(2026, 5, 1)),
      new Date(Date.UTC(2029, 4, 31)),
      28.25,
    ]);

    const bytes = Buffer.from((await book.xlsx.writeBuffer()) as ArrayBuffer);
    return Buffer.from(bytes).toString('base64');
  }

  beforeAll(async () => {
    ctx = await createTestContext();
    owner = await registerActor(ctx.app, 'xlsx-owner@example.invalid', 'Workbook Owner');

    const organization = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/organizations',
      headers: authed(owner.cookie),
      payload: { name: 'Workbook Partners' },
    });
    expect(organization.statusCode).toBe(201);

    const property = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/properties',
      headers: authed(owner.cookie),
      payload: { name: 'Workbook House', propertyType: 'office', rentableArea: '60000' },
    });
    const propertyId = (property.json() as { property: { id: string } }).property.id;

    const model = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/models',
      headers: authed(owner.cookie),
      payload: {
        propertyId,
        name: 'Workbook model',
        classification: 'valuation',
        valuationDate: '2026-01-01',
        forecastStartDate: '2026-01-01',
        forecastMonths: 60,
        discountRate: '0.08',
        terminalCapRate: '0.07',
      },
    });
    modelId = (model.json() as { model: { id: string } }).model.id;
  }, 90_000);

  afterAll(async () => {
    await ctx?.close();
  });

  it('reads a workbook, skipping the cover sheet, and says which it chose', async () => {
    const content = await rentRollWorkbook();
    const response = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/models/${modelId}/imports/analyze`,
      headers: authed(owner.cookie),
      payload: { filename: 'rent-roll.xlsx', content },
    });
    expect(response.statusCode).toBe(200);

    const body = response.json() as {
      headers: string[];
      rowCount: number;
      sheetNames: string[];
      sheetIndex: number;
      preview: string[][];
    };

    // Both sheets are reported, and the roll was chosen over the cover.
    expect(body.sheetNames).toEqual(['Cover', 'Rent Roll']);
    expect(body.sheetIndex).toBe(1);
    expect(body.headers).toContain('Tenant');
    expect(body.rowCount).toBe(2);

    // A date arrives as a calendar date, not a timestamp and not a day out.
    expect(body.preview[0]?.join(' ')).toContain('2031-02-28');
  });

  it('commits the leases the preview showed', async () => {
    const content = await rentRollWorkbook();

    const analyzed = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/models/${modelId}/imports/analyze`,
      headers: authed(owner.cookie),
      payload: { filename: 'rent-roll.xlsx', content },
    });
    const { suggestedMapping, sheetIndex } = analyzed.json() as {
      suggestedMapping: Record<string, number>;
      sheetIndex: number;
    };

    const committed = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/models/${modelId}/imports/commit`,
      headers: authed(owner.cookie),
      // The same sheet the preview came from, passed explicitly.
      payload: { filename: 'rent-roll.xlsx', content, sheetIndex, mapping: suggestedMapping },
    });
    expect(committed.statusCode, committed.body).toBe(200);

    const leases = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/models/${modelId}/leases`,
      headers: authed(owner.cookie),
    });
    const rows = (leases.json() as { leases: Array<Record<string, unknown>> }).leases;

    /*
     * Found by tenant, not by the workbook's "Lease" column: that header is not
     * one the mapper recognises as a lease code, so the pipeline generates one
     * from the suite. That is existing behaviour and not what this test is
     * about — what matters is that the workbook's rows reached the rent roll.
     */
    const thornbury = rows.find((lease) => lease.tenant_name === 'Thornbury Legal Services');
    expect(thornbury, `imported: ${rows.map((r) => r.code).join(', ')}`).toBeDefined();
    expect(rows).toHaveLength(2);
    expect(Number(thornbury?.area)).toBe(12500);
    // The date that came out of Excel as a Date object, all the way through.
    expect(String(thornbury?.expiration_date)).toContain('2031-02-28');
  });

  it('refuses a workbook it cannot read, and says what to do', async () => {
    const response = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/models/${modelId}/imports/analyze`,
      headers: authed(owner.cookie),
      payload: {
        filename: 'broken.xlsx',
        content: Buffer.from('this is not a spreadsheet').toString('base64'),
      },
    });
    // A 400 naming the fix, not a 500 that reads like the server broke.
    expect(response.statusCode).toBe(400);
    expect(response.body).toContain('.xlsx');
  });

  it('rejects a sheet index the workbook does not have', async () => {
    const response = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/models/${modelId}/imports/analyze`,
      headers: authed(owner.cookie),
      payload: { filename: 'rent-roll.xlsx', content: await rentRollWorkbook(), sheetIndex: 9 },
    });
    expect(response.statusCode).toBe(400);
    expect(response.body).toContain('2 sheet');
  });

  it('still reads a CSV, including from a caller that sends no filename', async () => {
    /*
     * The change has to be additive. A client written before workbooks existed
     * sends `content` and no `filename`, and must keep getting exactly the CSV
     * behaviour it had.
     */
    const csv = [
      'Lease,Tenant,Area,Commences,Expires,Base rent',
      'CSV-001,Ardent Survey Company,4200,2026-01-01,2030-12-31,38.50',
    ].join('\n');

    const analyzed = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/models/${modelId}/imports/analyze`,
      headers: authed(owner.cookie),
      payload: { filename: 'rent-roll.csv', content: csv },
    });
    expect(analyzed.statusCode).toBe(200);
    const body = analyzed.json() as { sheetNames: string[]; rowCount: number };
    // No sheets, because a CSV has none — not an invented single sheet.
    expect(body.sheetNames).toEqual([]);
    expect(body.rowCount).toBe(1);

    const validated = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/models/${modelId}/imports/validate`,
      headers: authed(owner.cookie),
      // Deliberately no filename, as an older client would send.
      payload: {
        content: csv,
        mapping: (analyzed.json() as { suggestedMapping: Record<string, number> }).suggestedMapping,
      },
    });
    expect(validated.statusCode).toBe(200);
  });
});

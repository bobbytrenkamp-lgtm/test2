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
 * The rent-roll import commit path.
 *
 * `tests/workbook-import.test.ts` proves the wizard reads a sheet, previews
 * it, and that a commit writes leases the preview showed. It does not
 * exercise what `POST /models/:id/imports/commit` does beyond the
 * straightforward case: tenant deduplication by name (so re-importing an
 * updated rent roll does not create a second row for the same tenant),
 * `skipRowsWithErrors`, `saveMappingAs`, the model-status guard, and the
 * audit trail. Each is real behaviour in the route with no test of its own.
 */
describe.skipIf(!hasDatabase)('rent-roll import commit path', () => {
  let ctx: TestContext;
  let owner: Actor;
  let organizationId: string;
  let propertyId: string;

  // Matches `csvOf`'s header: Lease,Tenant,Suite,Area,Commences,Expires,Base rent.
  const MAPPING = {
    leaseCode: 0,
    tenantName: 1,
    spaceCode: 2,
    area: 3,
    commencementDate: 4,
    expirationDate: 5,
    baseRent: 6,
  };

  async function createModel(name: string): Promise<string> {
    const model = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/models',
      headers: authed(owner.cookie),
      payload: {
        propertyId,
        name,
        classification: 'valuation',
        valuationDate: '2026-01-01',
        forecastStartDate: '2026-01-01',
        forecastMonths: 24,
        discountRate: '0.08',
        terminalCapRate: '0.07',
      },
    });
    return (model.json() as { model: { id: string } }).model.id;
  }

  function csvOf(rows: string[]): string {
    return ['Lease,Tenant,Suite,Area,Commences,Expires,Base rent', ...rows].join('\n');
  }

  async function commit(modelId: string, payload: Record<string, unknown>) {
    return ctx.app.inject({
      method: 'POST',
      url: `/api/v1/models/${modelId}/imports/commit`,
      headers: authed(owner.cookie),
      payload: { mapping: MAPPING, ...payload },
    });
  }

  beforeAll(async () => {
    ctx = await createTestContext();
    owner = await registerActor(ctx.app, 'commit-owner@example.invalid', 'Commit Owner');

    const org = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/organizations',
      headers: authed(owner.cookie),
      payload: { name: 'Commit Test Partners' },
    });
    organizationId = (org.json() as { organization: { id: string } }).organization.id;

    const property = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/properties',
      headers: authed(owner.cookie),
      payload: { name: 'Commit House', propertyType: 'office', rentableArea: '50000' },
    });
    propertyId = (property.json() as { property: { id: string } }).property.id;
  }, 90_000);

  afterAll(async () => {
    await ctx?.close();
  });

  it('matches an existing tenant by name (trimmed, case-insensitive) rather than duplicating it', async () => {
    const modelId = await createModel('Dedup model A');
    const first = csvOf(['L-1,Thornbury Legal Services,STE-100,5000,2026-01-01,2030-12-31,30.00']);
    const firstCommit = await commit(modelId, { filename: 'roll.csv', content: first });
    expect(firstCommit.statusCode, firstCommit.body).toBe(200);
    expect((firstCommit.json() as { imported: number }).imported).toBe(1);

    // A re-import of an updated rent roll: the same tenant, different case
    // and surrounding whitespace, plus a second, genuinely new tenant.
    const second = csvOf([
      'L-1,  thornbury legal services  ,STE-100,5000,2026-01-01,2030-12-31,31.00',
      'L-2,Halloway Freight,STE-200,8000,2026-02-01,2029-01-31,25.00',
    ]);
    const secondCommit = await commit(modelId, { filename: 'roll.csv', content: second });
    expect(secondCommit.statusCode, secondCommit.body).toBe(200);
    expect((secondCommit.json() as { imported: number }).imported).toBe(2);

    const tenants = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/tenants?propertyId=${propertyId}`,
      headers: authed(owner.cookie),
    });
    const names = (tenants.json() as { tenants: Array<{ name: string }> }).tenants
      .map((t) => t.name)
      .sort();
    // Exactly two tenants: the re-imported name matched the existing tenant
    // rather than creating "Thornbury Legal Services" a second time.
    expect(names).toEqual(['Halloway Freight', 'Thornbury Legal Services']);
  });

  it('skips only the rows with errors when skipRowsWithErrors is set, and counts both', async () => {
    const modelId = await createModel('Skip-errors model');
    const content = csvOf([
      'L-1,Good Tenant,STE-300,4000,2026-01-01,2030-12-31,28.00',
      // Expires before it commences: analyzeSheet/mapRows flags this an error.
      'L-2,Bad Tenant,STE-301,3000,2030-01-01,2026-01-01,28.00',
    ]);

    const refused = await commit(modelId, { filename: 'roll.csv', content });
    expect(refused.statusCode).toBe(400);

    const committed = await commit(modelId, {
      filename: 'roll.csv',
      content,
      skipRowsWithErrors: true,
    });
    expect(committed.statusCode, committed.body).toBe(200);
    const body = committed.json() as { imported: number; skipped: number };
    expect(body.imported).toBe(1);
    expect(body.skipped).toBe(1);

    const leases = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/models/${modelId}/leases`,
      headers: authed(owner.cookie),
    });
    const rows = (leases.json() as { leases: Array<{ tenant_name: string }> }).leases;
    expect(rows).toHaveLength(1);
    expect(rows[0]?.tenant_name).toBe('Good Tenant');
  });

  it('saveMappingAs persists a reusable mapping template for this organization', async () => {
    const modelId = await createModel('Save-mapping model');
    const content = csvOf(['L-1,Template Tenant,STE-400,2000,2026-01-01,2030-12-31,20.00']);

    const committed = await commit(modelId, {
      filename: 'roll.csv',
      content,
      saveMappingAs: 'Standard rent roll',
    });
    expect(committed.statusCode, committed.body).toBe(200);

    const templates = await ctx.app.inject({
      method: 'GET',
      url: '/api/v1/import-mappings',
      headers: authed(owner.cookie),
    });
    const saved = (
      templates.json() as { templates: Array<{ name: string; mapping: Record<string, number> }> }
    ).templates.find((t) => t.name === 'Standard rent roll');
    expect(saved).toBeDefined();
    expect(saved?.mapping).toEqual(MAPPING);
  });

  it('refuses to commit into a model that is no longer editable', async () => {
    const modelId = await createModel('Approved model');
    await ctx.sql`UPDATE models SET status = 'approved' WHERE id = ${modelId}`;

    const content = csvOf(['L-1,Late Tenant,STE-500,1000,2026-01-01,2030-12-31,15.00']);
    const response = await commit(modelId, { filename: 'roll.csv', content });
    expect(response.statusCode).toBe(400);
    expect(response.body).toContain('approved');
    expect(response.body).toContain('cannot be imported into');
  });

  it('records an audit entry naming what was imported and what was skipped', async () => {
    const modelId = await createModel('Audit model');
    const content = csvOf([
      'L-1,Audited Tenant,STE-600,1500,2026-01-01,2030-12-31,18.00',
      'L-2,Broken Row,STE-601,1200,2030-01-01,2026-01-01,18.00',
    ]);

    const committed = await commit(modelId, {
      filename: 'roll.csv',
      content,
      skipRowsWithErrors: true,
    });
    expect(committed.statusCode, committed.body).toBe(200);

    const rows = await ctx.sql`
      SELECT metadata FROM audit_log
      WHERE organization_id = ${organizationId} AND action = 'import.committed' AND model_id = ${modelId}
    `;
    expect(rows).toHaveLength(1);
    expect((rows[0] as { metadata: { imported: number; skipped: number } }).metadata).toEqual({
      imported: 1,
      skipped: 1,
    });
  });
});

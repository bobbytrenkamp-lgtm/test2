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
 * Organization-level data export: the offboarding half of
 * `docs/commercial-gap-analysis.md` Phase A item 9. The organization-level
 * counterpart to a single model's portable JSON export
 * (`tests/live-model-export.test.ts` covers that one) — everything an
 * organization owns, in one document, independent of staying a customer.
 */
describe.skipIf(!hasDatabase)('organization export', () => {
  let ctx: TestContext;
  let owner: Actor;
  let orgId: string;
  let propertyId: string;
  let modelId: string;

  beforeAll(async () => {
    ctx = await createTestContext();
    owner = await registerActor(ctx.app, 'export-owner@example.invalid', 'Export Owner');

    const organization = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/organizations',
      headers: authed(owner.cookie),
      payload: { name: 'Cascadia Export Partners' },
    });
    orgId = (organization.json() as { organization: { id: string } }).organization.id;

    const property = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/properties',
      headers: authed(owner.cookie),
      payload: { name: 'Cascadia Tower', propertyType: 'office', rentableArea: '120000' },
    });
    propertyId = (property.json() as { property: { id: string } }).property.id;

    const model = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/models',
      headers: authed(owner.cookie),
      payload: {
        propertyId,
        name: 'Base case',
        classification: 'acquisition',
        valuationDate: '2026-01-01',
        forecastStartDate: '2026-01-01',
        forecastMonths: 24,
        discountRate: '0.08',
        terminalCapRate: '0.07',
        terminalNoiBasis: 'trailing_12',
        saleMonth: 24,
      },
    });
    modelId = (model.json() as { model: { id: string } }).model.id;

    const calculated = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/models/${modelId}/calculate`,
      headers: authed(owner.cookie),
      payload: {},
    });
    expect(calculated.statusCode).toBe(200);
  }, 60_000);

  afterAll(async () => {
    await ctx?.close();
  });

  it('exports the organization, its members, properties and models as one document', async () => {
    const response = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/organizations/${orgId}/export`,
      headers: authed(owner.cookie),
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers['content-disposition']).toContain('.crexport.json');

    const document = response.json() as {
      format: string;
      formatVersion: number;
      organization: { id: string; name: string };
      members: Array<{ email: string }>;
      properties: Array<{ id: string; name: string }>;
      models: Array<{ modelId: string; propertyId: string; format: string; result?: unknown }>;
    };

    expect(document.format).toBe('cre-platform-organization');
    expect(document.formatVersion).toBe(1);
    expect(document.organization.id).toBe(orgId);
    expect(document.organization.name).toBe('Cascadia Export Partners');

    expect(document.members.map((member) => member.email)).toContain(
      'export-owner@example.invalid',
    );

    expect(document.properties).toHaveLength(1);
    expect(document.properties[0]?.name).toBe('Cascadia Tower');

    expect(document.models).toHaveLength(1);
    const modelDocument = document.models[0];
    expect(modelDocument?.modelId).toBe(modelId);
    expect(modelDocument?.propertyId).toBe(propertyId);
    // Each model is the same portable document a single-model export
    // produces, just gathered into the wider file.
    expect(modelDocument?.format).toBe('cre-platform-model');
    expect(modelDocument?.result).toBeDefined();
  });

  it('omits calculation results when asked, without dropping the models themselves', async () => {
    const response = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/organizations/${orgId}/export?includeResults=false`,
      headers: authed(owner.cookie),
    });
    expect(response.statusCode).toBe(200);
    const document = response.json() as { models: Array<{ result?: unknown }> };
    expect(document.models).toHaveLength(1);
    expect(document.models[0]?.result).toBeUndefined();
  });

  it('refuses a member who is not an organization owner', async () => {
    const analyst = await registerActor(
      ctx.app,
      'export-analyst@example.invalid',
      'Export Analyst',
    );
    const invitation = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/organizations/${orgId}/invitations`,
      headers: authed(owner.cookie),
      payload: { email: 'export-analyst@example.invalid', role: 'analyst' },
    });
    const token = (invitation.json() as { token: string }).token;
    await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/invitations/accept',
      headers: authed(analyst.cookie),
      payload: { token },
    });

    const response = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/organizations/${orgId}/export`,
      headers: authed(analyst.cookie),
    });
    expect(response.statusCode).toBe(403);
  });

  it('refuses to export an organization the caller is not signed into', async () => {
    const stranger = await registerActor(ctx.app, 'export-stranger@example.invalid', 'Stranger');
    await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/organizations',
      headers: authed(stranger.cookie),
      payload: { name: 'Unrelated Holdings' },
    });

    const response = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/organizations/${orgId}/export`,
      headers: authed(stranger.cookie),
    });
    // The stranger's session points at their own new organization, so the
    // id in the URL never matches — refused before any data is touched.
    expect(response.statusCode).toBe(403);
  });

  it('records the export in the audit log', async () => {
    await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/organizations/${orgId}/export`,
      headers: authed(owner.cookie),
    });

    const audit = await ctx.app.inject({
      method: 'GET',
      url: '/api/v1/audit',
      headers: authed(owner.cookie),
    });
    const entries = (audit.json() as { entries: Array<{ action: string }> }).entries;
    expect(entries.some((entry) => entry.action === 'organization.exported')).toBe(true);
  });
});

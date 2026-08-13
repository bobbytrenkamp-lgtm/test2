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
 * The organization's growth curve library.
 *
 * A growth curve has always been model-scoped; this is the first reusable,
 * organization-level assumption. The interesting behaviour is the
 * code-addressable upsert (create and edit are the same call), that a
 * duplicate `byYear` entry is refused rather than silently shadowed the way
 * the engine already refuses it for a model's own curve, and that the
 * library is scoped to the organization the same way every other
 * organization-owned resource here is.
 */
describe.skipIf(!hasDatabase)('growth curve templates', () => {
  let ctx: TestContext;
  let owner: Actor;
  let organizationId: string;

  beforeAll(async () => {
    ctx = await createTestContext();
    owner = await registerActor(ctx.app, 'gct-owner@example.invalid', 'Library Owner');
    organizationId = await createOrganization(owner.cookie, 'Cortland Ridge Advisors');
  }, 60_000);

  afterAll(async () => {
    await ctx?.close();
  });

  async function createOrganization(cookie: string, name: string): Promise<string> {
    const response = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/organizations',
      headers: authed(cookie),
      payload: { name },
    });
    return (response.json() as { organization: { id: string } }).organization.id;
  }

  async function list(
    cookie: string,
    orgId: string,
  ): Promise<Array<{ code: string; name: string }>> {
    const response = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/organizations/${orgId}/growth-curve-templates`,
      headers: authed(cookie),
    });
    return (response.json() as { templates: Array<{ code: string; name: string }> }).templates;
  }

  it('starts empty', async () => {
    expect(await list(owner.cookie, organizationId)).toEqual([]);
  });

  it('creates a template, addressed by its own code', async () => {
    const response = await ctx.app.inject({
      method: 'PUT',
      url: `/api/v1/organizations/${organizationId}/growth-curve-templates/cpi`,
      headers: authed(owner.cookie),
      payload: {
        name: 'CPI, 3% stepping to 2.5%',
        defaultRate: '0.03',
        byYear: [{ year: 6, rate: '0.025' }],
      },
    });
    expect(response.statusCode).toBe(200);
    const body = response.json() as { template: { code: string; default_rate: string } };
    expect(body.template.code).toBe('cpi');
    expect(body.template.default_rate).toBe('0.03000000');

    const templates = await list(owner.cookie, organizationId);
    expect(templates.map((t) => t.code)).toEqual(['cpi']);
  });

  it('editing the same code replaces it rather than creating a second entry', async () => {
    await ctx.app.inject({
      method: 'PUT',
      url: `/api/v1/organizations/${organizationId}/growth-curve-templates/cpi`,
      headers: authed(owner.cookie),
      payload: { name: 'CPI, revised to 3.5%', defaultRate: '0.035', byYear: [] },
    });
    const templates = await list(owner.cookie, organizationId);
    expect(templates).toHaveLength(1);
    expect(templates[0]?.name).toBe('CPI, revised to 3.5%');
  });

  it('refuses a duplicate year in the same override list', async () => {
    // The engine refuses this for a model's own growth curve (only the first
    // entry for a repeated year is ever used, silently); a template has no
    // engine pass to catch it later, so it is refused here instead.
    const response = await ctx.app.inject({
      method: 'PUT',
      url: `/api/v1/organizations/${organizationId}/growth-curve-templates/broken`,
      headers: authed(owner.cookie),
      payload: {
        name: 'Broken',
        defaultRate: '0.03',
        byYear: [
          { year: 3, rate: '0.02' },
          { year: 3, rate: '0.04' },
        ],
      },
    });
    expect(response.statusCode).toBe(400);
    expect(await list(owner.cookie, organizationId)).not.toContainEqual(
      expect.objectContaining({ code: 'broken' }),
    );
  });

  it('deletes a template, and refuses to delete one that does not exist', async () => {
    const deleted = await ctx.app.inject({
      method: 'DELETE',
      url: `/api/v1/organizations/${organizationId}/growth-curve-templates/cpi`,
      headers: authed(owner.cookie),
    });
    expect(deleted.statusCode).toBe(200);
    expect(await list(owner.cookie, organizationId)).toEqual([]);

    const again = await ctx.app.inject({
      method: 'DELETE',
      url: `/api/v1/organizations/${organizationId}/growth-curve-templates/cpi`,
      headers: authed(owner.cookie),
    });
    expect(again.statusCode).toBe(404);
  });

  it('is scoped to the organization: a stranger cannot read or write it', async () => {
    await ctx.app.inject({
      method: 'PUT',
      url: `/api/v1/organizations/${organizationId}/growth-curve-templates/tenant-sales`,
      headers: authed(owner.cookie),
      payload: { name: 'Tenant sales growth', defaultRate: '0.02', byYear: [] },
    });

    const stranger = await registerActor(
      ctx.app,
      'gct-stranger@example.invalid',
      'Library Stranger',
    );
    const strangerOrgId = await createOrganization(stranger.cookie, 'Unrelated Holdings');

    const read = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/organizations/${organizationId}/growth-curve-templates`,
      headers: authed(stranger.cookie),
    });
    expect(read.statusCode).toBe(403);

    const write = await ctx.app.inject({
      method: 'PUT',
      url: `/api/v1/organizations/${organizationId}/growth-curve-templates/hijack`,
      headers: authed(stranger.cookie),
      payload: { name: 'Hijack', defaultRate: '0', byYear: [] },
    });
    expect(write.statusCode).toBe(403);

    // The stranger's own, unrelated organization still sees an empty library
    // rather than the owner's — proves the read is scoped, not just refused.
    expect(await list(stranger.cookie, strangerOrgId)).toEqual([]);
  });

  it('cannot be read or written without a session', async () => {
    const read = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/organizations/${organizationId}/growth-curve-templates`,
    });
    expect(read.statusCode).toBe(401);

    const write = await ctx.app.inject({
      method: 'PUT',
      url: `/api/v1/organizations/${organizationId}/growth-curve-templates/x`,
      // The CSRF header, so this is refused for lacking a session rather than
      // for lacking the header — two separate guards, and this test is about
      // the first one.
      headers: { 'x-requested-with': 'cre-platform', 'content-type': 'application/json' },
      payload: { name: 'x', defaultRate: '0', byYear: [] },
    });
    expect(write.statusCode).toBe(401);
  });
});

/**
 * Applying a template to a model.
 *
 * The library itself is tested above; this is the other half — a curve
 * created by starting from a template must say so afterward
 * (`source_template_code`/`source_template_name`), a curve entered by hand
 * must not claim one, and a later hand edit of an already-templated curve
 * must not erase where it came from. All three are real database state, not
 * UI behaviour, so they are checked at the API `growth_curves` row directly
 * rather than trusted from `AssumptionsTab.tsx`'s own JSON round-trip.
 */
describe.skipIf(!hasDatabase)('growth curve provenance', () => {
  let ctx: TestContext;
  let owner: Actor;
  let organizationId: string;
  let modelId: string;

  beforeAll(async () => {
    ctx = await createTestContext();
    owner = await registerActor(ctx.app, 'gcp-owner@example.invalid', 'Provenance Owner');
    const org = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/organizations',
      headers: authed(owner.cookie),
      payload: { name: 'Cortland Ridge Advisors' },
    });
    organizationId = (org.json() as { organization: { id: string } }).organization.id;

    const property = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/properties',
      headers: authed(owner.cookie),
      payload: { name: 'Cortland Ridge', propertyType: 'office', rentableArea: '120000' },
    });
    const propertyId = (property.json() as { property: { id: string } }).property.id;

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
        forecastMonths: 60,
        saleMonth: 60,
      },
    });
    modelId = (model.json() as { model: { id: string } }).model.id;
  }, 60_000);

  afterAll(async () => {
    await ctx?.close();
  });

  async function readCurve(code: string): Promise<{
    code: string;
    source_template_code: string | null;
    source_template_name: string | null;
  }> {
    const response = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/models/${modelId}/growth-curves`,
      headers: authed(owner.cookie),
    });
    const items = (
      response.json() as {
        items: Array<{
          code: string;
          source_template_code: string | null;
          source_template_name: string | null;
        }>;
      }
    ).items;
    const row = items.find((entry) => entry.code === code);
    if (!row) throw new Error(`No growth curve "${code}" was found.`);
    return row;
  }

  it('records where a curve started when it is seeded from the library', async () => {
    await ctx.app.inject({
      method: 'PUT',
      url: `/api/v1/organizations/${organizationId}/growth-curve-templates/cpi`,
      headers: authed(owner.cookie),
      payload: { name: 'CPI, 3%', defaultRate: '0.03', byYear: [] },
    });

    const applied = await ctx.app.inject({
      method: 'PUT',
      url: `/api/v1/models/${modelId}/growth-curves/cpi`,
      headers: authed(owner.cookie),
      // What AssumptionsTab.tsx's beginFromTemplate seeds the draft with.
      payload: {
        name: 'CPI, 3%',
        defaultRate: '0.03',
        byYear: [],
        sourceTemplateCode: 'cpi',
        sourceTemplateName: 'CPI, 3%',
      },
    });
    expect(applied.statusCode).toBe(200);

    const row = await readCurve('cpi');
    expect(row.source_template_code).toBe('cpi');
    expect(row.source_template_name).toBe('CPI, 3%');
  });

  it('leaves a hand-entered curve with no library provenance', async () => {
    await ctx.app.inject({
      method: 'PUT',
      url: `/api/v1/models/${modelId}/growth-curves/hand-typed`,
      headers: authed(owner.cookie),
      payload: { name: 'Typed by hand', defaultRate: '0.02', byYear: [] },
    });

    const row = await readCurve('hand-typed');
    expect(row.source_template_code).toBeNull();
    expect(row.source_template_name).toBeNull();
  });

  it('keeps the provenance after a later edit that does not resend it', async () => {
    // A normal "Edit" round-trip through AssumptionsTab.tsx sends whatever
    // the draft held, which still carries these two fields (see
    // `beginEdit`'s `toCamel(rest)`) — but the guarantee that matters is the
    // one this test proves: even a caller that omits them, editing only the
    // rate, must not blank out how the curve started.
    const edited = await ctx.app.inject({
      method: 'PUT',
      url: `/api/v1/models/${modelId}/growth-curves/cpi`,
      headers: authed(owner.cookie),
      payload: { name: 'CPI, revised to 3.25%', defaultRate: '0.0325', byYear: [] },
    });
    expect(edited.statusCode).toBe(200);

    const row = await readCurve('cpi');
    expect(row.source_template_code).toBe('cpi');
    expect(row.source_template_name).toBe('CPI, 3%');
  });

  it('deleting the library template does not change the model’s own copy', async () => {
    await ctx.app.inject({
      method: 'DELETE',
      url: `/api/v1/organizations/${organizationId}/growth-curve-templates/cpi`,
      headers: authed(owner.cookie),
    });

    const row = await readCurve('cpi');
    expect(row.source_template_code).toBe('cpi');
    expect(row.source_template_name).toBe('CPI, 3%');
  });
});

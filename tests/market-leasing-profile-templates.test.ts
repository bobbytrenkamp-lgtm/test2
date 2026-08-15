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
 * The organization's market leasing profile library.
 *
 * Second reusable assumption family after growth curves
 * (`tests/growth-curve-templates.test.ts`) — same shape, same interesting
 * behaviour: the code-addressable upsert, organization scoping in both
 * directions, and that a profile applied from the library records where it
 * came from without becoming a live reference to it.
 */
describe.skipIf(!hasDatabase)('market leasing profile templates', () => {
  let ctx: TestContext;
  let owner: Actor;
  let organizationId: string;

  beforeAll(async () => {
    ctx = await createTestContext();
    owner = await registerActor(ctx.app, 'mlpt-owner@example.invalid', 'Library Owner');
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
      url: `/api/v1/organizations/${orgId}/market-leasing-profile-templates`,
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
      url: `/api/v1/organizations/${organizationId}/market-leasing-profile-templates/office-standard`,
      headers: authed(owner.cookie),
      payload: {
        name: 'Office standard',
        marketRent: '38',
        renewalProbability: '0.65',
        downtimeMonths: 6,
        newFreeRentMonths: 3,
        newTiPerArea: '40',
        renewalTiPerArea: '15',
      },
    });
    expect(response.statusCode).toBe(200);
    const body = response.json() as {
      template: { code: string; market_rent: string; renewal_probability: string };
    };
    expect(body.template.code).toBe('office-standard');
    expect(body.template.market_rent).toBe('38.000000');
    expect(body.template.renewal_probability).toBe('0.65000000');

    const templates = await list(owner.cookie, organizationId);
    expect(templates.map((t) => t.code)).toEqual(['office-standard']);
  });

  it('editing the same code replaces it rather than creating a second entry', async () => {
    await ctx.app.inject({
      method: 'PUT',
      url: `/api/v1/organizations/${organizationId}/market-leasing-profile-templates/office-standard`,
      headers: authed(owner.cookie),
      payload: { name: 'Office standard, revised', marketRent: '40' },
    });
    const templates = await list(owner.cookie, organizationId);
    expect(templates).toHaveLength(1);
    expect(templates[0]?.name).toBe('Office standard, revised');
  });

  it('applies defaults for every field it is not given', async () => {
    const response = await ctx.app.inject({
      method: 'PUT',
      url: `/api/v1/organizations/${organizationId}/market-leasing-profile-templates/bare`,
      headers: authed(owner.cookie),
      payload: { name: 'Bare minimum', marketRent: '30' },
    });
    const template = (response.json() as { template: Record<string, unknown> }).template;
    expect(template.market_rent_basis).toBe('per_area_per_year');
    expect(template.renewal_term_months).toBe(60);
    expect(template.downtime_months).toBe('6.00');
  });

  it('deletes a template, and refuses to delete one that does not exist', async () => {
    const deleted = await ctx.app.inject({
      method: 'DELETE',
      url: `/api/v1/organizations/${organizationId}/market-leasing-profile-templates/bare`,
      headers: authed(owner.cookie),
    });
    expect(deleted.statusCode).toBe(200);
    expect((await list(owner.cookie, organizationId)).map((t) => t.code)).not.toContain('bare');

    const again = await ctx.app.inject({
      method: 'DELETE',
      url: `/api/v1/organizations/${organizationId}/market-leasing-profile-templates/bare`,
      headers: authed(owner.cookie),
    });
    expect(again.statusCode).toBe(404);
  });

  it('is scoped to the organization: a stranger cannot read or write it', async () => {
    const stranger = await registerActor(
      ctx.app,
      'mlpt-stranger@example.invalid',
      'Library Stranger',
    );
    const strangerOrgId = await createOrganization(stranger.cookie, 'Unrelated Holdings');

    const read = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/organizations/${organizationId}/market-leasing-profile-templates`,
      headers: authed(stranger.cookie),
    });
    expect(read.statusCode).toBe(403);

    const write = await ctx.app.inject({
      method: 'PUT',
      url: `/api/v1/organizations/${organizationId}/market-leasing-profile-templates/hijack`,
      headers: authed(stranger.cookie),
      payload: { name: 'Hijack', marketRent: '0' },
    });
    expect(write.statusCode).toBe(403);

    expect(await list(stranger.cookie, strangerOrgId)).toEqual([]);
  });

  it('cannot be read or written without a session', async () => {
    const read = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/organizations/${organizationId}/market-leasing-profile-templates`,
    });
    expect(read.statusCode).toBe(401);

    const write = await ctx.app.inject({
      method: 'PUT',
      url: `/api/v1/organizations/${organizationId}/market-leasing-profile-templates/x`,
      headers: { 'x-requested-with': 'cre-platform', 'content-type': 'application/json' },
      payload: { name: 'x', marketRent: '0' },
    });
    expect(write.statusCode).toBe(401);
  });
});

/**
 * Applying a template to a model — the other half, checked the same way
 * `tests/growth-curve-templates.test.ts`'s "growth curve provenance" block
 * checks it: at the real `market_leasing_profiles` row, not trusted from
 * the UI's own JSON round-trip.
 */
describe.skipIf(!hasDatabase)('market leasing profile provenance', () => {
  let ctx: TestContext;
  let owner: Actor;
  let organizationId: string;
  let modelId: string;

  beforeAll(async () => {
    ctx = await createTestContext();
    owner = await registerActor(ctx.app, 'mlpp-owner@example.invalid', 'Provenance Owner');
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

  async function readProfile(code: string): Promise<{
    code: string;
    source_template_code: string | null;
    source_template_name: string | null;
  }> {
    const response = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/models/${modelId}/market-leasing`,
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
    if (!row) throw new Error(`No market leasing profile "${code}" was found.`);
    return row;
  }

  it('records where a profile started when it is seeded from the library', async () => {
    await ctx.app.inject({
      method: 'PUT',
      url: `/api/v1/organizations/${organizationId}/market-leasing-profile-templates/office-standard`,
      headers: authed(owner.cookie),
      payload: { name: 'Office standard', marketRent: '38' },
    });

    const applied = await ctx.app.inject({
      method: 'PUT',
      url: `/api/v1/models/${modelId}/market-leasing/office-standard`,
      headers: authed(owner.cookie),
      // What AssumptionsTab.tsx's templateToDraft for market leasing seeds.
      payload: {
        name: 'Office standard',
        marketRent: '38',
        sourceTemplateCode: 'office-standard',
        sourceTemplateName: 'Office standard',
      },
    });
    expect(applied.statusCode).toBe(200);

    const row = await readProfile('office-standard');
    expect(row.source_template_code).toBe('office-standard');
    expect(row.source_template_name).toBe('Office standard');
  });

  it('leaves a hand-entered profile with no library provenance', async () => {
    await ctx.app.inject({
      method: 'PUT',
      url: `/api/v1/models/${modelId}/market-leasing/hand-typed`,
      headers: authed(owner.cookie),
      payload: { name: 'Typed by hand', marketRent: '32' },
    });

    const row = await readProfile('hand-typed');
    expect(row.source_template_code).toBeNull();
    expect(row.source_template_name).toBeNull();
  });

  it('keeps the provenance after a later edit that does not resend it', async () => {
    const edited = await ctx.app.inject({
      method: 'PUT',
      url: `/api/v1/models/${modelId}/market-leasing/office-standard`,
      headers: authed(owner.cookie),
      payload: { name: 'Office standard, revised', marketRent: '39' },
    });
    expect(edited.statusCode).toBe(200);

    const row = await readProfile('office-standard');
    expect(row.source_template_code).toBe('office-standard');
    expect(row.source_template_name).toBe('Office standard');
  });

  it('deleting the library template does not change the model’s own copy', async () => {
    await ctx.app.inject({
      method: 'DELETE',
      url: `/api/v1/organizations/${organizationId}/market-leasing-profile-templates/office-standard`,
      headers: authed(owner.cookie),
    });

    const row = await readProfile('office-standard');
    expect(row.source_template_code).toBe('office-standard');
    expect(row.source_template_name).toBe('Office standard');
  });
});

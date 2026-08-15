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
 * The organization's debt facility library.
 *
 * Fourth reusable assumption family after growth curves, market leasing
 * profiles and operating expenses — same shape, same interesting
 * behaviour: the code-addressable upsert, organization scoping in both
 * directions, and that a facility applied from the library records where
 * it came from without becoming a live reference to it.
 */
describe.skipIf(!hasDatabase)('debt facility templates', () => {
  let ctx: TestContext;
  let owner: Actor;
  let organizationId: string;

  beforeAll(async () => {
    ctx = await createTestContext();
    owner = await registerActor(ctx.app, 'dft-owner@example.invalid', 'Library Owner');
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
      url: `/api/v1/organizations/${orgId}/debt-facility-templates`,
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
      url: `/api/v1/organizations/${organizationId}/debt-facility-templates/standard-bridge`,
      headers: authed(owner.cookie),
      payload: {
        name: 'Standard bridge loan',
        type: 'bridge',
        rateType: 'floating',
        spread: '0.03',
        rateFloor: '0.05',
        interestOnlyMonths: 36,
        amortizationMonths: 0,
        termMonths: 36,
        originationFeePercent: '0.01',
        exitFeePercent: '0.0025',
        repayOnSale: true,
      },
    });
    expect(response.statusCode).toBe(200);
    const body = response.json() as {
      template: { code: string; spread: string; rate_floor: string; term_months: number };
    };
    expect(body.template.code).toBe('standard-bridge');
    expect(body.template.spread).toBe('0.03000000');
    expect(body.template.rate_floor).toBe('0.05000000');
    expect(body.template.term_months).toBe(36);

    const templates = await list(owner.cookie, organizationId);
    expect(templates.map((t) => t.code)).toEqual(['standard-bridge']);
  });

  it('editing the same code replaces it rather than creating a second entry', async () => {
    await ctx.app.inject({
      method: 'PUT',
      url: `/api/v1/organizations/${organizationId}/debt-facility-templates/standard-bridge`,
      headers: authed(owner.cookie),
      payload: { name: 'Standard bridge loan, revised', spread: '0.035' },
    });
    const templates = await list(owner.cookie, organizationId);
    expect(templates).toHaveLength(1);
    expect(templates[0]?.name).toBe('Standard bridge loan, revised');
  });

  it('applies defaults for every field it is not given', async () => {
    const response = await ctx.app.inject({
      method: 'PUT',
      url: `/api/v1/organizations/${organizationId}/debt-facility-templates/bare`,
      headers: authed(owner.cookie),
      payload: { name: 'Bare minimum' },
    });
    const template = (response.json() as { template: Record<string, unknown> }).template;
    expect(template.type).toBe('permanent');
    expect(template.rate_type).toBe('fixed');
    expect(template.commitment).toBe('0.00');
    expect(template.term_months).toBe(120);
    expect(template.repay_on_sale).toBe(true);
  });

  it('refuses a negative commitment and an unrecognised facility type', async () => {
    const negative = await ctx.app.inject({
      method: 'PUT',
      url: `/api/v1/organizations/${organizationId}/debt-facility-templates/negative`,
      headers: authed(owner.cookie),
      payload: { name: 'Negative commitment', commitment: '-1000' },
    });
    // The database CHECK constraint (debt_facility_templates_commitment_non_negative)
    // is the backstop, mirroring debt_facilities' own debt_commitment_non_negative
    // constraint from migration 0003.
    expect(negative.statusCode).toBeGreaterThanOrEqual(400);

    const badType = await ctx.app.inject({
      method: 'PUT',
      url: `/api/v1/organizations/${organizationId}/debt-facility-templates/bad-type`,
      headers: authed(owner.cookie),
      payload: { name: 'Bad type', type: 'not_a_real_type' },
    });
    // Refused by the route's own zod schema (debtTypeEnum) before it ever
    // reaches the database's debt_facility_templates_type_check.
    expect(badType.statusCode).toBe(400);

    const codes = (await list(owner.cookie, organizationId)).map((t) => t.code);
    expect(codes).not.toContain('negative');
    expect(codes).not.toContain('bad-type');
  });

  it('deletes a template, and refuses to delete one that does not exist', async () => {
    const deleted = await ctx.app.inject({
      method: 'DELETE',
      url: `/api/v1/organizations/${organizationId}/debt-facility-templates/bare`,
      headers: authed(owner.cookie),
    });
    expect(deleted.statusCode).toBe(200);
    expect((await list(owner.cookie, organizationId)).map((t) => t.code)).not.toContain('bare');

    const again = await ctx.app.inject({
      method: 'DELETE',
      url: `/api/v1/organizations/${organizationId}/debt-facility-templates/bare`,
      headers: authed(owner.cookie),
    });
    expect(again.statusCode).toBe(404);
  });

  it('is scoped to the organization: a stranger cannot read or write it', async () => {
    const stranger = await registerActor(
      ctx.app,
      'dft-stranger@example.invalid',
      'Library Stranger',
    );
    const strangerOrgId = await createOrganization(stranger.cookie, 'Unrelated Holdings');

    const read = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/organizations/${organizationId}/debt-facility-templates`,
      headers: authed(stranger.cookie),
    });
    expect(read.statusCode).toBe(403);

    const write = await ctx.app.inject({
      method: 'PUT',
      url: `/api/v1/organizations/${organizationId}/debt-facility-templates/hijack`,
      headers: authed(stranger.cookie),
      payload: { name: 'Hijack' },
    });
    expect(write.statusCode).toBe(403);

    expect(await list(stranger.cookie, strangerOrgId)).toEqual([]);
  });

  it('cannot be read or written without a session', async () => {
    const read = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/organizations/${organizationId}/debt-facility-templates`,
    });
    expect(read.statusCode).toBe(401);

    const write = await ctx.app.inject({
      method: 'PUT',
      url: `/api/v1/organizations/${organizationId}/debt-facility-templates/x`,
      headers: { 'x-requested-with': 'cre-platform', 'content-type': 'application/json' },
      payload: { name: 'x' },
    });
    expect(write.statusCode).toBe(401);
  });
});

/**
 * Applying a template to a model — the other half, checked the same way
 * the other three families' provenance blocks check it: at the real
 * `debt_facilities` row, not trusted from the UI's own JSON round-trip.
 */
describe.skipIf(!hasDatabase)('debt facility provenance', () => {
  let ctx: TestContext;
  let owner: Actor;
  let organizationId: string;
  let modelId: string;

  beforeAll(async () => {
    ctx = await createTestContext();
    owner = await registerActor(ctx.app, 'dfp-owner@example.invalid', 'Provenance Owner');
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

  async function readFacility(code: string): Promise<{
    code: string;
    source_template_code: string | null;
    source_template_name: string | null;
  }> {
    const response = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/models/${modelId}/debt`,
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
    if (!row) throw new Error(`No debt facility "${code}" was found.`);
    return row;
  }

  it('records where a facility started when it is seeded from the library', async () => {
    await ctx.app.inject({
      method: 'PUT',
      url: `/api/v1/organizations/${organizationId}/debt-facility-templates/bridge-standard`,
      headers: authed(owner.cookie),
      payload: { name: 'Bridge standard', type: 'bridge', rateType: 'fixed', fixedRate: '0.065' },
    });

    const applied = await ctx.app.inject({
      method: 'PUT',
      url: `/api/v1/models/${modelId}/debt/bridge-standard`,
      headers: authed(owner.cookie),
      // What AssumptionsTab.tsx's templateToDraft for debt seeds, plus the
      // deal-specific fields the model-level schema requires.
      payload: {
        name: 'Bridge standard',
        type: 'bridge',
        commitment: '20000000',
        fundingDate: '2026-01-01',
        termMonths: 36,
        rateType: 'fixed',
        fixedRate: '0.065',
        sourceTemplateCode: 'bridge-standard',
        sourceTemplateName: 'Bridge standard',
      },
    });
    expect(applied.statusCode).toBe(200);

    const row = await readFacility('bridge-standard');
    expect(row.source_template_code).toBe('bridge-standard');
    expect(row.source_template_name).toBe('Bridge standard');
  });

  it('leaves a hand-entered facility with no library provenance', async () => {
    await ctx.app.inject({
      method: 'PUT',
      url: `/api/v1/models/${modelId}/debt/hand-typed`,
      headers: authed(owner.cookie),
      payload: {
        name: 'Typed by hand',
        type: 'permanent',
        commitment: '10000000',
        fundingDate: '2026-01-01',
        termMonths: 120,
        rateType: 'fixed',
        fixedRate: '0.055',
      },
    });

    const row = await readFacility('hand-typed');
    expect(row.source_template_code).toBeNull();
    expect(row.source_template_name).toBeNull();
  });

  it('keeps the provenance after a later edit that does not resend it', async () => {
    const edited = await ctx.app.inject({
      method: 'PUT',
      url: `/api/v1/models/${modelId}/debt/bridge-standard`,
      headers: authed(owner.cookie),
      payload: {
        name: 'Bridge standard, revised',
        type: 'bridge',
        commitment: '21000000',
        fundingDate: '2026-01-01',
        termMonths: 36,
        rateType: 'fixed',
        fixedRate: '0.0675',
      },
    });
    expect(edited.statusCode).toBe(200);

    const row = await readFacility('bridge-standard');
    expect(row.source_template_code).toBe('bridge-standard');
    expect(row.source_template_name).toBe('Bridge standard');
  });

  it('deleting the library template does not change the model’s own copy', async () => {
    await ctx.app.inject({
      method: 'DELETE',
      url: `/api/v1/organizations/${organizationId}/debt-facility-templates/bridge-standard`,
      headers: authed(owner.cookie),
    });

    const row = await readFacility('bridge-standard');
    expect(row.source_template_code).toBe('bridge-standard');
    expect(row.source_template_name).toBe('Bridge standard');
  });
});

/**
 * Template vs hand-entered equivalence, the same check
 * `tests/expense-templates.test.ts` runs for operating expenses (its own
 * "Math Check E") and for the same reason: `DebtFacility` (the type
 * `computeDebt` actually reads, `packages/domain-models/src/model-input.ts`)
 * has no `sourceTemplateCode`/`sourceTemplateName` fields — provenance lives
 * only on the API/DB row. Checked empirically here rather than assumed.
 */
describe.skipIf(!hasDatabase)(
  'template-derived and hand-entered debt facilities calculate identically',
  () => {
    let ctx: TestContext;
    let owner: Actor;
    let organizationId: string;

    beforeAll(async () => {
      ctx = await createTestContext();
      owner = await registerActor(ctx.app, 'dft-mathe-owner@example.invalid', 'Math E Owner');
      const org = await ctx.app.inject({
        method: 'POST',
        url: '/api/v1/organizations',
        headers: authed(owner.cookie),
        payload: { name: 'Cortland Ridge Advisors' },
      });
      organizationId = (org.json() as { organization: { id: string } }).organization.id;
    }, 60_000);

    afterAll(async () => {
      await ctx?.close();
    });

    async function newModel(name: string): Promise<string> {
      const property = await ctx.app.inject({
        method: 'POST',
        url: '/api/v1/properties',
        headers: authed(owner.cookie),
        payload: { name, propertyType: 'office', rentableArea: '500000' },
      });
      const propertyId = (property.json() as { property: { id: string } }).property.id;

      const model = await ctx.app.inject({
        method: 'POST',
        url: '/api/v1/models',
        headers: authed(owner.cookie),
        payload: {
          propertyId,
          name,
          classification: 'acquisition',
          valuationDate: '2026-01-01',
          forecastStartDate: '2026-01-01',
          forecastMonths: 36,
          acquisitionPrice: '9000000000',
          acquisitionCosts: '0',
          terminalCapRate: '0.06',
          saleMonth: 36,
        },
      });
      return (model.json() as { model: { id: string } }).model.id;
    }

    interface CashFlow {
      annual: Array<{ fiscalYear: number; lines: Record<string, string> }>;
      monthly: Record<string, string[]>;
    }

    async function calculateAndRead(modelId: string): Promise<CashFlow> {
      const run = await ctx.app.inject({
        method: 'POST',
        url: `/api/v1/models/${modelId}/calculate`,
        headers: authed(owner.cookie),
        payload: { withTrace: false },
      });
      expect(run.statusCode).toBe(200);
      const response = await ctx.app.inject({
        method: 'GET',
        url: `/api/v1/models/${modelId}/cashflow`,
        headers: authed(owner.cookie),
      });
      expect(response.statusCode).toBe(200);
      return response.json() as CashFlow;
    }

    it('produces identical annual and monthly cash flow on a billion-dollar facility, whether it came from the library or was typed by hand', async () => {
      const manualModelId = await newModel('Debt math E manual');
      const templateModelId = await newModel('Debt math E template');

      const shared = {
        name: 'Acquisition loan',
        type: 'bridge',
        commitment: '5432109876.54',
        initialFunding: '5432109876.54',
        fundingDate: '2026-01-01',
        rateType: 'fixed',
        fixedRate: '0.0575',
        interestOnlyMonths: 36,
        amortizationMonths: 0,
        termMonths: 36,
        originationFeePercent: '0.0125',
        repayOnSale: true,
      };

      await ctx.app.inject({
        method: 'PUT',
        url: `/api/v1/models/${manualModelId}/debt/loan`,
        headers: authed(owner.cookie),
        payload: shared,
      });

      await ctx.app.inject({
        method: 'PUT',
        url: `/api/v1/organizations/${organizationId}/debt-facility-templates/bridge-template`,
        headers: authed(owner.cookie),
        payload: shared,
      });
      await ctx.app.inject({
        method: 'PUT',
        url: `/api/v1/models/${templateModelId}/debt/loan`,
        headers: authed(owner.cookie),
        payload: {
          ...shared,
          sourceTemplateCode: 'bridge-template',
          sourceTemplateName: 'Acquisition loan',
        },
      });

      const manual = await calculateAndRead(manualModelId);
      const template = await calculateAndRead(templateModelId);

      expect(template.annual.map((row) => row.lines)).toEqual(
        manual.annual.map((row) => row.lines),
      );
      expect(template.monthly).toEqual(manual.monthly);
    });
  },
);

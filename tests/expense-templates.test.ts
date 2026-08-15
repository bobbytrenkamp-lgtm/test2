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
 * The organization's operating expense library.
 *
 * Third reusable assumption family after growth curves
 * (`tests/growth-curve-templates.test.ts`) and market leasing profiles
 * (`tests/market-leasing-profile-templates.test.ts`) — same shape, same
 * interesting behaviour: the code-addressable upsert, organization scoping
 * in both directions, and that an expense applied from the library records
 * where it came from without becoming a live reference to it.
 */
describe.skipIf(!hasDatabase)('operating expense templates', () => {
  let ctx: TestContext;
  let owner: Actor;
  let organizationId: string;

  beforeAll(async () => {
    ctx = await createTestContext();
    owner = await registerActor(ctx.app, 'oet-owner@example.invalid', 'Library Owner');
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
      url: `/api/v1/organizations/${orgId}/operating-expense-templates`,
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
      url: `/api/v1/organizations/${organizationId}/operating-expense-templates/real-estate-tax`,
      headers: authed(owner.cookie),
      payload: {
        name: 'Real estate tax',
        category: 'taxes',
        method: 'fixed_annual',
        amount: '185000',
        recoverableShare: '1',
        variableShare: '0',
      },
    });
    expect(response.statusCode).toBe(200);
    const body = response.json() as {
      template: { code: string; amount: string; recoverable_share: string };
    };
    expect(body.template.code).toBe('real-estate-tax');
    expect(body.template.amount).toBe('185000.000000');
    expect(body.template.recoverable_share).toBe('1.00000000');

    const templates = await list(owner.cookie, organizationId);
    expect(templates.map((t) => t.code)).toEqual(['real-estate-tax']);
  });

  it('editing the same code replaces it rather than creating a second entry', async () => {
    await ctx.app.inject({
      method: 'PUT',
      url: `/api/v1/organizations/${organizationId}/operating-expense-templates/real-estate-tax`,
      headers: authed(owner.cookie),
      payload: { name: 'Real estate tax, revised', amount: '192000' },
    });
    const templates = await list(owner.cookie, organizationId);
    expect(templates).toHaveLength(1);
    expect(templates[0]?.name).toBe('Real estate tax, revised');
  });

  it('applies defaults for every field it is not given', async () => {
    const response = await ctx.app.inject({
      method: 'PUT',
      url: `/api/v1/organizations/${organizationId}/operating-expense-templates/bare`,
      headers: authed(owner.cookie),
      payload: { name: 'Bare minimum' },
    });
    const template = (response.json() as { template: Record<string, unknown> }).template;
    expect(template.category).toBe('operating');
    expect(template.method).toBe('fixed_annual');
    expect(template.amount).toBe('0.000000');
    expect(template.recoverable_share).toBe('0.00000000');
    expect(template.variable_share).toBe('0.00000000');
    expect(template.is_capitalized).toBe(false);
  });

  it('refuses a recoverable or variable share outside 0..1', async () => {
    const response = await ctx.app.inject({
      method: 'PUT',
      url: `/api/v1/organizations/${organizationId}/operating-expense-templates/out-of-range`,
      headers: authed(owner.cookie),
      payload: { name: 'Out of range', recoverableShare: '1.5' },
    });
    // The database CHECK constraint (expense_templates_shares_range) is the
    // backstop here, mirroring operating_expenses' own constraint — the same
    // defense-in-depth already used for market_leasing_profiles' renewal
    // probability.
    expect(response.statusCode).toBeGreaterThanOrEqual(400);
    expect(await list(owner.cookie, organizationId)).not.toContainEqual(
      expect.objectContaining({ code: 'out-of-range' }),
    );
  });

  it('deletes a template, and refuses to delete one that does not exist', async () => {
    const deleted = await ctx.app.inject({
      method: 'DELETE',
      url: `/api/v1/organizations/${organizationId}/operating-expense-templates/bare`,
      headers: authed(owner.cookie),
    });
    expect(deleted.statusCode).toBe(200);
    expect((await list(owner.cookie, organizationId)).map((t) => t.code)).not.toContain('bare');

    const again = await ctx.app.inject({
      method: 'DELETE',
      url: `/api/v1/organizations/${organizationId}/operating-expense-templates/bare`,
      headers: authed(owner.cookie),
    });
    expect(again.statusCode).toBe(404);
  });

  it('is scoped to the organization: a stranger cannot read or write it', async () => {
    const stranger = await registerActor(
      ctx.app,
      'oet-stranger@example.invalid',
      'Library Stranger',
    );
    const strangerOrgId = await createOrganization(stranger.cookie, 'Unrelated Holdings');

    const read = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/organizations/${organizationId}/operating-expense-templates`,
      headers: authed(stranger.cookie),
    });
    expect(read.statusCode).toBe(403);

    const write = await ctx.app.inject({
      method: 'PUT',
      url: `/api/v1/organizations/${organizationId}/operating-expense-templates/hijack`,
      headers: authed(stranger.cookie),
      payload: { name: 'Hijack' },
    });
    expect(write.statusCode).toBe(403);

    expect(await list(stranger.cookie, strangerOrgId)).toEqual([]);
  });

  it('cannot be read or written without a session', async () => {
    const read = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/organizations/${organizationId}/operating-expense-templates`,
    });
    expect(read.statusCode).toBe(401);

    const write = await ctx.app.inject({
      method: 'PUT',
      url: `/api/v1/organizations/${organizationId}/operating-expense-templates/x`,
      headers: { 'x-requested-with': 'cre-platform', 'content-type': 'application/json' },
      payload: { name: 'x' },
    });
    expect(write.statusCode).toBe(401);
  });
});

/**
 * Applying a template to a model — the other half, checked the same way
 * `tests/market-leasing-profile-templates.test.ts`'s "provenance" block
 * checks it: at the real `operating_expenses` row, not trusted from the
 * UI's own JSON round-trip.
 */
describe.skipIf(!hasDatabase)('operating expense provenance', () => {
  let ctx: TestContext;
  let owner: Actor;
  let organizationId: string;
  let modelId: string;

  beforeAll(async () => {
    ctx = await createTestContext();
    owner = await registerActor(ctx.app, 'oep-owner@example.invalid', 'Provenance Owner');
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

  async function readExpense(code: string): Promise<{
    code: string;
    source_template_code: string | null;
    source_template_name: string | null;
  }> {
    const response = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/models/${modelId}/expenses`,
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
    if (!row) throw new Error(`No operating expense "${code}" was found.`);
    return row;
  }

  it('records where an expense started when it is seeded from the library', async () => {
    await ctx.app.inject({
      method: 'PUT',
      url: `/api/v1/organizations/${organizationId}/operating-expense-templates/insurance`,
      headers: authed(owner.cookie),
      payload: { name: 'Insurance', category: 'insurance', amount: '42000' },
    });

    const applied = await ctx.app.inject({
      method: 'PUT',
      url: `/api/v1/models/${modelId}/expenses/insurance`,
      headers: authed(owner.cookie),
      // What AssumptionsTab.tsx's templateToDraft for expenses seeds.
      payload: {
        name: 'Insurance',
        category: 'insurance',
        method: 'fixed_annual',
        amount: '42000',
        sourceTemplateCode: 'insurance',
        sourceTemplateName: 'Insurance',
      },
    });
    expect(applied.statusCode).toBe(200);

    const row = await readExpense('insurance');
    expect(row.source_template_code).toBe('insurance');
    expect(row.source_template_name).toBe('Insurance');
  });

  it('leaves a hand-entered expense with no library provenance', async () => {
    await ctx.app.inject({
      method: 'PUT',
      url: `/api/v1/models/${modelId}/expenses/hand-typed`,
      headers: authed(owner.cookie),
      payload: {
        name: 'Typed by hand',
        category: 'operating',
        method: 'fixed_annual',
        amount: '5000',
      },
    });

    const row = await readExpense('hand-typed');
    expect(row.source_template_code).toBeNull();
    expect(row.source_template_name).toBeNull();
  });

  it('keeps the provenance after a later edit that does not resend it', async () => {
    const edited = await ctx.app.inject({
      method: 'PUT',
      url: `/api/v1/models/${modelId}/expenses/insurance`,
      headers: authed(owner.cookie),
      payload: {
        name: 'Insurance, revised',
        category: 'insurance',
        method: 'fixed_annual',
        amount: '43500',
      },
    });
    expect(edited.statusCode).toBe(200);

    const row = await readExpense('insurance');
    expect(row.source_template_code).toBe('insurance');
    expect(row.source_template_name).toBe('Insurance');
  });

  it('deleting the library template does not change the model’s own copy', async () => {
    await ctx.app.inject({
      method: 'DELETE',
      url: `/api/v1/organizations/${organizationId}/operating-expense-templates/insurance`,
      headers: authed(owner.cookie),
    });

    const row = await readExpense('insurance');
    expect(row.source_template_code).toBe('insurance');
    expect(row.source_template_name).toBe('Insurance');
  });

  it('renaming the library template later does not rename historical provenance on the model', async () => {
    await ctx.app.inject({
      method: 'PUT',
      url: `/api/v1/organizations/${organizationId}/operating-expense-templates/utilities`,
      headers: authed(owner.cookie),
      payload: { name: 'Utilities', category: 'utilities', amount: '18000' },
    });
    await ctx.app.inject({
      method: 'PUT',
      url: `/api/v1/models/${modelId}/expenses/utilities`,
      headers: authed(owner.cookie),
      payload: {
        name: 'Utilities',
        category: 'utilities',
        method: 'fixed_annual',
        amount: '18000',
        sourceTemplateCode: 'utilities',
        sourceTemplateName: 'Utilities',
      },
    });

    await ctx.app.inject({
      method: 'PUT',
      url: `/api/v1/organizations/${organizationId}/operating-expense-templates/utilities`,
      headers: authed(owner.cookie),
      payload: {
        name: 'Utilities (renamed in the library)',
        category: 'utilities',
        amount: '18000',
      },
    });

    const row = await readExpense('utilities');
    expect(row.source_template_name).toBe('Utilities');
  });
});

/**
 * Math Check E — template vs hand-entered equivalence.
 *
 * `OperatingExpense` (the type `computeExpenseSeries` actually reads,
 * `packages/domain-models/src/model-input.ts`) has no
 * `sourceTemplateCode`/`sourceTemplateName` fields at all — provenance lives
 * only on the API/DB row, never in the `ModelInput` the calculation engine
 * consumes. That is a structural guarantee, checkable by reading the schema,
 * but this test checks it empirically instead: two models, financially
 * identical, one seeded from the organization library and one typed by
 * hand, run through the real API's `/calculate` and compared for byte-for-
 * byte identical output.
 */
describe.skipIf(!hasDatabase)(
  'Math Check E: template-derived and hand-entered expenses calculate identically',
  () => {
    let ctx: TestContext;
    let owner: Actor;
    let organizationId: string;

    beforeAll(async () => {
      ctx = await createTestContext();
      owner = await registerActor(ctx.app, 'oet-mathe-owner@example.invalid', 'Math E Owner');
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
          forecastMonths: 24,
          acquisitionPrice: '50000000',
          acquisitionCosts: '0',
          terminalCapRate: '0.06',
          saleMonth: 24,
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

    it('produces identical annual and monthly cash flow, whether the expense came from the library or was typed by hand', async () => {
      const manualModelId = await newModel('Math E manual');
      const templateModelId = await newModel('Math E template');

      const shared = {
        name: 'Real estate tax',
        category: 'taxes',
        method: 'fixed_annual',
        amount: '48123456.78',
        recoverableShare: '0.65',
        variableShare: '0.4',
      };

      await ctx.app.inject({
        method: 'PUT',
        url: `/api/v1/models/${manualModelId}/expenses/tax`,
        headers: authed(owner.cookie),
        payload: shared,
      });

      await ctx.app.inject({
        method: 'PUT',
        url: `/api/v1/organizations/${organizationId}/operating-expense-templates/tax-template`,
        headers: authed(owner.cookie),
        payload: shared,
      });
      await ctx.app.inject({
        method: 'PUT',
        url: `/api/v1/models/${templateModelId}/expenses/tax`,
        headers: authed(owner.cookie),
        payload: {
          ...shared,
          sourceTemplateCode: 'tax-template',
          sourceTemplateName: 'Real estate tax',
        },
      });

      const manual = await calculateAndRead(manualModelId);
      const template = await calculateAndRead(templateModelId);

      // Every calculated line, not a curated subset — provenance is the only
      // difference the two rows are allowed to have, and provenance is not a
      // calculation input.
      expect(template.annual.map((row) => row.lines)).toEqual(
        manual.annual.map((row) => row.lines),
      );
      expect(template.monthly).toEqual(manual.monthly);
    });
  },
);

/**
 * Math Check H — database round-trip precision.
 *
 * `operating_expenses.amount` is `numeric(20,6)` (migration 0003): 14
 * integer digits and 6 decimal digits, which was inspected as part of this
 * work rather than assumed. A high-precision, high-magnitude figure is
 * written through the real API (Zod parsing, then the `postgres` driver,
 * then Postgres's own `numeric` type) and read back, to check nothing
 * between the wire and the column truncates, floats, or re-rounds it.
 */
describe.skipIf(!hasDatabase)(
  'Math Check H: high-precision, high-magnitude values survive the database round trip',
  () => {
    let ctx: TestContext;
    let owner: Actor;
    let modelId: string;

    beforeAll(async () => {
      ctx = await createTestContext();
      owner = await registerActor(ctx.app, 'oet-mathh-owner@example.invalid', 'Math H Owner');
      await ctx.app.inject({
        method: 'POST',
        url: '/api/v1/organizations',
        headers: authed(owner.cookie),
        payload: { name: 'Cortland Ridge Advisors' },
      });
      const property = await ctx.app.inject({
        method: 'POST',
        url: '/api/v1/properties',
        headers: authed(owner.cookie),
        payload: { name: 'Math H property', propertyType: 'office', rentableArea: '500000' },
      });
      const propertyId = (property.json() as { property: { id: string } }).property.id;
      const model = await ctx.app.inject({
        method: 'POST',
        url: '/api/v1/models',
        headers: authed(owner.cookie),
        payload: {
          propertyId,
          name: 'Math H model',
          classification: 'acquisition',
          valuationDate: '2026-01-01',
          forecastStartDate: '2026-01-01',
          forecastMonths: 12,
        },
      });
      modelId = (model.json() as { model: { id: string } }).model.id;
    }, 60_000);

    afterAll(async () => {
      await ctx?.close();
    });

    it('round-trips a full six-decimal-digit amount at institutional scale with no precision loss', async () => {
      const put = await ctx.app.inject({
        method: 'PUT',
        url: `/api/v1/models/${modelId}/expenses/precision-check`,
        headers: authed(owner.cookie),
        payload: {
          name: 'Precision check',
          category: 'operating',
          method: 'fixed_annual',
          amount: '123456789012.345678',
          recoverableShare: '0.12345678',
          variableShare: '0.87654321',
        },
      });
      expect(put.statusCode).toBe(200);

      const list = await ctx.app.inject({
        method: 'GET',
        url: `/api/v1/models/${modelId}/expenses`,
        headers: authed(owner.cookie),
      });
      const items = (list.json() as { items: Array<Record<string, unknown>> }).items;
      const row = items.find((entry) => entry.code === 'precision-check');
      expect(row?.amount).toBe('123456789012.345678');
      expect(row?.recoverable_share).toBe('0.12345678');
      expect(row?.variable_share).toBe('0.87654321');
    });

    it('round-trips the same precision through the organization template table', async () => {
      const org = await ctx.app.inject({
        method: 'POST',
        url: '/api/v1/organizations',
        headers: authed(owner.cookie),
        payload: { name: 'Precision Template Org' },
      });
      const organizationId = (org.json() as { organization: { id: string } }).organization.id;

      const put = await ctx.app.inject({
        method: 'PUT',
        url: `/api/v1/organizations/${organizationId}/operating-expense-templates/precision-template`,
        headers: authed(owner.cookie),
        payload: {
          name: 'Precision template',
          amount: '123456789012.345678',
          recoverableShare: '0.12345678',
          variableShare: '0.87654321',
        },
      });
      expect(put.statusCode).toBe(200);
      const body = put.json() as {
        template: { amount: string; recoverable_share: string; variable_share: string };
      };
      expect(body.template.amount).toBe('123456789012.345678');
      expect(body.template.recoverable_share).toBe('0.12345678');
      expect(body.template.variable_share).toBe('0.87654321');
    });
  },
);

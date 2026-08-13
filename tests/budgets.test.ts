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
 * Budgets, actuals and variance, against a real database and the real routes.
 *
 * The engine-side arithmetic is proved in
 * `packages/calculation-engine/src/variance.test.ts`. What is proved here is
 * everything the arithmetic cannot see: that an approved budget is genuinely
 * frozen, that commentary cannot be signed off by its own author, that a
 * variance refuses to compare two different properties, and that none of it
 * leaks across organizations.
 */
describe.skipIf(!hasDatabase)('budgets, actuals and variance', () => {
  let ctx: TestContext;
  let owner: Actor;
  let reviewer: Actor;
  let reviewerCookie: string;
  let organizationId: string;
  let propertyId: string;
  let otherPropertyId: string;
  let budgetId: string;

  // A second organization, used to prove isolation.
  let outsider: Actor;
  let outsiderProperty: string;

  beforeAll(async () => {
    ctx = await createTestContext();

    owner = await registerActor(ctx.app, 'budget-owner@example.invalid', 'Budget Owner');
    organizationId = await createOrganization(owner.cookie, 'Ridgeline Asset Management');
    propertyId = await createProperty(owner.cookie, 'Ridgeline Plaza');
    otherPropertyId = await createProperty(owner.cookie, 'Ridgeline Annexe');

    // A reviewer in the same organization, so approval can be tested with the
    // two roles it actually needs.
    reviewer = await registerActor(ctx.app, 'budget-reviewer@example.invalid', 'Budget Reviewer');
    reviewerCookie = await joinAsReviewer(reviewer);

    outsider = await registerActor(ctx.app, 'budget-outsider@example.invalid', 'Outsider');
    await createOrganization(outsider.cookie, 'Unrelated Partners');
    outsiderProperty = await createProperty(outsider.cookie, 'Unrelated Tower');

    budgetId = await createBudget(owner.cookie, propertyId, 'approved_budget', 'FY2026 approved');
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

  async function joinAsReviewer(actor: Actor): Promise<string> {
    const invitation = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/organizations/${organizationId}/invitations`,
      headers: authed(owner.cookie),
      payload: { email: actor.email, role: 'reviewer' },
    });
    const token = (invitation.json() as { token: string }).token;
    await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/invitations/accept',
      headers: authed(actor.cookie),
      payload: { token },
    });
    return actor.cookie;
  }

  async function createProperty(cookie: string, name: string): Promise<string> {
    const response = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/properties',
      headers: authed(cookie),
      payload: { name, propertyType: 'office', rentableArea: '10000' },
    });
    return (response.json() as { property: { id: string } }).property.id;
  }

  async function createBudget(
    cookie: string,
    property: string,
    kind: string,
    label: string,
  ): Promise<string> {
    const response = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/budgets',
      headers: authed(cookie),
      payload: { propertyId: property, kind, fiscalYear: 2026, label },
    });
    if (response.statusCode !== 201) {
      throw new Error(`Budget creation failed (${response.statusCode}): ${response.body}`);
    }
    return (response.json() as { period: { id: string } }).period.id;
  }

  async function putEntries(
    cookie: string,
    id: string,
    entries: unknown[],
  ): Promise<{ statusCode: number; body: string }> {
    const response = await ctx.app.inject({
      method: 'PUT',
      url: `/api/v1/budgets/${id}/entries`,
      headers: authed(cookie),
      payload: { entries },
    });
    return { statusCode: response.statusCode, body: response.body };
  }

  const JANUARY_RENT = {
    accountCode: '4000',
    accountName: 'Base rent',
    accountCategory: 'revenue',
    periodMonth: '2026-01-01',
    amount: '100000',
  };
  const JANUARY_REPAIRS = {
    accountCode: '5100',
    accountName: 'Repairs',
    accountCategory: 'operating_expense',
    periodMonth: '2026-01-01',
    amount: '-20000',
  };

  /* ---------------------------------------------------------------------- */

  it('stores entries and reads them back', async () => {
    const written = await putEntries(owner.cookie, budgetId, [JANUARY_RENT, JANUARY_REPAIRS]);
    expect(written.statusCode).toBe(200);
    expect(JSON.parse(written.body).written).toBe(2);

    const read = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/budgets/${budgetId}`,
      headers: authed(owner.cookie),
    });
    const body = read.json() as { entries: Array<{ account_code: string; amount: string }> };
    expect(body.entries).toHaveLength(2);
    // Numeric columns arrive as strings; the money path never touches a float.
    expect(body.entries.find((entry) => entry.account_code === '4000')?.amount).toBe('100000.00');
  });

  it('replaces entries wholesale rather than appending', async () => {
    // A budget upload states the whole period. Appending would silently double
    // every account on the second upload.
    await putEntries(owner.cookie, budgetId, [JANUARY_RENT, JANUARY_REPAIRS]);
    const read = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/budgets/${budgetId}`,
      headers: authed(owner.cookie),
    });
    expect((read.json() as { entries: unknown[] }).entries).toHaveLength(2);
  });

  it('computes a variance between two budget periods', async () => {
    const actualsId = await createBudget(owner.cookie, propertyId, 'actual', 'FY2026 actuals');
    await putEntries(owner.cookie, actualsId, [
      { ...JANUARY_RENT, amount: '105000' },
      { ...JANUARY_REPAIRS, amount: '-23000' },
    ]);

    const response = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/variance?baseId=${budgetId}&comparisonId=${actualsId}`,
      headers: authed(owner.cookie),
    });
    expect(response.statusCode).toBe(200);

    const body = response.json() as {
      report: {
        rows: Array<{ accountCode: string; variance: string; designation: string }>;
        totalVariance: string;
        totalDesignation: string;
      };
    };
    // Rent 5,000 better; repairs 3,000 worse; net 2,000 favourable.
    expect(body.report.rows.find((row) => row.accountCode === '4000')?.variance).toBe('5000.00');
    expect(body.report.rows.find((row) => row.accountCode === '4000')?.designation).toBe(
      'favourable',
    );
    expect(body.report.rows.find((row) => row.accountCode === '5100')?.designation).toBe(
      'unfavourable',
    );
    expect(body.report.totalVariance).toBe('2000.00');
    expect(body.report.totalDesignation).toBe('favourable');
  });

  it('refuses to compare two different properties', async () => {
    const elsewhere = await createBudget(owner.cookie, otherPropertyId, 'actual', 'Annexe actuals');
    const response = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/variance?baseId=${budgetId}&comparisonId=${elsewhere}`,
      headers: authed(owner.cookie),
    });
    // A variance across two assets is a number with no meaning.
    expect(response.statusCode).toBe(400);
    expect(response.body).toContain('same property');
  });

  it("refuses to compare a budget against a different property's forecast", async () => {
    /*
     * Found by a tenth audit pass: the sibling comparisonId branch above
     * checks the two sides share a property; the comparisonModelId branch —
     * comparing a budget against a model's own forecast instead of another
     * budget — had no equivalent check, `getModel` being organization-scoped
     * only. A model belonging to the *other* property, compared against this
     * property's budget, would silently produce "a number with no meaning",
     * exactly what the sibling check exists to refuse.
     */
    const model = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/models',
      headers: authed(owner.cookie),
      payload: {
        propertyId: otherPropertyId,
        name: 'Annexe base case',
        classification: 'acquisition',
        valuationDate: '2026-01-01',
        forecastStartDate: '2026-01-01',
        forecastMonths: 12,
        saleMonth: 12,
      },
    });
    const modelId = (model.json() as { model: { id: string } }).model.id;
    await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/models/${modelId}/calculate`,
      headers: authed(owner.cookie),
    });

    const response = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/variance?baseId=${budgetId}&comparisonModelId=${modelId}`,
      headers: authed(owner.cookie),
    });
    expect(response.statusCode).toBe(400);
    expect(response.body).toContain('same property');
  });

  it('requires a comparison side to be named', async () => {
    const response = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/variance?baseId=${budgetId}`,
      headers: authed(owner.cookie),
    });
    expect(response.statusCode).toBe(400);
  });

  it('imports actuals from a wide trial balance', async () => {
    const actualsId = await createBudget(owner.cookie, propertyId, 'actual', 'Imported actuals');
    const csv = [
      'Account,Description,Category,Jan-26,Feb-26',
      '4000,Base rent,Revenue,100000,100000',
      '5100,Repairs,Operating expense,20000,18000',
    ].join('\n');

    const dryRun = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/budgets/${actualsId}/import/commit`,
      headers: authed(owner.cookie),
      payload: { content: csv, expenseSign: 'positive', dryRun: true },
    });
    expect(dryRun.statusCode).toBe(200);
    expect((dryRun.json() as { wouldWrite: number }).wouldWrite).toBe(4);

    // Nothing is written on a dry run.
    const beforeCommit = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/budgets/${actualsId}`,
      headers: authed(owner.cookie),
    });
    expect((beforeCommit.json() as { entries: unknown[] }).entries).toHaveLength(0);

    const commit = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/budgets/${actualsId}/import/commit`,
      headers: authed(owner.cookie),
      payload: { content: csv, expenseSign: 'positive' },
    });
    expect((commit.json() as { written: number }).written).toBe(4);

    const read = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/budgets/${actualsId}`,
      headers: authed(owner.cookie),
    });
    const entries = (read.json() as { entries: Array<{ account_code: string; amount: string }> })
      .entries;
    // The ledger states costs positive; they are stored in the cash-flow
    // convention so a favourable variance is simply a positive one.
    expect(entries.find((entry) => entry.account_code === '5100')?.amount).toBe('-20000.00');
    expect(entries.find((entry) => entry.account_code === '4000')?.amount).toBe('100000.00');
  });

  /* ---------------------------------------------------------------------- */
  /* Approval                                                                */
  /* ---------------------------------------------------------------------- */

  it('freezes a budget once approved', async () => {
    const id = await createBudget(owner.cookie, propertyId, 'original_budget', 'FY2026 original');
    await putEntries(owner.cookie, id, [JANUARY_RENT]);

    const approve = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/budgets/${id}/approve`,
      headers: authed(reviewerCookie),
    });
    expect(approve.statusCode).toBe(200);

    // Frozen: the figures someone signed off cannot be edited underneath them.
    const edit = await putEntries(owner.cookie, id, [{ ...JANUARY_RENT, amount: '1' }]);
    expect(edit.statusCode).toBe(400);
    expect(edit.body).toContain('approved');

    const remove = await ctx.app.inject({
      method: 'DELETE',
      url: `/api/v1/budgets/${id}`,
      headers: authed(owner.cookie),
    });
    expect(remove.statusCode).toBe(400);

    // And approving twice is refused rather than silently restamping.
    const again = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/budgets/${id}/approve`,
      headers: authed(reviewerCookie),
    });
    expect(again.statusCode).toBe(400);
  });

  /* ---------------------------------------------------------------------- */
  /* Commentary                                                              */
  /* ---------------------------------------------------------------------- */

  it('records commentary and refuses self-approval', async () => {
    const write = await ctx.app.inject({
      method: 'PUT',
      url: '/api/v1/variance/commentary',
      headers: authed(owner.cookie),
      payload: {
        propertyId,
        fiscalYear: 2026,
        periodMonth: '2026-01-01',
        accountCode: '5100',
        commentary: 'Roof repair brought forward from March after storm damage.',
      },
    });
    expect(write.statusCode).toBe(200);
    const id = (write.json() as { commentary: { id: string } }).commentary.id;

    // The author cannot sign off their own explanation: if they could, the
    // approval would record nothing.
    const self = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/variance/commentary/${id}/approve`,
      headers: authed(owner.cookie),
    });
    expect(self.statusCode).toBe(403);

    const approved = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/variance/commentary/${id}/approve`,
      headers: authed(reviewerCookie),
    });
    expect(approved.statusCode).toBe(200);
    const body = approved.json() as { commentary: { approved_text: string; approved_at: string } };
    // What was approved is recorded, not just that an approval happened.
    expect(body.commentary.approved_text).toContain('Roof repair');
    expect(body.commentary.approved_at).toBeTruthy();
  });

  it('clears the approval when the commentary is rewritten', async () => {
    const write = async (text: string): Promise<{ id: string; approvedAt: string | null }> => {
      const response = await ctx.app.inject({
        method: 'PUT',
        url: '/api/v1/variance/commentary',
        headers: authed(owner.cookie),
        payload: {
          propertyId,
          fiscalYear: 2026,
          periodMonth: '2026-02-01',
          accountCode: '4000',
          commentary: text,
        },
      });
      const body = response.json() as {
        commentary: { id: string; approved_at: string | null };
      };
      return { id: body.commentary.id, approvedAt: body.commentary.approved_at };
    };

    const first = await write('Rent under budget: one suite let later than planned.');
    await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/variance/commentary/${first.id}/approve`,
      headers: authed(reviewerCookie),
    });

    // Rewriting after approval withdraws it. A reviewer agreed to particular
    // words; letting those change underneath the signature would make the
    // approval a decoration.
    const rewritten = await write('Actually the suite was let on time; the invoice was late.');
    expect(rewritten.id).toBe(first.id);
    expect(rewritten.approvedAt).toBeNull();
  });

  /* ---------------------------------------------------------------------- */
  /* Isolation and permissions                                               */
  /* ---------------------------------------------------------------------- */

  it('hides another organization budget behind a 404, not a 403', async () => {
    const response = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/budgets/${budgetId}`,
      headers: authed(outsider.cookie),
    });
    // A 403 would confirm the identifier is real.
    expect(response.statusCode).toBe(404);
  });

  it('refuses to create a budget against another organization property', async () => {
    const response = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/budgets',
      headers: authed(owner.cookie),
      payload: {
        propertyId: outsiderProperty,
        kind: 'actual',
        fiscalYear: 2026,
        label: 'Should not exist',
      },
    });
    expect(response.statusCode).toBe(404);
  });

  it('does not list another organization budgets', async () => {
    const response = await ctx.app.inject({
      method: 'GET',
      url: '/api/v1/budgets',
      headers: authed(outsider.cookie),
    });
    expect((response.json() as { periods: unknown[] }).periods).toEqual([]);
  });

  it('refuses budget writes from a role without budget:write', async () => {
    // A reviewer may approve a budget but not author one.
    const response = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/budgets',
      headers: authed(reviewerCookie),
      payload: {
        propertyId,
        kind: 'actual',
        fiscalYear: 2026,
        label: 'Reviewer should not be able to create this',
      },
    });
    expect(response.statusCode).toBe(403);
  });
});

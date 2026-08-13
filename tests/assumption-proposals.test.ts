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
 * The assumption input contract, end to end.
 *
 * An outside system can say what it believes about an assumption. It cannot
 * change one. The tests that matter here are all about that boundary:
 *
 * - a posted proposal changes nothing in the model;
 * - accepting one changes exactly the assumption it names, and nothing beside
 *   it;
 * - a decision cannot be made twice, because the second acceptance would apply
 *   a value again while reporting a change it did not make;
 * - a rejection is kept, because "we saw the market number and stayed at 3.0%"
 *   is the answer to the question a reviewer actually asks.
 */
describe.skipIf(!hasDatabase)('assumption proposals', () => {
  let ctx: TestContext;
  let owner: Actor;
  let modelId: string;

  beforeAll(async () => {
    ctx = await createTestContext();
    owner = await registerActor(ctx.app, 'provenance@example.invalid', 'Provenance Owner');

    await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/organizations',
      headers: authed(owner.cookie),
      payload: { name: 'Harlow Street Partners' },
    });

    const property = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/properties',
      headers: authed(owner.cookie),
      payload: { name: 'Harlow Street', propertyType: 'office', rentableArea: '85000' },
    });
    const propertyId = (property.json() as { property: { id: string } }).property.id;

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
        discountRate: '0.085',
        terminalCapRate: '0.06',
        generalVacancyRate: '0.05',
        saleMonth: 60,
      },
    });
    modelId = (model.json() as { model: { id: string } }).model.id;

    await ctx.app.inject({
      method: 'PUT',
      url: `/api/v1/models/${modelId}/expenses/OPEX-INS`,
      headers: authed(owner.cookie),
      payload: {
        name: 'Insurance',
        category: 'operating',
        method: 'fixed_annual',
        amount: '145000',
        accountCode: '6400',
        recoverableShare: '0.95',
        monthlySchedule: [],
      },
    });
  }, 60_000);

  afterAll(async () => {
    await ctx?.close();
  });

  /* ---------------------------------------------------------------------- */

  async function post(proposals: unknown[]): Promise<{ statusCode: number; body: string }> {
    const response = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/models/${modelId}/assumption-proposals`,
      headers: authed(owner.cookie),
      payload: { proposals },
    });
    return { statusCode: response.statusCode, body: response.body };
  }

  interface Listed {
    id: string;
    target: string;
    value: string | null;
    status: string;
    current: string | null;
    applicable: boolean;
    applicableReason: string | null;
    decision_note: string | null;
    source_name: string;
  }

  async function list(status?: string): Promise<Listed[]> {
    const response = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/models/${modelId}/assumption-proposals${status ? `?status=${status}` : ''}`,
      headers: authed(owner.cookie),
    });
    return (response.json() as { proposals: Listed[] }).proposals;
  }

  async function decide(
    id: string,
    decision: 'accepted' | 'rejected',
    note?: string,
  ): Promise<{ statusCode: number; body: string }> {
    const response = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/models/${modelId}/assumption-proposals/${id}/decision`,
      headers: authed(owner.cookie),
      payload: { decision, ...(note ? { note } : {}) },
    });
    return { statusCode: response.statusCode, body: response.body };
  }

  async function model(): Promise<Record<string, unknown>> {
    const response = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/models/${modelId}`,
      headers: authed(owner.cookie),
    });
    return (response.json() as { model: Record<string, unknown> }).model;
  }

  async function expense(code: string): Promise<Record<string, unknown>> {
    const response = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/models/${modelId}/expenses`,
      headers: authed(owner.cookie),
    });
    const items = (response.json() as { items: Array<Record<string, unknown>> }).items;
    const found = items.find((item) => item.code === code);
    if (!found) throw new Error(`expenses/${code} not found`);
    return found;
  }

  /* ---------------------------------------------------------------------- */

  it('records a proposal without touching the model', async () => {
    /*
     * The load-bearing test. Everything else on this screen is presentation;
     * this is the promise — a source reports, and the model is exactly as its
     * analyst left it.
     */
    const before = await model();

    const result = await post([
      {
        target: 'valuation.terminalCapRate',
        value: '0.0575',
        sourceKind: 'market_data',
        sourceName: 'test3',
        confidence: 0.81,
        observedAt: '2026-03-31T00:00:00.000Z',
        evidence: { comparables: 14, submarket: 'Wake County, NC' },
        notes: 'Four office trades in the last two quarters.',
      },
    ]);
    expect(result.statusCode).toBe(201);

    const after = await model();
    expect(Number(after.terminal_cap_rate)).toBeCloseTo(0.06, 8);
    expect(after.version).toBe(before.version);
  });

  it('shows the proposal beside the value the engine actually reads', async () => {
    const [proposal] = await list('pending');
    expect(proposal?.target).toBe('valuation.terminalCapRate');
    // Not read from the models table — from the assembled ModelInput, which is
    // what the engine consumes. Comparing against anything else would compare
    // against a number the model does not use.
    expect(Number(proposal?.current)).toBeCloseTo(0.06, 8);
    expect(proposal?.value).toBe('0.0575');
    expect(proposal?.applicable).toBe(true);
  });

  it('keeps the source’s evidence and its observation date intact', async () => {
    const response = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/models/${modelId}/assumption-proposals?status=pending`,
      headers: authed(owner.cookie),
    });
    const [proposal] = (
      response.json() as {
        proposals: Array<{
          evidence: Record<string, unknown>;
          observed_at: string | null;
          confidence: string | null;
        }>;
      }
    ).proposals;

    // Rendered as given and never parsed for meaning, so a source can show its
    // working without the contract knowing the shape in advance.
    expect(proposal?.evidence).toEqual({ comparables: 14, submarket: 'Wake County, NC' });
    // Distinct from arrival: a March comparable is a March comparable in July.
    expect(proposal?.observed_at).toContain('2026-03-31');
    expect(Number(proposal?.confidence)).toBeCloseTo(0.81, 4);
  });

  it('applies the value only when somebody accepts it', async () => {
    const [proposal] = await list('pending');
    const result = await decide(proposal?.id as string, 'accepted', 'Comparables are convincing.');
    expect(result.statusCode).toBe(200);

    const after = await model();
    expect(Number(after.terminal_cap_rate)).toBeCloseTo(0.0575, 8);
    // Only what the target named. The discount rate sat next to it in the same
    // section and must not have moved.
    expect(Number(after.discount_rate)).toBeCloseTo(0.085, 8);
    expect(Number(after.general_vacancy_rate)).toBeCloseTo(0.05, 8);

    const [decided] = await list('accepted');
    expect(decided?.decision_note).toBe('Comparables are convincing.');
  });

  it('refuses a second decision on the same proposal', async () => {
    /*
     * Not pedantry. Accepting applies a value; a second acceptance would write
     * it again and report a change that had already happened, which is how two
     * people looking at the same list at the same time end up disagreeing about
     * what the model says.
     */
    const [decided] = await list('accepted');
    const result = await decide(decided?.id as string, 'rejected');
    expect(result.statusCode).toBe(400);
    expect(result.body).toContain('already accepted');
  });

  it('records a rejection rather than deleting it', async () => {
    await post([
      {
        target: 'vacancy.generalVacancyRate',
        value: '0.09',
        sourceKind: 'market_data',
        sourceName: 'test3',
        evidence: {},
      },
    ]);
    const proposal = (await list('pending')).find(
      (entry) => entry.target === 'vacancy.generalVacancyRate',
    );

    const result = await decide(
      proposal?.id as string,
      'rejected',
      'Our own leasing pipeline is stronger than the submarket average.',
    );
    expect(result.statusCode).toBe(200);

    // The model kept its own number...
    expect(Number((await model()).general_vacancy_rate)).toBeCloseTo(0.05, 8);
    // ...and the fact that the alternative was considered survived, which is
    // the question a reviewer actually asks.
    const rejected = (await list('rejected')).find(
      (entry) => entry.target === 'vacancy.generalVacancyRate',
    );
    expect(rejected?.decision_note).toContain('leasing pipeline');
  });

  it('supersedes a source’s earlier view rather than stacking it', async () => {
    /*
     * A source reporting monthly is stating its current view, not adding to a
     * pile. Left to stack, an analyst returning after a quarter is asked to
     * decide between four versions of one opinion, three of which the source no
     * longer holds.
     */
    const first = await post([
      {
        target: 'marketLeasing.MLA-OFF.marketRent',
        value: '39.00',
        sourceKind: 'market_data',
        sourceName: 'test3',
        evidence: {},
      },
    ]);
    expect(first.statusCode).toBe(201);

    const second = await post([
      {
        target: 'marketLeasing.MLA-OFF.marketRent',
        value: '41.50',
        sourceKind: 'market_data',
        sourceName: 'test3',
        evidence: {},
      },
    ]);
    expect(JSON.parse(second.body).superseded).toBe(1);

    const live = (await list('pending')).filter(
      (entry) => entry.target === 'marketLeasing.MLA-OFF.marketRent',
    );
    expect(live).toHaveLength(1);
    expect(live[0]?.value).toBe('41.50');
    // The earlier view is kept, not deleted. What a source said in March is
    // still what it said in March.
    const superseded = (await list('superseded')).filter(
      (entry) => entry.target === 'marketLeasing.MLA-OFF.marketRent',
    );
    expect(superseded.map((entry) => entry.value)).toContain('39.00');
  });

  it('does not supersede a different source saying something different', async () => {
    // Two services disagreeing about market rent is information; collapsing
    // them to whichever wrote last would destroy it.
    const result = await post([
      {
        target: 'marketLeasing.MLA-OFF.marketRent',
        value: '36.75',
        sourceKind: 'calculated',
        sourceName: 'test1',
        evidence: {},
      },
    ]);
    expect(JSON.parse(result.body).superseded).toBe(0);

    const live = (await list('pending')).filter(
      (entry) => entry.target === 'marketLeasing.MLA-OFF.marketRent',
    );
    expect(live).toHaveLength(2);
    expect(live.map((entry) => entry.source_name).sort()).toEqual(['test1', 'test3']);
  });

  it('writes a collection field without disturbing the rest of the row', async () => {
    /*
     * The same merge the grid's batch write relies on. An accepted proposal
     * about one field must not clear an account code, a recovery share or a
     * schedule that the contract knows nothing about.
     */
    const before = await expense('OPEX-INS');

    await post([
      {
        target: 'expenses.OPEX-INS.amount',
        value: '162000',
        sourceKind: 'historical',
        sourceName: 'test1',
        evidence: { basis: 'Twelve months of paid invoices' },
      },
    ]);
    const proposal = (await list('pending')).find(
      (entry) => entry.target === 'expenses.OPEX-INS.amount',
    );
    expect(proposal?.current).toBeTruthy();
    expect(Number(proposal?.current)).toBeCloseTo(145000, 2);

    expect((await decide(proposal?.id as string, 'accepted')).statusCode).toBe(200);

    const after = await expense('OPEX-INS');
    expect(Number(after.amount)).toBeCloseTo(162000, 2);
    expect(after.account_code).toBe(before.account_code);
    expect(Number(after.recoverable_share)).toBeCloseTo(0.95, 8);
    expect(after.method).toBe('fixed_annual');
  });

  it('keeps a proposal it cannot apply, and says why', async () => {
    /*
     * A source with a view on something this release does not model is telling
     * us something true about a gap in the product. Dropping it would be the
     * worst of the options; pretending the accept button works would be the
     * second worst.
     */
    await post([
      {
        target: 'dataCentre.powerCostPerKw',
        value: '0.11',
        sourceKind: 'market_data',
        sourceName: 'test3',
        evidence: {},
      },
    ]);
    const proposal = (await list('pending')).find(
      (entry) => entry.target === 'dataCentre.powerCostPerKw',
    );
    expect(proposal?.applicable).toBe(false);
    expect(proposal?.current).toBeNull();
    expect(proposal?.applicableReason).toContain('does not model');

    const result = await decide(proposal?.id as string, 'accepted');
    expect(result.statusCode).toBe(422);
    // Rejecting it is still allowed: the decision is about the analyst's view,
    // not about whether the software can act on it.
    expect((await decide(proposal?.id as string, 'rejected', 'Noted.')).statusCode).toBe(200);
  });

  it('refuses to accept an enum proposal whose value is not one of the target’s real members', async () => {
    /*
     * Found by a tenth audit pass: accepting a proposal only checked
     * `describeTarget(...).ok` — that the target exists — never that the
     * proposed value was actually one of the target's allowed members.
     * `valuation.terminalNoiBasis` only has two real values
     * (`forward_12`/`trailing_12`); a plausible-looking near-miss like
     * `trailing_120` used to be accepted as "text" and written straight into
     * the `models` table, where nothing failed until the next calculation —
     * `parseModelInput`'s strict schema enum would throw, and the model
     * would stay uncalculable until someone found and repaired the row by
     * hand. Confirms both that accepting is refused, and that the value
     * already written before this bug was ever found is not silently
     * repeated: nothing here should touch the column at all.
     */
    const before = await model();

    await post([
      {
        target: 'valuation.terminalNoiBasis',
        value: 'trailing_120',
        valueType: 'enum',
        sourceKind: 'imported',
        sourceName: 'enum-membership-check',
        evidence: {},
      },
    ]);
    const proposal = (await list('pending')).find(
      (entry) => entry.target === 'valuation.terminalNoiBasis',
    );
    expect(proposal).toBeDefined();

    const result = await decide(proposal?.id as string, 'accepted');
    expect(result.statusCode).toBe(422);
    expect(result.body).toContain('trailing_120');

    const after = await model();
    expect(after.terminal_noi_basis).toBe(before.terminal_noi_basis);
  });

  it('refuses to apply a proposal that carries no figure', async () => {
    await post([
      {
        target: 'valuation.discountRate',
        value: null,
        sourceKind: 'recommended',
        sourceName: 'test3',
        evidence: {},
        notes: 'Three competing developments are in planning in this submarket.',
      },
    ]);
    const proposal = (await list('pending')).find(
      (entry) => entry.target === 'valuation.discountRate',
    );

    const result = await decide(proposal?.id as string, 'accepted');
    expect(result.statusCode).toBe(422);
    expect(result.body).toContain('remark');
    // Unchanged, which is the point.
    expect(Number((await model()).discount_rate)).toBeCloseTo(0.085, 8);
  });

  it('applies a typed proposal per its own valueType, not always as a decimal', async () => {
    /*
     * The widened part of the contract: an integer, a date, a boolean and an
     * enum, each written with the cast its own value_type calls for rather
     * than the ::numeric cast every proposal used before this. If the cast
     * were wrong, this would not fail loudly — postgres would silently
     * truncate or reject, and the wrong error message would show up instead
     * of a clean apply.
     */
    const before = await model();

    const cases: Array<{
      target: string;
      value: string;
      valueType: string;
      read: (row: Record<string, unknown>) => unknown;
      expected: unknown;
    }> = [
      {
        target: 'valuation.saleMonth',
        value: '48',
        valueType: 'integer',
        read: (row) => row.sale_month,
        expected: 48,
      },
      {
        target: 'valuation.terminalNoiBasis',
        value: 'trailing_12',
        valueType: 'enum',
        read: (row) => row.terminal_noi_basis,
        expected: 'trailing_12',
      },
      {
        target: 'valuation.acquisitionDate',
        value: '2026-04-01',
        valueType: 'date',
        read: (row) => new Date(row.acquisition_date as string).toISOString().slice(0, 10),
        expected: '2026-04-01',
      },
      {
        target: 'vacancy.netAgainstModelledVacancy',
        value: 'false',
        valueType: 'boolean',
        read: (row) => row.net_against_modelled_vacancy,
        expected: false,
      },
    ];

    for (const testCase of cases) {
      const posted = await post([
        {
          target: testCase.target,
          value: testCase.value,
          valueType: testCase.valueType,
          sourceKind: 'imported',
          sourceName: 'typed-value-check',
          evidence: {},
        },
      ]);
      expect(posted.statusCode, testCase.target).toBe(201);

      const proposal = (await list('pending')).find((entry) => entry.target === testCase.target);
      expect(proposal, testCase.target).toBeDefined();
      expect(proposal?.applicable, testCase.target).toBe(true);

      const decided = await decide(proposal?.id as string, 'accepted');
      expect(decided.statusCode, testCase.target).toBe(200);

      const after = await model();
      expect(testCase.read(after), testCase.target).toEqual(testCase.expected);
    }

    // The decimal fields beside them did not move.
    expect(Number((await model()).discount_rate)).toBeCloseTo(0.085, 8);
    void before;
  });

  it('refuses a typed value that does not match its own valueType', async () => {
    const result = await post([
      {
        target: 'valuation.saleMonth',
        value: 'soon',
        valueType: 'integer',
        sourceKind: 'imported',
        sourceName: 'invalid-type-check',
        evidence: {},
      },
    ]);
    expect(result.statusCode).toBe(400);
    expect(result.body).toContain('whole number');
  });

  it('cannot be read or decided from another organization', async () => {
    const stranger = await registerActor(ctx.app, 'stranger-prov@example.invalid', 'Stranger');
    await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/organizations',
      headers: authed(stranger.cookie),
      payload: { name: 'Unrelated Holdings' },
    });

    const [proposal] = await list('accepted');
    const read = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/models/${modelId}/assumption-proposals`,
      headers: authed(stranger.cookie),
    });
    expect(read.statusCode).toBe(404);

    const decision = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/models/${modelId}/assumption-proposals/${proposal?.id}/decision`,
      headers: authed(stranger.cookie),
      payload: { decision: 'rejected' },
    });
    expect(decision.statusCode).toBe(404);
  });
});

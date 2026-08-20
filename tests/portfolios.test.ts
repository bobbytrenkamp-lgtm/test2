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
 * Portfolio aggregation.
 *
 * The aggregate reads one leading model per property and combines their stored
 * results. Which model leads, and what happens to a property that has none, are
 * the decisions that make the number defensible — so those are what is asserted
 * here rather than the arithmetic, which `packages/calculation-engine` covers.
 *
 * These tests were written when the per-property loop was replaced by a single
 * `DISTINCT ON` query, because a rewrite of a query nobody was testing is a
 * rewrite of something nobody would notice breaking.
 */
describe.skipIf(!hasDatabase)('portfolio aggregation', () => {
  let ctx: TestContext;
  let owner: Actor;
  let outsider: Actor;

  let calculated: string;
  let originalModel: string;
  let originalValue: unknown;
  let uncalculated: string;
  let modelless: string;
  let portfolioId: string;

  beforeAll(async () => {
    ctx = await createTestContext();

    owner = await registerActor(ctx.app, 'portfolio-owner@example.invalid', 'Portfolio Owner');
    await createOrganization(owner.cookie, 'Kestrel Investment Management');

    // Three properties covering the three outcomes the aggregate distinguishes.
    calculated = await createProperty(owner.cookie, 'Kestrel One');
    uncalculated = await createProperty(owner.cookie, 'Kestrel Two');
    modelless = await createProperty(owner.cookie, 'Kestrel Three');

    originalModel = await createModel(owner.cookie, calculated, 'One base case');
    await addLease(owner.cookie, originalModel);
    await calculate(owner.cookie, originalModel);

    // A model with no calculation run at all.
    await createModel(owner.cookie, uncalculated, 'Two base case');

    portfolioId = await createPortfolio(owner.cookie, 'Kestrel Fund I', [
      calculated,
      uncalculated,
      modelless,
    ]);

    outsider = await registerActor(ctx.app, 'portfolio-outsider@example.invalid', 'Outsider');
    await createOrganization(outsider.cookie, 'Somebody Else LLP');
  }, 90_000);

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

  async function createProperty(cookie: string, name: string): Promise<string> {
    const response = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/properties',
      headers: authed(cookie),
      payload: { name, propertyType: 'office', rentableArea: '20000' },
    });
    const propertyId = (response.json() as { property: { id: string } }).property.id;
    await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/properties/${propertyId}/spaces`,
      headers: authed(cookie),
      payload: { code: 'WHOLE', spaceType: 'office', area: '20000' },
    });
    return propertyId;
  }

  async function createModel(
    cookie: string,
    propertyId: string,
    name: string,
    classification = 'valuation',
  ): Promise<string> {
    const response = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/models',
      headers: authed(cookie),
      payload: {
        propertyId,
        name,
        classification,
        valuationDate: '2026-01-01',
        forecastStartDate: '2026-01-01',
        forecastMonths: 36,
        discountRate: '0.08',
        terminalCapRate: '0.07',
        terminalNoiBasis: 'trailing_12',
        saleMonth: 24,
        acquisitionPrice: '5000000',
      },
    });
    if (response.statusCode !== 201) {
      throw new Error(`Model creation failed (${response.statusCode}): ${response.body}`);
    }
    return (response.json() as { model: { id: string } }).model.id;
  }

  async function addLease(cookie: string, modelId: string, rent = '30.00'): Promise<void> {
    const tenant = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/tenants',
      headers: authed(cookie),
      payload: { name: 'Anchor Tenant' },
    });
    const tenantId = (tenant.json() as { tenant: { id: string } }).tenant.id;
    await ctx.app.inject({
      method: 'PUT',
      url: `/api/v1/models/${modelId}/leases/L-1`,
      headers: authed(cookie),
      payload: {
        tenantId,
        status: 'occupied',
        area: '20000',
        spaceIds: ['WHOLE'],
        commencementDate: '2026-01-01',
        expirationDate: '2030-12-31',
        baseRent: rent,
        baseRentBasis: 'per_area_per_year',
      },
    });
  }

  async function calculate(cookie: string, modelId: string): Promise<void> {
    const response = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/models/${modelId}/calculate`,
      headers: authed(cookie),
      payload: {},
    });
    if (response.statusCode !== 200) {
      throw new Error(`Calculate failed (${response.statusCode}): ${response.body}`);
    }
  }

  async function createPortfolio(
    cookie: string,
    name: string,
    propertyIds: string[],
  ): Promise<string> {
    const response = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/portfolios',
      headers: authed(cookie),
      payload: { name, propertyIds },
    });
    if (response.statusCode !== 201) {
      throw new Error(`Portfolio creation failed (${response.statusCode}): ${response.body}`);
    }
    return (response.json() as { portfolio: { id: string } }).portfolio.id;
  }

  interface AggregateBody {
    portfolio: { id: string; name: string };
    aggregate: Record<string, unknown>;
    included: Array<{ propertyId: string; propertyName: string }>;
    excluded: Array<{ propertyId: string; propertyName: string; reason: string }>;
  }

  async function aggregate(cookie: string, id = portfolioId, query = ''): Promise<AggregateBody> {
    const response = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/portfolios/${id}/aggregate${query}`,
      headers: authed(cookie),
    });
    if (response.statusCode !== 200) {
      throw new Error(`Aggregate failed (${response.statusCode}): ${response.body}`);
    }
    return response.json() as AggregateBody;
  }

  /* ---------------------------------------------------------------------- */

  it('includes a property whose model has been calculated', async () => {
    const body = await aggregate(owner.cookie);
    expect(body.included.map((entry) => entry.propertyName)).toEqual(['Kestrel One']);
    expect(body.aggregate.propertyCount).toBe(1);
    originalValue = body.aggregate.grossAssetValue;
    expect(originalValue).toBeTruthy();
  });

  it('excludes a property with no model, and says why', async () => {
    const body = await aggregate(owner.cookie);
    const entry = body.excluded.find((row) => row.propertyId === modelless);
    expect(entry).toBeDefined();
    expect(entry?.reason).toContain('No model');
  });

  it('excludes a property whose model has never been calculated, and says why', async () => {
    // This is the case the rewrite could most easily have broken: a model that
    // exists but has no run. Under the old loop that was a second query
    // returning nothing; under the single query it is a row with a null result.
    const body = await aggregate(owner.cookie);
    const entry = body.excluded.find((row) => row.propertyId === uncalculated);
    expect(entry).toBeDefined();
    expect(entry?.reason).toContain('not been calculated');
  });

  it('reports exclusions rather than quietly aggregating a subset', async () => {
    const body = await aggregate(owner.cookie);
    // Three properties in, one included, two accounted for. A portfolio number
    // that silently dropped two assets would be worse than no number.
    expect(body.included.length + body.excluded.length).toBe(3);
  });

  it('prefers a published model over a more recently updated draft', async () => {
    // A second model on the same property at a materially different rent, so
    // the two produce different values and the assertions below can actually
    // tell which one led. Two models that happened to agree would make this
    // test pass while proving nothing.
    const rival = await createModel(owner.cookie, calculated, 'One rival revision');
    await addLease(owner.cookie, rival, '60.00');
    await calculate(owner.cookie, rival);

    const withRival = await aggregate(owner.cookie);
    const rivalValue = withRival.aggregate.grossAssetValue;

    // Both are drafts, so the most recently updated leads — and the rival was
    // written last.
    expect(rivalValue).not.toBe(originalValue);

    // Publishing the original must put it back in front, even though the rival
    // is newer, because status outranks recency.
    for (const to of ['analyst_review', 'manager_review', 'approved', 'published']) {
      const response = await ctx.app.inject({
        method: 'POST',
        url: `/api/v1/models/${originalModel}/transition`,
        headers: authed(owner.cookie),
        payload: { to },
      });
      if (response.statusCode !== 200) {
        throw new Error(`Transition to ${to} failed (${response.statusCode}): ${response.body}`);
      }
    }

    const withPublished = await aggregate(owner.cookie);
    expect(withPublished.aggregate.grossAssetValue).toBe(originalValue);
    expect(withPublished.included).toHaveLength(1);
  });

  it('honours a classification filter', async () => {
    // Nothing in this portfolio is a reforecast, so every property falls out
    // and the request is refused rather than returning an empty aggregate.
    const response = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/portfolios/${portfolioId}/aggregate?modelClassification=reforecast`,
      headers: authed(owner.cookie),
    });
    expect(response.statusCode).toBe(400);
    expect(response.body).toContain('nothing to aggregate');
  });

  it('hides another organization portfolio behind a 404', async () => {
    const response = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/portfolios/${portfolioId}/aggregate`,
      headers: authed(outsider.cookie),
    });
    expect(response.statusCode).toBe(404);
  });

  it('rejects a dynamic filter shaped wrong with a 400, not an unhandled 500', async () => {
    // propertyTypes has to be an array for the ::text[] cast this filter
    // compiles down to in resolvePortfolioMembership; a bare string is valid
    // JSON and would previously reach that cast unchecked, where Postgres
    // itself throws "malformed array literal" and the global handler turns
    // that into a bare 500 with no indication which field was wrong.
    const created = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/portfolios',
      headers: authed(owner.cookie),
      payload: {
        name: 'Bad Filter Portfolio',
        isDynamic: true,
        filterDefinition: { propertyTypes: 'office' },
      },
    });
    expect(created.statusCode).toBe(400);

    const response = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/portfolios/${portfolioId}/aggregate`,
      headers: authed(owner.cookie),
    });
    expect(response.statusCode).not.toBe(500);
  });
});

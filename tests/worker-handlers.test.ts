import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { JobRow } from '@cre/database';
import { handlers } from '../apps/worker/src/handlers.js';
import {
  authed,
  createTestContext,
  hasDatabase,
  registerActor,
  type Actor,
  type TestContext,
} from './helpers.js';

/**
 * The `aggregate_portfolio` background job handler, across organizations.
 *
 * Found by a repository-wide correctness audit: unlike every other job
 * handler in `apps/worker/src/handlers.ts`, `aggregate_portfolio` read
 * `portfolio_properties`/`properties` by `portfolioId` alone, with no check
 * that the portfolio belonged to `job.organization_id`. No current API route
 * enqueues this job kind — `GET /portfolios/:id/aggregate` computes the same
 * thing synchronously and organization-scoped, through a different code path
 * — but `enqueueJob` is a generic, exported function, and a job's handler is
 * the last line of defense against a payload that names another
 * organization's portfolio, however it got enqueued. Testing the handler
 * directly (bypassing the queue) is the only way to exercise it at all,
 * since nothing else in the codebase currently reaches it.
 */
describe.skipIf(!hasDatabase)('aggregate_portfolio job handler', () => {
  let ctx: TestContext;
  let ownerA: Actor;
  let ownerB: Actor;
  let orgA: string;
  let orgB: string;
  let portfolioA: string;

  beforeAll(async () => {
    ctx = await createTestContext();

    ownerA = await registerActor(ctx.app, 'worker-owner-a@example.invalid', 'Owner A');
    orgA = await createOrganization(ownerA.cookie, 'Worker Test Alpha');

    const propertyA = await createProperty(ownerA.cookie, 'Alpha Warehouse');
    const modelA = await createModel(ownerA.cookie, propertyA, 'Alpha base case');
    await addLease(ownerA.cookie, modelA);
    await calculateModel(ownerA.cookie, modelA);
    portfolioA = await createPortfolio(ownerA.cookie, 'Alpha Fund', [propertyA]);

    ownerB = await registerActor(ctx.app, 'worker-owner-b@example.invalid', 'Owner B');
    orgB = await createOrganization(ownerB.cookie, 'Worker Test Beta');
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

  async function createModel(cookie: string, propertyId: string, name: string): Promise<string> {
    const response = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/models',
      headers: authed(cookie),
      payload: {
        propertyId,
        name,
        classification: 'valuation',
        valuationDate: '2026-01-01',
        forecastStartDate: '2026-01-01',
        forecastMonths: 24,
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

  async function addLease(cookie: string, modelId: string): Promise<void> {
    const tenant = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/tenants',
      headers: authed(cookie),
      payload: { name: 'Alpha Anchor Tenant' },
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
        baseRent: '30.00',
        baseRentBasis: 'per_area_per_year',
      },
    });
  }

  async function calculateModel(cookie: string, modelId: string): Promise<void> {
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

  function fakeJob(organizationId: string, portfolioId: string): JobRow {
    return {
      id: '00000000-0000-0000-0000-000000000000',
      organization_id: organizationId,
      kind: 'aggregate_portfolio',
      payload: { portfolioId },
      status: 'running',
      attempts: 1,
      max_attempts: 3,
      created_at: new Date(),
      completed_at: null,
      result: null,
      error_message: null,
    };
  }

  it('aggregates a portfolio for the organization that owns it', async () => {
    const result = (await handlers.aggregate_portfolio(ctx.sql, fakeJob(orgA, portfolioA))) as {
      aggregate: { propertyCount: number };
    };
    expect(result.aggregate.propertyCount).toBe(1);
  });

  it('refuses to aggregate another organization’s portfolio', async () => {
    // Org B's own id, but Org A's real, calculated portfolio in the payload
    // -- exactly the shape a job whose payload was not re-validated at the
    // handler would accept. Before the fix this returned Org A's real
    // property and financial data to a job tagged as Org B's; after the fix
    // it must throw before ever reading `portfolio_properties`.
    await expect(handlers.aggregate_portfolio(ctx.sql, fakeJob(orgB, portfolioA))).rejects.toThrow(
      /not found in this organization/,
    );
  });
});

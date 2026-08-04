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
 * The first vertical slice, exercised end to end against a real database and
 * the real HTTP routes: sign in, create an organization and a property, enter
 * assumptions, add a tenant and a lease with rent steps, calculate, read the
 * cash flow and the discounted cash-flow value, save the model, reopen it, and
 * trace the numbers back to the assumptions that produced them.
 *
 * Nothing here is stubbed. If persistence, authorization or the engine were
 * broken, this test would fail.
 */
describe.skipIf(!hasDatabase)('vertical slice', () => {
  let ctx: TestContext;
  let analyst: Actor;
  let organizationId: string;
  let propertyId: string;
  let modelId: string;
  let tenantId: string;

  beforeAll(async () => {
    ctx = await createTestContext();
    analyst = await registerActor(ctx.app, 'slice@example.invalid', 'Slice Analyst');
  }, 60_000);

  afterAll(async () => {
    await ctx?.close();
  });

  it('1. signs in and reports no organization yet', async () => {
    const response = await ctx.app.inject({
      method: 'GET',
      url: '/api/v1/auth/me',
      headers: authed(analyst.cookie),
    });
    expect(response.statusCode).toBe(200);
    const body = response.json() as { organizationId: string | null; capabilities: string[] };
    expect(body.organizationId).toBeNull();
    expect(body.capabilities).toEqual([]);
  });

  it('2. creates an organization and becomes its owner', async () => {
    const response = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/organizations',
      headers: authed(analyst.cookie),
      payload: { name: 'Slice Test Partners' },
    });
    expect(response.statusCode).toBe(201);
    organizationId = (response.json() as { organization: { id: string } }).organization.id;

    const me = await ctx.app.inject({
      method: 'GET',
      url: '/api/v1/auth/me',
      headers: authed(analyst.cookie),
    });
    const body = me.json() as { organizationId: string; role: string; capabilities: string[] };
    expect(body.organizationId).toBe(organizationId);
    expect(body.role).toBe('organization_owner');
    expect(body.capabilities).toContain('model:calculate');
  });

  it('3. creates a property with a space', async () => {
    const created = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/properties',
      headers: authed(analyst.cookie),
      payload: {
        name: 'Slice Test Building',
        propertyType: 'office',
        city: 'Testville',
        rentableArea: '50000',
      },
    });
    expect(created.statusCode).toBe(201);
    propertyId = (created.json() as { property: { id: string } }).property.id;

    const spaces = await ctx.app.inject({
      method: 'PUT',
      url: `/api/v1/properties/${propertyId}/spaces`,
      headers: authed(analyst.cookie),
      payload: { spaces: [{ code: 'WHOLE', area: '50000', spaceType: 'office' }] },
    });
    expect(spaces.statusCode).toBe(200);
  });

  it('4. creates a model with valuation assumptions', async () => {
    const response = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/models',
      headers: authed(analyst.cookie),
      payload: {
        propertyId,
        name: 'Slice base case',
        classification: 'acquisition',
        valuationDate: '2026-01-01',
        forecastStartDate: '2026-01-01',
        forecastMonths: 48,
        discountRate: '0.08',
        terminalCapRate: '0.07',
        terminalNoiBasis: 'trailing_12',
        saleMonth: 48,
        saleCostPercent: '0',
        acquisitionPrice: '10000000',
      },
    });
    expect(response.statusCode).toBe(201);
    modelId = (response.json() as { model: { id: string } }).model.id;
  });

  it('5. adds a tenant and a lease with a rent step', async () => {
    const tenant = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/tenants',
      headers: authed(analyst.cookie),
      payload: { propertyId, name: 'Slice Tenant Co' },
    });
    expect(tenant.statusCode).toBe(201);
    tenantId = (tenant.json() as { tenant: { id: string } }).tenant.id;

    const lease = await ctx.app.inject({
      method: 'PUT',
      url: `/api/v1/models/${modelId}/leases/L-1`,
      headers: authed(analyst.cookie),
      payload: {
        tenantId,
        status: 'occupied',
        area: '50000',
        spaceIds: ['WHOLE'],
        commencementDate: '2026-01-01',
        expirationDate: '2035-12-31',
        baseRent: '20.00',
        baseRentBasis: 'per_area_per_year',
        // A step from year three states the rate outright.
        rentSteps: [{ startDate: '2028-01-01', amount: '24.00', basis: 'per_area_per_year' }],
        escalation: { type: 'none' },
        recovery: { method: 'none' },
        excludeFromRollover: true,
      },
    });
    expect(lease.statusCode).toBe(200);
  });

  it('6. rejects a lease that expires before it commences', async () => {
    const response = await ctx.app.inject({
      method: 'PUT',
      url: `/api/v1/models/${modelId}/leases/L-BAD`,
      headers: authed(analyst.cookie),
      payload: {
        tenantId,
        status: 'occupied',
        area: '1000',
        commencementDate: '2027-01-01',
        expirationDate: '2026-01-01',
        baseRent: '20.00',
        baseRentBasis: 'per_area_per_year',
      },
    });
    expect(response.statusCode).toBe(400);
    expect((response.json() as { error: { message: string } }).error.message).toMatch(/expire/i);
  });

  it('7. calculates the model and produces the expected revenue and NOI', async () => {
    const response = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/models/${modelId}/calculate`,
      headers: authed(analyst.cookie),
      payload: { withTrace: true },
    });
    expect(response.statusCode).toBe(200);
    const body = response.json() as {
      engineVersion: string;
      diagnostics: Array<{ severity: string }>;
      annual: Array<{ fiscalYear: number; lines: Record<string, string> }>;
    };

    expect(body.engineVersion).toMatch(/^\d+\.\d+\.\d+$/);
    expect(body.diagnostics.filter((entry) => entry.severity === 'error')).toEqual([]);

    // 50,000 sf at $20.00/sf/yr is $1,000,000 in years one and two; the step to
    // $24.00 makes it $1,200,000 from 2028. There are no expenses, so NOI equals
    // scheduled base rent.
    const year = (fiscalYear: number) =>
      body.annual.find((row) => row.fiscalYear === fiscalYear) as { lines: Record<string, string> };
    expect(year(2026).lines.scheduledBaseRent).toBe('1000000.00');
    expect(year(2027).lines.scheduledBaseRent).toBe('1000000.00');
    expect(year(2028).lines.scheduledBaseRent).toBe('1200000.00');
    expect(year(2029).lines.scheduledBaseRent).toBe('1200000.00');
    expect(year(2026).lines.netOperatingIncome).toBe('1000000.00');
    expect(year(2029).lines.netOperatingIncome).toBe('1200000.00');
  });

  it('8. reopens the saved model and returns the stored cash flow without recalculating', async () => {
    const response = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/models/${modelId}/cashflow`,
      headers: authed(analyst.cookie),
    });
    expect(response.statusCode).toBe(200);
    const body = response.json() as {
      periods: unknown[];
      monthly: Record<string, string[]>;
      valuations: Array<{ method: string; value: string; detail: Record<string, string> }>;
      returns: { unleveredIrr: string | null; goingInCapRate: string | null };
    };

    expect(body.periods).toHaveLength(48);
    // $1,000,000 a year is $83,333.33 a month.
    expect(body.monthly.scheduledBaseRent?.[0]).toBe('83333.33');

    // Terminal value: trailing twelve-month NOI of 1,200,000 at a 7% exit cap
    // is 17,142,857.14, with no costs of sale.
    const dcf = body.valuations.find((valuation) => valuation.method === 'dcf');
    expect(dcf).toBeDefined();
    expect(Number(dcf?.detail.terminalNoi)).toBeCloseTo(1200000, 2);
    expect(Number(dcf?.detail.grossSalePrice)).toBeCloseTo(1200000 / 0.07, 2);

    // Independent closed-form check of the discounted cash flow: four annuities
    // plus a discounted reversion, computed here rather than taken from the API.
    const v = Math.pow(1.08, -1 / 12);
    const annuity = (first: number): number =>
      (Math.pow(v, first) * (1 - Math.pow(v, 12))) / (1 - v);
    const expected =
      (1000000 / 12) * annuity(1) +
      (1000000 / 12) * annuity(13) +
      (1200000 / 12) * annuity(25) +
      (1200000 / 12) * annuity(37) +
      (1200000 / 0.07) * Math.pow(v, 48);
    expect(Number(dcf?.value)).toBeCloseTo(expected, 1);

    // Going-in cap rate on the stated $10,000,000 purchase price.
    expect(Number(body.returns.goingInCapRate)).toBeCloseTo(0.1, 8);
  });

  it('9. explains the calculated rent through the trace', async () => {
    const response = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/models/${modelId}/trace?periodIndex=1&target=occurrence:`,
      headers: authed(analyst.cookie),
    });
    expect(response.statusCode).toBe(200);
    const body = response.json() as {
      entries: Array<{
        formula: string;
        sources: string[];
        inputs: Record<string, string>;
        result: string;
      }>;
    };
    const rent = body.entries.find((entry) => entry.formula === 'lease.baseRent');
    expect(rent).toBeDefined();
    expect(rent?.sources).toContain('lease:L-1');
    expect(Number(rent?.result)).toBeCloseTo(83333.333333, 4);
    expect(rent?.inputs.area).toBe('50000');
  });

  it('10. explains the terminal value and the present value through the trace', async () => {
    const response = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/models/${modelId}/trace?target=valuation:`,
      headers: authed(analyst.cookie),
    });
    expect(response.statusCode).toBe(200);
    const entries = (
      response.json() as { entries: Array<{ formula: string; inputs: Record<string, string> }> }
    ).entries;

    const terminal = entries.find((entry) => entry.formula === 'valuation.terminalValue');
    expect(terminal).toBeDefined();
    expect(terminal?.inputs.exitCapRate).toBe('0.07');
    expect(Number(terminal?.inputs.terminalNoi)).toBeCloseTo(1200000, 2);

    const dcf = entries.find((entry) => entry.formula === 'valuation.dcf');
    expect(dcf).toBeDefined();
    expect(dcf?.inputs.discountRate).toBe('0.08');
    expect(dcf?.inputs.convention).toBe('end_of_period');
  });

  it('11. snapshots an immutable version that reproduces the same result', async () => {
    const created = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/models/${modelId}/versions`,
      headers: authed(analyst.cookie),
      payload: { label: 'Slice v1' },
    });
    expect(created.statusCode).toBe(201);
    const versionId = (created.json() as { version: { id: string } }).version.id;

    const recalculated = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/models/${modelId}/versions/${versionId}/recalculate`,
      headers: authed(analyst.cookie),
    });
    expect(recalculated.statusCode).toBe(200);
    const body = recalculated.json() as {
      annual: Array<{ fiscalYear: number; lines: Record<string, string> }>;
    };
    expect(body.annual.find((row) => row.fiscalYear === 2028)?.lines.scheduledBaseRent).toBe(
      '1200000.00',
    );
  });

  it('12. freezes an approved model against further edits', async () => {
    for (const to of ['analyst_review', 'manager_review', 'approved']) {
      const response = await ctx.app.inject({
        method: 'POST',
        url: `/api/v1/models/${modelId}/transition`,
        headers: authed(analyst.cookie),
        payload: { to },
      });
      expect(response.statusCode).toBe(200);
    }

    const edit = await ctx.app.inject({
      method: 'PUT',
      url: `/api/v1/models/${modelId}/leases/L-1`,
      headers: authed(analyst.cookie),
      payload: {
        tenantId,
        status: 'occupied',
        area: '50000',
        commencementDate: '2026-01-01',
        expirationDate: '2035-12-31',
        baseRent: '99.00',
        baseRentBasis: 'per_area_per_year',
      },
    });
    expect(edit.statusCode).toBe(400);
    expect((edit.json() as { error: { message: string } }).error.message).toMatch(/approved/i);
  });

  it('13. records the whole slice in the audit log', async () => {
    const response = await ctx.app.inject({
      method: 'GET',
      url: '/api/v1/audit',
      headers: authed(analyst.cookie),
    });
    expect(response.statusCode).toBe(200);
    const actions = (response.json() as { entries: Array<{ action: string }> }).entries.map(
      (entry) => entry.action,
    );
    expect(actions).toContain('property.created');
    expect(actions).toContain('model.created');
    expect(actions).toContain('lease.saved');
    expect(actions).toContain('model.calculated');
    expect(actions).toContain('model.approved');
  });
});

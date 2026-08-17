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
 * Reports above the level of a single asset.
 *
 * The investor statement is the one that leaves the building, so the tests are
 * about what it says as much as what it computes: a statement that omits its
 * own limits invites the reader to assume it has none, and a portfolio
 * capitalisation rate that looks like an average of property rates will be
 * misread unless the report says otherwise.
 */
describe.skipIf(!hasDatabase)('portfolio and fund reports', () => {
  let ctx: TestContext;
  let owner: Actor;
  let portfolioId: string;
  let fundId: string;

  beforeAll(async () => {
    ctx = await createTestContext();
    owner = await registerActor(ctx.app, 'preports@example.invalid', 'Report Owner');

    await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/organizations',
      headers: authed(owner.cookie),
      payload: { name: 'Report Partners' },
    });

    const property = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/properties',
      headers: authed(owner.cookie),
      payload: {
        name: 'Report House',
        propertyType: 'office',
        market: 'Central',
        rentableArea: '50000',
      },
    });
    const propertyId = (property.json() as { property: { id: string } }).property.id;

    await ctx.app.inject({
      method: 'PUT',
      url: `/api/v1/properties/${propertyId}/spaces`,
      headers: authed(owner.cookie),
      payload: { spaces: [{ code: 'WHOLE', area: '50000', spaceType: 'office' }] },
    });

    const model = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/models',
      headers: authed(owner.cookie),
      payload: {
        propertyId,
        name: 'Valuation',
        classification: 'valuation',
        valuationDate: '2026-01-01',
        forecastStartDate: '2026-01-01',
        forecastMonths: 60,
        discountRate: '0.08',
        terminalCapRate: '0.07',
        saleMonth: 60,
      },
    });
    const modelId = (model.json() as { model: { id: string } }).model.id;

    const tenant = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/tenants',
      headers: authed(owner.cookie),
      payload: { propertyId, name: 'Reporting Tenant' },
    });
    const tenantId = (tenant.json() as { tenant: { id: string } }).tenant.id;

    await ctx.app.inject({
      method: 'PUT',
      url: `/api/v1/models/${modelId}/leases/L-1`,
      headers: authed(owner.cookie),
      payload: {
        tenantId,
        status: 'occupied',
        area: '50000',
        spaceIds: ['WHOLE'],
        commencementDate: '2026-01-01',
        expirationDate: '2029-12-31',
        baseRent: '20.00',
        baseRentBasis: 'per_area_per_year',
        excludeFromRollover: true,
      },
    });
    await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/models/${modelId}/calculate`,
      headers: authed(owner.cookie),
      payload: {},
    });

    const portfolio = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/portfolios',
      headers: authed(owner.cookie),
      payload: { name: 'Reported Portfolio', propertyIds: [propertyId] },
    });
    portfolioId = (portfolio.json() as { portfolio: { id: string } }).portfolio.id;

    const fund = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/funds',
      headers: authed(owner.cookie),
      payload: { name: 'Reported Fund', vintageYear: 2026, portfolioId },
    });
    fundId = (fund.json() as { fund: { id: string } }).fund.id;

    await ctx.app.inject({
      method: 'PUT',
      url: `/api/v1/funds/${fundId}/investors/LP-1`,
      headers: authed(owner.cookie),
      payload: { name: 'Alder Pension', commitment: '8000000' },
    });
    await ctx.app.inject({
      method: 'PUT',
      url: `/api/v1/funds/${fundId}/investors/LP-2`,
      headers: authed(owner.cookie),
      payload: { name: 'Brine Family Office', commitment: '2000000' },
    });
    for (const [code, amount] of [
      ['LP-1', '4000000'],
      ['LP-2', '1000000'],
    ] as const) {
      await ctx.app.inject({
        method: 'POST',
        url: `/api/v1/funds/${fundId}/transactions`,
        headers: authed(owner.cookie),
        payload: { investorCode: code, date: '2026-01-01', type: 'contribution', amount },
      });
    }
  }, 90_000);

  afterAll(async () => {
    await ctx?.close();
  });

  interface Report {
    report: {
      title: string;
      columns: Array<{ key: string; label: string }>;
      rows: Array<Record<string, string | number | null>>;
      totals?: Record<string, string | number | null>;
      footnotes: string[];
    };
  }

  async function fetchReport(url: string): Promise<Report> {
    const response = await ctx.app.inject({ method: 'GET', url, headers: authed(owner.cookie) });
    expect(response.statusCode, url).toBe(200);
    return response.json() as Report;
  }

  describe('portfolio', () => {
    it('lists what it can produce', async () => {
      const response = await ctx.app.inject({
        method: 'GET',
        url: '/api/v1/portfolios/reports',
        headers: authed(owner.cookie),
      });
      expect(response.statusCode).toBe(200);
      const ids = (response.json() as { reports: Array<{ id: string }> }).reports.map((r) => r.id);
      expect(ids).toContain('portfolio-summary');
      expect(ids).toContain('portfolio-concentration');
    });

    it('states the basis of every rate on the summary', async () => {
      // A portfolio capitalisation rate that looks like an average of property
      // rates — and is not — is a figure a reader will misread unless told.
      const { report } = await fetchReport(
        `/api/v1/portfolios/${portfolioId}/reports/portfolio-summary`,
      );
      const capRate = report.rows.find((row) => String(row.measure).includes('Going-in'));
      expect(String(capRate?.basis)).toContain('not an average');

      const irr = report.rows.find((row) => row.measure === 'Levered IRR');
      expect(String(irr?.basis)).toContain('combined portfolio cash flows');
    });

    it('reports concentration on the denominator each dimension actually has', async () => {
      const { report } = await fetchReport(
        `/api/v1/portfolios/${portfolioId}/reports/portfolio-concentration`,
      );
      expect(report.rows.some((row) => row.dimension === 'Property type')).toBe(true);
      // A tenant does not own a share of the buildings, so its share is of rent.
      expect(report.footnotes.join(' ')).toContain('tenant shares are of annual rent');
    });

    it('refuses a report that does not exist rather than returning an empty one', async () => {
      const response = await ctx.app.inject({
        method: 'GET',
        url: `/api/v1/portfolios/${portfolioId}/reports/not-a-report`,
        headers: authed(owner.cookie),
      });
      expect(response.statusCode).toBe(404);
    });
  });

  describe('the investor statement', () => {
    it('carries every investor and totals to the fund', async () => {
      const { report } = await fetchReport(
        `/api/v1/funds/${fundId}/reports/fund-investor-statement?valuationDate=2029-01-01`,
      );
      expect(report.rows).toHaveLength(2);
      expect(report.totals?.commitment).toBe('10000000');
      expect(report.totals?.contributed).toBe('5000000');
      // Half of every commitment is called, so half remains unfunded.
      expect(report.totals?.unfunded).toBe('5000000');
    });

    it('states where the unrealised value came from', async () => {
      // The one number on a fund report nobody can check without being told.
      const { report } = await fetchReport(
        `/api/v1/funds/${fundId}/reports/fund-investor-statement?valuationDate=2029-01-01`,
      );
      expect(report.footnotes.join(' ')).toContain('roll-up');
      expect(report.title).toContain('2029-01-01');
    });

    it('says what a partnership agreement may provide for that it does not model', async () => {
      // A statement that omits its own limits invites the reader to assume it
      // has none. This one leaves the building, so it says so on its face.
      const { report } = await fetchReport(
        `/api/v1/funds/${fundId}/reports/fund-investor-statement`,
      );
      const notes = report.footnotes.join(' ');
      expect(notes).toContain('does not restore or expand unfunded commitment');
      expect(notes).toContain('carried interest');
      expect(notes).toContain('will differ from one prepared under it');
    });

    it('explains how each multiple is built rather than only naming it', async () => {
      const { report } = await fetchReport(
        `/api/v1/funds/${fundId}/reports/fund-investor-statement`,
      );
      const notes = report.footnotes.join(' ');
      expect(notes).toContain('DPI is distributions over capital called');
      expect(notes).toContain('not the average of its investors');
      expect(notes).toContain('not annualised from a multiple');
    });

    it('carries recallable outstanding, netted from what has been recalled', async () => {
      const { report } = await fetchReport(
        `/api/v1/funds/${fundId}/reports/fund-investor-statement?valuationDate=2029-01-01`,
      );
      expect(report.columns.some((column) => column.key === 'recallableOutstanding')).toBe(true);
      // Nothing recallable has been recorded in this suite's fixture, so the
      // column is present and zero rather than absent.
      expect(report.totals?.recallableOutstanding).toBe('0');
    });

    it('publishes the exact flows the return was solved from', async () => {
      // A return nobody can check is not an answer.
      const { report } = await fetchReport(`/api/v1/funds/${fundId}/reports/fund-capital-account`);
      expect(report.rows.length).toBeGreaterThanOrEqual(2);
      expect(report.rows.every((row) => typeof row.date === 'string')).toBe(true);
      // Capital called is negative to the investor.
      expect(report.rows.some((row) => String(row.amount).startsWith('-'))).toBe(true);
    });

    it('keeps one organization out of another’s reports', async () => {
      const stranger = await registerActor(ctx.app, 'preports-out@example.invalid', 'Outsider');
      await ctx.app.inject({
        method: 'POST',
        url: '/api/v1/organizations',
        headers: authed(stranger.cookie),
        payload: { name: 'Unrelated Reports Co' },
      });
      const response = await ctx.app.inject({
        method: 'GET',
        url: `/api/v1/funds/${fundId}/reports/fund-investor-statement`,
        headers: authed(stranger.cookie),
      });
      expect(response.statusCode).toBe(404);
    });
  });
});

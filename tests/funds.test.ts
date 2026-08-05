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
 * Funds: commitments, capital calls, distributions and the position they add up
 * to.
 *
 * The engine's own tests prove the arithmetic against hand-derived figures.
 * These prove the parts only the API can get wrong: that a transaction cannot
 * be recorded against an investor who is not in the fund, that a signed amount
 * cannot masquerade as the opposite transaction type, that residual value comes
 * from the attached portfolio rather than being assumed, and that a fund with
 * nothing attached says so instead of reporting a confident zero.
 */
describe.skipIf(!hasDatabase)('funds', () => {
  let ctx: TestContext;
  let owner: Actor;
  let fundId: string;

  beforeAll(async () => {
    ctx = await createTestContext();
    owner = await registerActor(ctx.app, 'funds@example.invalid', 'Fund Owner');

    await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/organizations',
      headers: authed(owner.cookie),
      payload: { name: 'Fund Partners' },
    });

    const fund = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/funds',
      headers: authed(owner.cookie),
      payload: { name: 'Meridian Value Fund II', vintageYear: 2026, currency: 'USD' },
    });
    expect(fund.statusCode).toBe(201);
    fundId = (fund.json() as { fund: { id: string } }).fund.id;

    // Alder commits 8,000,000, Brine 2,000,000. Both are called half their
    // commitment across two drawdowns and distributed pro rata.
    for (const [code, name, commitment] of [
      ['ALDER', 'Alder Pension', '8000000'],
      ['BRINE', 'Brine Family Office', '2000000'],
    ] as const) {
      const response = await ctx.app.inject({
        method: 'PUT',
        url: `/api/v1/funds/${fundId}/investors/${code}`,
        headers: authed(owner.cookie),
        payload: { name, commitment, investorClass: 'lp' },
      });
      expect(response.statusCode).toBe(200);
    }

    for (const [code, date, type, amount] of [
      ['ALDER', '2026-01-01', 'contribution', '2000000'],
      ['BRINE', '2026-01-01', 'contribution', '500000'],
      ['ALDER', '2027-01-01', 'contribution', '2000000'],
      ['BRINE', '2027-01-01', 'contribution', '500000'],
      ['ALDER', '2028-01-01', 'distribution', '1600000'],
      ['BRINE', '2028-01-01', 'distribution', '400000'],
    ] as const) {
      const response = await ctx.app.inject({
        method: 'POST',
        url: `/api/v1/funds/${fundId}/transactions`,
        headers: authed(owner.cookie),
        payload: { investorCode: code, date, type, amount },
      });
      expect(response.statusCode).toBe(201);
    }
  }, 60_000);

  afterAll(async () => {
    await ctx?.close();
  });

  async function summary(valuationDate = '2029-01-01'): Promise<{
    residualBasis: string;
    summary: {
      totalCommitment: string;
      totalContributed: string;
      totalUnfunded: string;
      totalDistributed: string;
      netAssetValue: string;
      dpi: string | null;
      tvpi: string | null;
      netIrr: string | null;
      positions: Array<Record<string, unknown>>;
    };
  }> {
    const response = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/funds/${fundId}/summary?valuationDate=${valuationDate}`,
      headers: authed(owner.cookie),
    });
    expect(response.statusCode).toBe(200);
    return response.json() as never;
  }

  it('reports commitments, calls and unfunded capital', async () => {
    const body = await summary();
    // Amounts are unpadded decimal strings; padding happens at the display
    // edge, not in the engine.
    expect(body.summary.totalCommitment).toBe('10000000');
    expect(body.summary.totalContributed).toBe('5000000');
    expect(body.summary.totalUnfunded).toBe('5000000');
    expect(body.summary.totalDistributed).toBe('2000000');
  });

  it('names each investor by the code the fund keeps its records under', async () => {
    const body = await summary();
    const codes = body.summary.positions.map((position) => position.investorCode).sort();
    expect(codes).toEqual(['ALDER', 'BRINE']);
  });

  it('refuses a transaction against an investor the fund does not have', async () => {
    // Silently creating the investor, or dropping the transaction, would both
    // leave the fund's records disagreeing with what someone believes they
    // entered.
    const response = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/funds/${fundId}/transactions`,
      headers: authed(owner.cookie),
      payload: {
        investorCode: 'NOBODY',
        date: '2027-01-01',
        type: 'contribution',
        amount: '1000',
      },
    });
    expect(response.statusCode).toBe(400);
    expect(response.body).toContain('NOBODY');
  });

  it('refuses a negative amount rather than reinterpreting its direction', async () => {
    // A contribution of -1,000 would otherwise read as a distribution of 1,000
    // to everything downstream, and nothing could tell the two apart.
    const response = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/funds/${fundId}/transactions`,
      headers: authed(owner.cookie),
      payload: {
        investorCode: 'ALDER',
        date: '2027-01-01',
        type: 'contribution',
        amount: '-1000',
      },
    });
    expect(response.statusCode).toBe(400);
  });

  it('says why there is no residual value rather than reporting a confident zero', async () => {
    const body = await summary();
    expect(body.summary.netAssetValue).toBe('0');
    expect(body.residualBasis).toContain('No portfolio');
    // DPI is real — money has come back. TVPI equals it, because there is no
    // unrealised value to add, and the response says so.
    expect(Number(body.summary.dpi)).toBeCloseTo(0.4, 10);
    expect(Number(body.summary.tvpi)).toBeCloseTo(0.4, 10);
  });

  it('leaves the rate alone when there is no residual value to date', async () => {
    // The valuation date matters only because residual value is treated as
    // received on it. This fund has none, so moving the date changes nothing —
    // which is the correct answer, not a sign the parameter is ignored. The
    // date's effect on a fund that does hold value is covered in the engine's
    // own tests.
    const early = await summary('2028-06-30');
    const late = await summary('2032-01-01');
    expect(early.summary.netIrr).toBe(late.summary.netIrr);
    expect(early.summary.netAssetValue).toBe('0');
  });

  it('refuses a commitment change whose version has been overtaken', async () => {
    // A commitment is a legal figure. Two people editing it at once must not
    // silently overwrite one another, as everywhere else in the platform.
    const list = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/funds/${fundId}/investors`,
      headers: authed(owner.cookie),
    });
    const investors = (list.json() as { investors: Array<{ code: string; version: number }> })
      .investors;
    const opened = investors.find((entry) => entry.code === 'ALDER')?.version as number;

    const theirs = await ctx.app.inject({
      method: 'PUT',
      url: `/api/v1/funds/${fundId}/investors/ALDER`,
      headers: authed(owner.cookie),
      payload: { name: 'Alder Pension', commitment: '9000000', expectedVersion: opened },
    });
    expect(theirs.statusCode).toBe(200);

    const mine = await ctx.app.inject({
      method: 'PUT',
      url: `/api/v1/funds/${fundId}/investors/ALDER`,
      headers: authed(owner.cookie),
      payload: { name: 'Alder Pension', commitment: '7000000', expectedVersion: opened },
    });
    expect(mine.statusCode).toBe(409);
    expect((JSON.parse(mine.body) as { error: { code: string } }).error.code).toBe(
      'INVESTOR_VERSION_CONFLICT',
    );

    // Their figure survives.
    const after = await summary();
    expect(after.summary.totalCommitment).toBe('11000000');
  });

  it('keeps one organization’s funds out of another’s', async () => {
    const stranger = await registerActor(ctx.app, 'stranger@example.invalid', 'Stranger');
    await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/organizations',
      headers: authed(stranger.cookie),
      payload: { name: 'Unrelated Capital' },
    });

    const response = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/funds/${fundId}/summary`,
      headers: authed(stranger.cookie),
    });
    expect(response.statusCode).toBe(404);

    const list = await ctx.app.inject({
      method: 'GET',
      url: '/api/v1/funds',
      headers: authed(stranger.cookie),
    });
    expect((list.json() as { funds: unknown[] }).funds).toEqual([]);
  });
});

/**
 * Residual value, from the portfolio the fund actually holds.
 *
 * This is the wiring worth testing: the fund reports unrealised value from the
 * same roll-up the portfolio screen shows, rather than a second aggregation of
 * its own that would drift from it. A fund and a portfolio disagreeing about
 * what the same assets are worth is the kind of defect nobody notices until an
 * investor asks.
 */
describe.skipIf(!hasDatabase)('a fund holding a portfolio', () => {
  let ctx: TestContext;
  let owner: Actor;
  let fundId: string;
  let portfolioNav: number;

  beforeAll(async () => {
    ctx = await createTestContext();
    owner = await registerActor(ctx.app, 'held@example.invalid', 'Holder');

    await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/organizations',
      headers: authed(owner.cookie),
      payload: { name: 'Holding Partners' },
    });

    const property = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/properties',
      headers: authed(owner.cookie),
      payload: { name: 'Held Asset', propertyType: 'office', rentableArea: '50000' },
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
      payload: { propertyId, name: 'Held Tenant' },
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
        expirationDate: '2035-12-31',
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
      payload: { name: 'Held Portfolio', propertyIds: [propertyId] },
    });
    const portfolioId = (portfolio.json() as { portfolio: { id: string } }).portfolio.id;

    const aggregate = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/portfolios/${portfolioId}/aggregate`,
      headers: authed(owner.cookie),
    });
    portfolioNav = Number(
      (aggregate.json() as { aggregate: { netAssetValue: string } }).aggregate.netAssetValue,
    );

    const fund = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/funds',
      headers: authed(owner.cookie),
      payload: { name: 'Held Fund', vintageYear: 2026, portfolioId },
    });
    fundId = (fund.json() as { fund: { id: string } }).fund.id;

    await ctx.app.inject({
      method: 'PUT',
      url: `/api/v1/funds/${fundId}/investors/SOLE`,
      headers: authed(owner.cookie),
      payload: { name: 'Sole investor', commitment: '5000000' },
    });
    await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/funds/${fundId}/transactions`,
      headers: authed(owner.cookie),
      payload: {
        investorCode: 'SOLE',
        date: '2026-01-01',
        type: 'contribution',
        amount: '5000000',
      },
    });
  }, 90_000);

  afterAll(async () => {
    await ctx?.close();
  });

  it('takes residual value from the portfolio roll-up, to the cent', async () => {
    const response = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/funds/${fundId}/summary?valuationDate=2031-01-01`,
      headers: authed(owner.cookie),
    });
    expect(response.statusCode).toBe(200);
    const body = response.json() as {
      residualBasis: string;
      summary: { netAssetValue: string; rvpi: string | null; tvpi: string | null };
    };

    expect(portfolioNav).toBeGreaterThan(0);
    expect(Number(body.summary.netAssetValue)).toBeCloseTo(portfolioNav, 2);
    expect(body.residualBasis).toContain('1 property');

    // Nothing distributed, so the whole multiple is unrealised: TVPI equals
    // RVPI, and both are the roll-up value over the 5,000,000 called.
    expect(Number(body.summary.rvpi)).toBeCloseTo(portfolioNav / 5000000, 8);
    expect(body.summary.tvpi).toBe(body.summary.rvpi);
  });

  it('gives the sole investor the whole of it', async () => {
    const response = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/funds/${fundId}/summary?valuationDate=2031-01-01`,
      headers: authed(owner.cookie),
    });
    const body = response.json() as {
      summary: { netAssetValue: string; positions: Array<{ netAssetValue: string }> };
    };
    expect(body.summary.positions).toHaveLength(1);
    expect(body.summary.positions[0]?.netAssetValue).toBe(body.summary.netAssetValue);
  });
});

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
 * Fund-level waterfall: tier configuration, distribution preview and apply.
 *
 * The engine's own tests (`fund-waterfall.test.ts` in calculation-engine) prove
 * the arithmetic against hand-derived figures. These prove the parts only the
 * API can get wrong: that tiers referencing an unknown investor are rejected
 * before they can be saved, that concurrent edits to the tier list conflict
 * the way every other versioned record in this platform does, that a preview
 * changes nothing, and that applying one records exactly the amounts the
 * preview showed — no more, no less — in a single atomic write.
 */
describe.skipIf(!hasDatabase)('fund waterfall', () => {
  let ctx: TestContext;
  let owner: Actor;
  let fundId: string;
  let lpId: string;
  let gpId: string;

  beforeAll(async () => {
    ctx = await createTestContext();
    owner = await registerActor(ctx.app, 'waterfall@example.invalid', 'Waterfall Owner');

    await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/organizations',
      headers: authed(owner.cookie),
      payload: { name: 'Waterfall Partners' },
    });

    const fund = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/funds',
      headers: authed(owner.cookie),
      payload: { name: 'Waterfall Fund I', vintageYear: 2025, currency: 'USD' },
    });
    expect(fund.statusCode).toBe(201);
    fundId = (fund.json() as { fund: { id: string } }).fund.id;

    for (const [code, name, investorClass, commitment] of [
      ['LP', 'Limited Partner', 'lp', '1000000'],
      ['GP', 'General Partner', 'gp', '0'],
    ] as const) {
      const response = await ctx.app.inject({
        method: 'PUT',
        url: `/api/v1/funds/${fundId}/investors/${code}`,
        headers: authed(owner.cookie),
        payload: { name, commitment, investorClass },
      });
      expect(response.statusCode).toBe(200);
    }

    const investors = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/funds/${fundId}/investors`,
      headers: authed(owner.cookie),
    });
    const rows = (investors.json() as { investors: Array<{ id: string; code: string }> }).investors;
    lpId = rows.find((row) => row.code === 'LP')?.id as string;
    gpId = rows.find((row) => row.code === 'GP')?.id as string;

    // 1,000,000 contributed on 2025-01-01. A distribution proposed exactly
    // 365 days later (2026-01-01, no leap day crossed) at an 8% compounding
    // preferred return accrues to exactly 80,000 -- (1.08^1 - 1) x 1,000,000
    // -- so every figure below is hand-checkable without touching the engine.
    const contribution = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/funds/${fundId}/transactions`,
      headers: authed(owner.cookie),
      payload: { investorCode: 'LP', date: '2025-01-01', type: 'contribution', amount: '1000000' },
    });
    expect(contribution.statusCode).toBe(201);
  }, 60_000);

  afterAll(async () => {
    await ctx?.close();
  });

  function tiers(): Array<Record<string, unknown>> {
    return [
      {
        id: 'roc',
        name: 'Return of capital',
        type: 'return_of_capital',
        compounding: true,
        splits: [],
      },
      {
        id: 'pref',
        name: '8% preferred return',
        type: 'preferred_return',
        hurdleRate: '0.08',
        compounding: true,
        splits: [],
      },
      {
        id: 'residual',
        name: 'Residual split',
        type: 'residual_split',
        compounding: true,
        splits: [
          { partnerId: lpId, share: '0.8' },
          { partnerId: gpId, share: '0.2' },
        ],
      },
    ];
  }

  it('refuses to save a tier whose split names an investor the fund does not have', async () => {
    const response = await ctx.app.inject({
      method: 'PUT',
      url: `/api/v1/funds/${fundId}/waterfall-tiers`,
      headers: authed(owner.cookie),
      payload: {
        tiers: [
          {
            id: 'residual',
            name: 'Residual split',
            type: 'residual_split',
            splits: [{ partnerId: '00000000-0000-0000-0000-000000000000', share: '1' }],
          },
        ],
      },
    });
    expect(response.statusCode).toBe(400);
    expect(response.body).toContain('00000000-0000-0000-0000-000000000000');
  });

  it('refuses a proposal before any tiers are configured', async () => {
    const response = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/funds/${fundId}/waterfall/preview`,
      headers: authed(owner.cookie),
      payload: { distributionDate: '2026-01-01', distributableAmount: '1080000' },
    });
    expect(response.statusCode).toBe(400);
    expect(response.body).toContain('no waterfall tiers');
  });

  it('saves and returns tiers, versioned like every other fund record', async () => {
    const saved = await ctx.app.inject({
      method: 'PUT',
      url: `/api/v1/funds/${fundId}/waterfall-tiers`,
      headers: authed(owner.cookie),
      payload: { tiers: tiers() },
    });
    expect(saved.statusCode).toBe(200);
    const body = saved.json() as { tiers: unknown[]; version: number };
    expect(body.tiers).toHaveLength(3);
    expect(body.version).toBeGreaterThan(0);

    const fetched = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/funds/${fundId}/waterfall-tiers`,
      headers: authed(owner.cookie),
    });
    expect(fetched.statusCode).toBe(200);
    expect((fetched.json() as { tiers: unknown[] }).tiers).toHaveLength(3);
  });

  it('conflicts a tier save whose expected version has been overtaken', async () => {
    const opened = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/funds/${fundId}/waterfall-tiers`,
      headers: authed(owner.cookie),
    });
    const openedVersion = (opened.json() as { version: number }).version;

    const theirs = await ctx.app.inject({
      method: 'PUT',
      url: `/api/v1/funds/${fundId}/waterfall-tiers`,
      headers: authed(owner.cookie),
      payload: { tiers: tiers(), expectedVersion: openedVersion },
    });
    expect(theirs.statusCode).toBe(200);

    const mine = await ctx.app.inject({
      method: 'PUT',
      url: `/api/v1/funds/${fundId}/waterfall-tiers`,
      headers: authed(owner.cookie),
      payload: { tiers: tiers(), expectedVersion: openedVersion },
    });
    expect(mine.statusCode).toBe(409);
    expect((JSON.parse(mine.body) as { error: { code: string } }).error.code).toBe(
      'FUND_VERSION_CONFLICT',
    );
  });

  it('previews a distribution to the cent and records nothing', async () => {
    const response = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/funds/${fundId}/waterfall/preview`,
      headers: authed(owner.cookie),
      payload: { distributionDate: '2026-01-01', distributableAmount: '1080000' },
    });
    expect(response.statusCode).toBe(200);
    const proposal = (
      response.json() as {
        proposal: { allocations: Array<{ investorId: string; total: string }> };
      }
    ).proposal;

    const lp = proposal.allocations.find((a) => a.investorId === lpId);
    const gp = proposal.allocations.find((a) => a.investorId === gpId);
    // 1,000,000 return of capital + 80,000 preferred to the LP; nothing left
    // over for the residual split, so the GP gets nothing from this round.
    expect(lp?.total).toBe('1080000');
    expect(gp?.total ?? '0').toBe('0');

    const summary = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/funds/${fundId}/summary?valuationDate=2026-01-01`,
      headers: authed(owner.cookie),
    });
    expect(
      (summary.json() as { summary: { totalDistributed: string } }).summary.totalDistributed,
    ).toBe('0');
  });

  it('names exactly what is unallocated when a proposal outruns its tiers', async () => {
    // Return-of-capital and the 8% preferred only account for 1,080,000; with
    // no residual_split tier, anything proposed beyond that has nowhere to
    // go, and the engine throws naming the shortfall instead of guessing.
    // Swapped in just for this assertion, then restored, so the surrounding
    // tests keep seeing the full tier set they were written against.
    const withoutResidual = await ctx.app.inject({
      method: 'PUT',
      url: `/api/v1/funds/${fundId}/waterfall-tiers`,
      headers: authed(owner.cookie),
      payload: { tiers: tiers().filter((tier) => tier.type !== 'residual_split') },
    });
    expect(withoutResidual.statusCode).toBe(200);

    const response = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/funds/${fundId}/waterfall/preview`,
      headers: authed(owner.cookie),
      payload: { distributionDate: '2026-01-01', distributableAmount: '2000000' },
    });
    expect(response.statusCode).toBe(400);
    expect(response.body).toContain('unallocated');

    const restored = await ctx.app.inject({
      method: 'PUT',
      url: `/api/v1/funds/${fundId}/waterfall-tiers`,
      headers: authed(owner.cookie),
      payload: { tiers: tiers() },
    });
    expect(restored.statusCode).toBe(200);
  });

  it('applies a distribution, recording exactly the preview and nothing more', async () => {
    const response = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/funds/${fundId}/waterfall/apply`,
      headers: authed(owner.cookie),
      payload: { distributionDate: '2026-01-01', distributableAmount: '1080000' },
    });
    expect(response.statusCode).toBe(201);
    const body = response.json() as {
      transactions: Array<{ investor_id: string; amount: string; type: string }>;
      proposal: { allocations: Array<{ investorId: string; total: string }> };
    };
    // Only the LP was owed anything this round, so only one row is written --
    // the GP is never given a zero-amount transaction.
    expect(body.transactions).toHaveLength(1);
    expect(body.transactions[0]?.investor_id).toBe(lpId);
    expect(body.transactions[0]?.amount).toBe('1080000.00');
    expect(body.transactions[0]?.type).toBe('distribution');

    const summary = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/funds/${fundId}/summary?valuationDate=2026-01-01`,
      headers: authed(owner.cookie),
    });
    expect(
      (summary.json() as { summary: { totalDistributed: string } }).summary.totalDistributed,
    ).toBe('1080000');
  });

  it('refuses to apply a distribution that would pay nobody', async () => {
    const response = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/funds/${fundId}/waterfall/apply`,
      headers: authed(owner.cookie),
      payload: { distributionDate: '2026-01-02', distributableAmount: '0.00' },
    });
    expect(response.statusCode).toBe(400);
  });

  it('refuses a transaction dated on or after the proposed distribution', async () => {
    // The prior test just recorded a real distribution on 2026-01-01.
    // Proposing another one on that same date would double-count it, since
    // the engine treats every transaction as a settled fact strictly before
    // the date being proposed.
    const response = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/funds/${fundId}/waterfall/preview`,
      headers: authed(owner.cookie),
      payload: { distributionDate: '2026-01-01', distributableAmount: '1000' },
    });
    expect(response.statusCode).toBe(400);
    expect(response.body).toContain('not before the proposed distribution date');
  });

  it('never pays the same distribution twice when two requests race', async () => {
    // A fresh fund, isolated from the shared one above, so this race can't be
    // confused by the distributions the earlier tests already recorded.
    const fund = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/funds',
      headers: authed(owner.cookie),
      payload: { name: 'Race Fund', vintageYear: 2025, currency: 'USD' },
    });
    expect(fund.statusCode).toBe(201);
    const raceFundId = (fund.json() as { fund: { id: string } }).fund.id;

    const investor = await ctx.app.inject({
      method: 'PUT',
      url: `/api/v1/funds/${raceFundId}/investors/LP`,
      headers: authed(owner.cookie),
      payload: { name: 'Racing LP', commitment: '100000', investorClass: 'lp' },
    });
    expect(investor.statusCode).toBe(200);
    const raceLpId = (investor.json() as { investor: { id: string } }).investor.id;

    const savedTiers = await ctx.app.inject({
      method: 'PUT',
      url: `/api/v1/funds/${raceFundId}/waterfall-tiers`,
      headers: authed(owner.cookie),
      payload: {
        tiers: [
          {
            id: 'roc',
            name: 'Return of capital',
            type: 'return_of_capital',
            compounding: true,
            splits: [],
          },
          {
            id: 'residual',
            name: 'Residual split',
            type: 'residual_split',
            compounding: true,
            splits: [{ partnerId: raceLpId, share: '1' }],
          },
        ],
      },
    });
    expect(savedTiers.statusCode).toBe(200);

    const contribution = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/funds/${raceFundId}/transactions`,
      headers: authed(owner.cookie),
      payload: { investorCode: 'LP', date: '2025-01-01', type: 'contribution', amount: '100000' },
    });
    expect(contribution.statusCode).toBe(201);

    const payload = { distributionDate: '2026-01-01', distributableAmount: '100000' };
    const [first, second] = await Promise.all([
      ctx.app.inject({
        method: 'POST',
        url: `/api/v1/funds/${raceFundId}/waterfall/apply`,
        headers: authed(owner.cookie),
        payload,
      }),
      ctx.app.inject({
        method: 'POST',
        url: `/api/v1/funds/${raceFundId}/waterfall/apply`,
        headers: authed(owner.cookie),
        payload,
      }),
    ]);

    // Exactly one of the two racing requests gets to record the distribution.
    // The other, serialized behind it by the row lock, now sees that same
    // distribution already on the books for this date and is refused by the
    // engine's own double-counting guard -- never both succeeding and paying
    // the LP twice.
    const statuses = [first.statusCode, second.statusCode].sort();
    expect(statuses).toEqual([201, 400]);

    const summary = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/funds/${raceFundId}/summary?valuationDate=2026-01-01`,
      headers: authed(owner.cookie),
    });
    expect(
      (summary.json() as { summary: { totalDistributed: string } }).summary.totalDistributed,
    ).toBe('100000');
  });

  it('keeps one organization’s waterfall tiers out of another’s', async () => {
    const stranger = await registerActor(ctx.app, 'stranger-wf@example.invalid', 'Stranger');
    await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/organizations',
      headers: authed(stranger.cookie),
      payload: { name: 'Unrelated Capital' },
    });

    const response = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/funds/${fundId}/waterfall-tiers`,
      headers: authed(stranger.cookie),
    });
    expect(response.statusCode).toBe(404);
  });
});

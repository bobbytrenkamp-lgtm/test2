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
 * Recovery pools and reconciliation, through the whole stack.
 *
 * The engine's own fixtures prove the arithmetic. What they cannot prove is
 * that a pool written through the API survives the `jsonb` column and arrives
 * at the engine intact: the lease's recovery configuration is stored as an
 * opaque blob, so a field the schema accepts and the engine never reads would
 * fail silently — the model would calculate, produce a plausible number, and be
 * wrong in a way nothing reports.
 *
 * The expected figures are derived by hand from the assumptions below, not from
 * running the platform.
 */
describe.skipIf(!hasDatabase)('recovery pools through the API', () => {
  let ctx: TestContext;
  let owner: Actor;
  let modelId: string;

  /*
   * 100,000 sqft building, one tenant on 50,000 — a pro-rata share of exactly
   * one half. Two expenses, neither growing, so every figure is a round number.
   *
   *   Operating costs 400,000 -> tenant share 200,000
   *   Property taxes  300,000 -> tenant share 150,000
   *
   * Pool OPEX: triple net on the operating costs with a 15% administrative fee.
   *   settled = 200,000 x 1.15 = 230,000, estimated the same, no true-up.
   *
   * Pool TAX: triple net on the taxes, no fee, billed at a stated estimate of
   * 2.00/sqft and reconciled at the year end.
   *   settled = 150,000; estimated = 2.00 x 50,000 = 100,000;
   *   true-up = 50,000, billed in the last month of the fiscal year.
   *
   * Annually: 230,000 + 100,000 + 50,000 = 380,000.
   * Monthly:  (230,000 + 100,000) / 12 = 27,500, and 77,500 each December.
   *
   * A single merged pool could not produce this. The 15% fee would apply to the
   * taxes as well — 350,000 x 1.15 = 402,500 — and there would be one
   * reconciliation, not one pool reconciled and one not.
   */

  beforeAll(async () => {
    ctx = await createTestContext();
    owner = await registerActor(ctx.app, 'pools@example.invalid', 'Pool Owner');

    await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/organizations',
      headers: authed(owner.cookie),
      payload: { name: 'Pool Properties' },
    });

    const property = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/properties',
      headers: authed(owner.cookie),
      payload: { name: 'Pool House', propertyType: 'office', rentableArea: '100000' },
    });
    const propertyId = (property.json() as { property: { id: string } }).property.id;

    // The space list — not the property's declared area — is the recovery
    // denominator, so the whole 100,000 has to be on it for the tenant's share
    // to be one half.
    await ctx.app.inject({
      method: 'PUT',
      url: `/api/v1/properties/${propertyId}/spaces`,
      headers: authed(owner.cookie),
      payload: { spaces: [{ code: 'WHOLE', area: '100000', spaceType: 'office' }] },
    });

    const model = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/models',
      headers: authed(owner.cookie),
      payload: {
        propertyId,
        name: 'Pooled recoveries',
        classification: 'valuation',
        valuationDate: '2026-01-01',
        forecastStartDate: '2026-01-01',
        forecastMonths: 24,
        discountRate: '0.08',
        terminalCapRate: '0.07',
        saleMonth: 24,
      },
    });
    modelId = (model.json() as { model: { id: string } }).model.id;

    const tenant = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/tenants',
      headers: authed(owner.cookie),
      payload: { propertyId, name: 'Pooled Tenant' },
    });
    const tenantId = (tenant.json() as { tenant: { id: string } }).tenant.id;

    for (const [code, body] of [
      ['CAM', { name: 'Operating costs', category: 'cam', amount: '400000' }],
      ['TAX', { name: 'Property taxes', category: 'taxes', amount: '300000' }],
    ] as const) {
      await ctx.app.inject({
        method: 'PUT',
        url: `/api/v1/models/${modelId}/expenses/${code}`,
        headers: authed(owner.cookie),
        payload: {
          ...body,
          method: 'fixed_annual',
          recoverableShare: '1',
          variableShare: '0',
        },
      });
    }

    await ctx.app.inject({
      method: 'PUT',
      url: `/api/v1/models/${modelId}/leases/L-POOL`,
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
        recovery: {
          pools: [
            {
              code: 'OPEX',
              name: 'Operating costs',
              method: 'triple_net',
              includedCategories: ['cam'],
              adminFeePercent: '0.15',
            },
            {
              code: 'TAX',
              name: 'Property taxes',
              method: 'triple_net',
              includedCategories: ['taxes'],
              estimateBasis: 'fixed_estimate',
              estimatePerArea: '2.00',
              reconciliationLagMonths: 0,
            },
          ],
        },
      },
    });
  }, 60_000);

  afterAll(async () => {
    await ctx?.close();
  });

  interface CashFlow {
    annual: Array<{ fiscalYear: number; lines: Record<string, string> }>;
    monthly: Record<string, string[]>;
    recoveryDetail: Array<Record<string, unknown>>;
    diagnostics: Array<{ severity: string }>;
  }

  /**
   * Calculates once and reads the stored result back.
   *
   * `POST /calculate` answers with a summary — annual lines, returns,
   * valuations — and the cash-flow route serves the full result, which is where
   * the monthly series and the recovery detail live.
   */
  async function calculate(): Promise<CashFlow> {
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

  it('settles each pool on its own terms after a round trip through the database', async () => {
    const result = await calculate();
    expect(result.diagnostics.filter((entry) => entry.severity === 'error')).toEqual([]);

    for (const fiscalYear of [2026, 2027]) {
      const row = result.annual.find((entry) => entry.fiscalYear === fiscalYear);
      expect(row?.lines.expenseRecoveries, `FY${fiscalYear}`).toBe('380000.00');
    }
  });

  it('applies the administrative fee to one pool and not the other', async () => {
    const result = await calculate();
    const detail = result.recoveryDetail.filter((row) => row.fiscalYear === 2026);
    expect(detail).toHaveLength(2);

    const opex = detail.find((row) => row.poolCode === 'OPEX');
    expect(Number(opex?.adminFee)).toBeCloseTo(30000, 6);
    expect(Number(opex?.finalRecovery)).toBeCloseTo(230000, 6);

    const tax = detail.find((row) => row.poolCode === 'TAX');
    expect(Number(tax?.adminFee)).toBeCloseTo(0, 6);
    expect(Number(tax?.finalRecovery)).toBeCloseTo(150000, 6);
  });

  it('reconciles the pool that is billed on an estimate, and only that one', async () => {
    const result = await calculate();
    const detail = result.recoveryDetail.filter((row) => row.fiscalYear === 2026);

    const opex = detail.find((row) => row.poolCode === 'OPEX');
    expect(Number(opex?.estimatedRecovery)).toBeCloseTo(230000, 6);
    expect(Number(opex?.trueUpAmount)).toBeCloseTo(0, 6);

    const tax = detail.find((row) => row.poolCode === 'TAX');
    expect(Number(tax?.estimatedRecovery)).toBeCloseTo(100000, 6);
    expect(Number(tax?.trueUpAmount)).toBeCloseTo(50000, 6);
    // Zero lag settles in the last month of the fiscal year: index 11.
    expect(tax?.trueUpPeriodIndex).toBe(11);
  });

  it('bills the true-up in one month rather than smoothing it into the year', async () => {
    const result = await calculate();
    const monthly = result.monthly.expenseRecoveries as string[];
    // (230,000 + 100,000) / 12 = 27,500 a month, plus the 50,000 true-up in
    // December. An annual total alone would not distinguish the two.
    expect(Number(monthly[0])).toBeCloseTo(27500, 2);
    expect(Number(monthly[10])).toBeCloseTo(27500, 2);
    expect(Number(monthly[11])).toBeCloseTo(77500, 2);
    expect(Number(monthly[23])).toBeCloseTo(77500, 2);
  });

  it('keeps the pools when the lease is read back', async () => {
    // The configuration is stored as an opaque blob. If it did not survive, the
    // editor would show a lease that recovers nothing and the analyst would have
    // no way to tell it had been dropped rather than never set.
    const response = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/models/${modelId}/leases`,
      headers: authed(owner.cookie),
    });
    const leases = (response.json() as { leases: Array<Record<string, unknown>> }).leases;
    const lease = leases.find((entry) => entry.code === 'L-POOL');
    const recovery = lease?.recovery as { pools: Array<Record<string, unknown>> };
    expect(recovery.pools).toHaveLength(2);
    expect(recovery.pools.map((pool) => pool.code)).toEqual(['OPEX', 'TAX']);
    expect(recovery.pools[1]?.estimateBasis).toBe('fixed_estimate');
  });
});

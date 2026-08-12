import { describe, expect, it } from 'vitest';
import { calculate } from './engine.js';
import { baseModel, extendModel } from './__fixtures__/builders.js';

/**
 * A direct capitalization rate explicitly set to zero.
 *
 * Found by the same audit's second round (extreme-value cases):
 * `computeDirectCapitalization` treated `directCapRate: '0'` identically to
 * `directCapRate` being unset — both produced no valuation, silently. But
 * "not configured" and "configured to a rate with no finite value to divide
 * by" are different situations, and `computeSale` already distinguishes them
 * for the exit cap rate with a `ZERO_EXIT_CAP_RATE` diagnostic. A model with
 * `directCapRate: '0'` — most plausibly a placeholder left over while an
 * analyst is still filling in assumptions — got a silently missing valuation
 * method instead of a diagnostic pointing at the cause.
 */
describe('a direct capitalization rate of zero', () => {
  function flatNoiModel(overrides: Parameters<typeof extendModel>[1] = {}) {
    return extendModel(baseModel(), {
      forecast: {
        startDate: '2026-01-01',
        months: 12,
        fiscalYearStartMonth: 1,
        proration: 'actual_days',
      },
      otherRevenue: [
        {
          id: 'OTHER',
          name: 'Flat other revenue',
          method: 'custom_monthly_schedule',
          monthlySchedule: Array.from({ length: 12 }, () => '10000'),
        },
      ],
      ...overrides,
    });
  }

  it('produces no direct_capitalization valuation', () => {
    const model = flatNoiModel({
      valuation: {
        discountRate: '0.08',
        saleCostPercent: '0',
        directCapAdjustments: '0',
        acquisitionCosts: '0',
        directCapRate: '0',
        directCapNoiBasis: 'year_1',
      },
    });
    const result = calculate(model);
    expect(result.valuations.find((v) => v.method === 'direct_capitalization')).toBeUndefined();
  });

  it('records a ZERO_DIRECT_CAP_RATE error naming the cause', () => {
    const model = flatNoiModel({
      valuation: {
        discountRate: '0.08',
        saleCostPercent: '0',
        directCapAdjustments: '0',
        acquisitionCosts: '0',
        directCapRate: '0',
        directCapNoiBasis: 'year_1',
      },
    });
    const result = calculate(model);
    const diagnostic = result.diagnostics.find((entry) => entry.code === 'ZERO_DIRECT_CAP_RATE');
    expect(diagnostic?.severity).toBe('error');
    expect(diagnostic?.message).toContain('zero');
  });

  it('is unaffected when directCapRate is simply not configured', () => {
    const model = flatNoiModel({
      valuation: {
        discountRate: '0.08',
        saleCostPercent: '0',
        directCapAdjustments: '0',
        acquisitionCosts: '0',
      },
    });
    const result = calculate(model);
    expect(result.valuations.find((v) => v.method === 'direct_capitalization')).toBeUndefined();
    expect(
      result.diagnostics.find((entry) => entry.code === 'ZERO_DIRECT_CAP_RATE'),
    ).toBeUndefined();
  });
});

/**
 * A direct capitalization rate set to a negative value.
 *
 * Found by a third audit pass over extreme-value cases: `computeDirectCapitalization`
 * guarded only `rate.isZero()`. `decimalString` (the schema type backing
 * `directCapRate`) has no range floor, so a fat-fingered "-0.05" instead of
 * "0.05" divided the selected NOI by a negative rate and produced a large,
 * plausible-looking *negative* valuation with no diagnostic pointing at the
 * cause — worse than the zero case, which at least produced nothing.
 */
describe('a direct capitalization rate that is negative', () => {
  function flatNoiModel(overrides: Parameters<typeof extendModel>[1] = {}) {
    return extendModel(baseModel(), {
      forecast: {
        startDate: '2026-01-01',
        months: 12,
        fiscalYearStartMonth: 1,
        proration: 'actual_days',
      },
      otherRevenue: [
        {
          id: 'OTHER',
          name: 'Flat other revenue',
          method: 'custom_monthly_schedule',
          monthlySchedule: Array.from({ length: 12 }, () => '10000'),
        },
      ],
      ...overrides,
    });
  }

  const model = flatNoiModel({
    valuation: {
      discountRate: '0.08',
      saleCostPercent: '0',
      directCapAdjustments: '0',
      acquisitionCosts: '0',
      directCapRate: '-0.05',
      directCapNoiBasis: 'year_1',
    },
  });
  const result = calculate(model);

  it('produces no direct_capitalization valuation, not a negative value', () => {
    // Hand-derived: $10,000 x 12 = $120,000 selected NOI divided by -5% would
    // be -$2,400,000 if computed. The correct behaviour is no valuation at
    // all, the same as the zero-rate case, not a negative number.
    expect(result.valuations.find((v) => v.method === 'direct_capitalization')).toBeUndefined();
  });

  it('records a NEGATIVE_DIRECT_CAP_RATE error naming the cause', () => {
    const diagnostic = result.diagnostics.find(
      (entry) => entry.code === 'NEGATIVE_DIRECT_CAP_RATE',
    );
    expect(diagnostic?.severity).toBe('error');
    expect(diagnostic?.message).toContain('negative');
  });
});

/**
 * An exit capitalization rate set to a negative value.
 *
 * Same audit pass, same class of defect as the direct-cap rate above:
 * `computeSale` guarded only `capRate.isZero()`. A negative `terminalCapRate`
 * divided the terminal NOI by a negative number, producing a large negative
 * gross sale price that flowed straight into the DCF valuation, the levered
 * and unlevered cash flows, and IRR — with no diagnostic anywhere in the
 * chain.
 */
describe('an exit capitalization rate that is negative', () => {
  const model = extendModel(baseModel(), {
    forecast: {
      startDate: '2026-01-01',
      months: 12,
      fiscalYearStartMonth: 1,
      proration: 'actual_days',
    },
    otherRevenue: [
      {
        id: 'OTHER',
        name: 'Flat other revenue',
        method: 'custom_monthly_schedule',
        monthlySchedule: Array.from({ length: 12 }, () => '10000'),
      },
    ],
    valuation: {
      discountRate: '0.08',
      saleCostPercent: '0.02',
      directCapAdjustments: '0',
      acquisitionCosts: '0',
      saleMonth: 12,
      terminalCapRate: '-0.06',
      terminalNoiBasis: 'trailing_12',
    },
  });
  const result = calculate(model);

  it('produces no dcf valuation, not a negative sale price', () => {
    // Hand-derived: $10,000 x 12 = $120,000 trailing NOI divided by -6% would
    // be -$2,000,000 if computed, and would flow straight through to a
    // negative reversion value. No dcf valuation should be produced at all.
    expect(result.valuations.find((v) => v.method === 'dcf')).toBeUndefined();
  });

  it('records a NEGATIVE_EXIT_CAP_RATE error naming the cause', () => {
    const diagnostic = result.diagnostics.find((entry) => entry.code === 'NEGATIVE_EXIT_CAP_RATE');
    expect(diagnostic?.severity).toBe('error');
    expect(diagnostic?.message).toContain('negative');
  });

  it('is unaffected by a positive exit cap rate on the same model', () => {
    const positiveModel = extendModel(baseModel(), {
      forecast: {
        startDate: '2026-01-01',
        months: 12,
        fiscalYearStartMonth: 1,
        proration: 'actual_days',
      },
      otherRevenue: [
        {
          id: 'OTHER',
          name: 'Flat other revenue',
          method: 'custom_monthly_schedule',
          monthlySchedule: Array.from({ length: 12 }, () => '10000'),
        },
      ],
      valuation: {
        discountRate: '0.08',
        saleCostPercent: '0.02',
        directCapAdjustments: '0',
        acquisitionCosts: '0',
        saleMonth: 12,
        terminalCapRate: '0.06',
        terminalNoiBasis: 'trailing_12',
      },
    });
    const positiveResult = calculate(positiveModel);
    expect(positiveResult.valuations.find((v) => v.method === 'dcf')).toBeDefined();
    expect(
      positiveResult.diagnostics.find((entry) => entry.code === 'NEGATIVE_EXIT_CAP_RATE'),
    ).toBeUndefined();
  });
});

/**
 * A discount rate set to a negative value.
 *
 * Found by a fifth audit pass sweeping for the same asymmetric-guard pattern
 * found four times already: `computeSale`/`computeDirectCapitalization`
 * guard a negative *capitalisation* rate (added in round three), but
 * `discountRate` — a rate of the identical schema shape, entered the same
 * way, consumed in the very same module — had no equivalent guard anywhere.
 * `discountFactors` raises `1 + rate` to a *negative* fractional power, so a
 * rate below zero (but above -100%) makes each factor *larger* than the
 * last instead of smaller: present value grows with distance into the
 * future instead of shrinking, silently inflating the reversion (usually
 * the largest single cash flow) rather than discounting it.
 */
describe('a discount rate that is negative', () => {
  const model = extendModel(baseModel(), {
    forecast: {
      startDate: '2026-01-01',
      months: 12,
      fiscalYearStartMonth: 1,
      proration: 'actual_days',
    },
    otherRevenue: [
      {
        id: 'OTHER',
        name: 'Flat other revenue',
        method: 'custom_monthly_schedule',
        monthlySchedule: Array.from({ length: 12 }, () => '10000'),
      },
    ],
    valuation: {
      discountRate: '-0.08',
      saleCostPercent: '0',
      directCapAdjustments: '0',
      acquisitionCosts: '0',
      saleMonth: 12,
      terminalCapRate: '0.06',
      terminalNoiBasis: 'trailing_12',
    },
  });
  const result = calculate(model);

  it('produces no dcf valuation and no net present value, not an inflated one', () => {
    expect(result.valuations.find((v) => v.method === 'dcf')).toBeUndefined();
    expect(result.returns.netPresentValue).toBeNull();
  });

  it('records a NEGATIVE_DISCOUNT_RATE error naming the cause', () => {
    const diagnostic = result.diagnostics.find((entry) => entry.code === 'NEGATIVE_DISCOUNT_RATE');
    expect(diagnostic?.severity).toBe('error');
    expect(diagnostic?.message).toContain('negative');
  });

  it('is unaffected by a positive discount rate on the same model', () => {
    const positiveModel = extendModel(baseModel(), {
      forecast: {
        startDate: '2026-01-01',
        months: 12,
        fiscalYearStartMonth: 1,
        proration: 'actual_days',
      },
      otherRevenue: [
        {
          id: 'OTHER',
          name: 'Flat other revenue',
          method: 'custom_monthly_schedule',
          monthlySchedule: Array.from({ length: 12 }, () => '10000'),
        },
      ],
      valuation: {
        discountRate: '0.08',
        saleCostPercent: '0',
        directCapAdjustments: '0',
        acquisitionCosts: '0',
        saleMonth: 12,
        terminalCapRate: '0.06',
        terminalNoiBasis: 'trailing_12',
      },
    });
    const positiveResult = calculate(positiveModel);
    expect(positiveResult.valuations.find((v) => v.method === 'dcf')).toBeDefined();
    expect(positiveResult.returns.netPresentValue).not.toBeNull();
    expect(
      positiveResult.diagnostics.find((entry) => entry.code === 'NEGATIVE_DISCOUNT_RATE'),
    ).toBeUndefined();
  });
});

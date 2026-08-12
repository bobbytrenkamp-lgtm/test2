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

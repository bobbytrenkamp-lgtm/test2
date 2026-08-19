import { describe, expect, it } from 'vitest';
import { calculate } from './engine.js';
import { baseModel, extendModel } from './__fixtures__/builders.js';

/**
 * The full return metric set, with no debt facility at all.
 *
 * `docs/calculation-specification.md`'s own rule is that a figure the engine
 * cannot compute is `null`, never a silent zero — but "no debt" is not
 * uniformly "cannot compute": a $0 loan against a valued property is a real,
 * accurate 0% loan-to-value, while a debt yield or a DSCR has no loan balance
 * or debt service to relate anything to at all. No fixture had ever set up a
 * model with zero debt facilities and checked which of the two `computeReturns`
 * actually does for each metric — this is the case that tells them apart.
 */
describe('the full return metric set with no debt facility', () => {
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
      saleCostPercent: '0',
      directCapAdjustments: '0',
      acquisitionCosts: '0',
      acquisitionPrice: '2000000',
      // A concluded value is what loan-to-value actually divides against —
      // without one, the denominator itself is zero and the metric is null
      // for an unrelated reason (no valuation at all, not "no debt").
      terminalCapRate: '0.065',
      terminalNoiBasis: 'trailing_12',
    },
  });

  const result = calculate(model);

  it('reports debt yield and both DSCR figures as null: there is no balance or debt service to derive them from', () => {
    expect(result.returns.debtYieldYear1).toBeNull();
    expect(result.returns.averageDscr).toBeNull();
    expect(result.returns.minimumDscr).toBeNull();
  });

  it('reports loan-to-value and loan-to-cost as a real, accurate zero: $0 drawn against a valued property is 0%, not a missing figure', () => {
    expect(result.returns.loanToValue).toBe('0');
    expect(result.returns.loanToCost).toBe('0');
  });
});

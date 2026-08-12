import { describe, expect, it } from 'vitest';
import { calculate } from './engine.js';
import { baseModel, extendModel } from './__fixtures__/builders.js';

/**
 * Metrics that read "a year" of NOI on a forecast shorter than a year.
 *
 * Found by a repository-wide correctness audit: `computeDirectCapitalization`
 * annualises its `year_1` basis when the forecast is short, but not its
 * `trailing_12` or `stabilized` bases; `goingInCapRate`/`yieldOnCost`/
 * `debtYieldYear1` were never annualised at all; and `stabilizedCapRate`
 * summed an empty or partial window to a literal "0" instead of the missing
 * figure `null` that `docs/calculation-specification.md` requires. All four
 * silently understated value or yield by up to 2x on a forecast shorter than
 * a year — a normal configuration for a short hold, not a contrived one. See
 * `docs/commercial-gap-analysis.md` for how this was found.
 */
describe('a forecast shorter than 12 months', () => {
  // Flat $10,000/month NOI (no leases, no expenses, no debt) over 6 months:
  // whatever basis a metric reads, the annualised answer is unambiguous —
  // $10,000 x 12 = $120,000/year — which is what makes this fixture useful
  // without needing the engine's own output to check it against.
  function sixMonthFlatNoiModel(overrides: Parameters<typeof extendModel>[1] = {}) {
    return extendModel(baseModel(), {
      forecast: {
        startDate: '2026-01-01',
        months: 6,
        fiscalYearStartMonth: 1,
        proration: 'actual_days',
      },
      otherRevenue: [
        {
          id: 'OTHER',
          name: 'Flat other revenue',
          method: 'custom_monthly_schedule',
          monthlySchedule: Array.from({ length: 6 }, () => '10000'),
        },
      ],
      ...overrides,
    });
  }

  it('annualises the trailing_12 direct-capitalization basis', () => {
    const model = sixMonthFlatNoiModel({
      valuation: {
        discountRate: '0.08',
        saleCostPercent: '0',
        directCapAdjustments: '0',
        acquisitionCosts: '0',
        directCapRate: '0.05',
        directCapNoiBasis: 'trailing_12',
      },
    });
    const result = calculate(model);
    const directCap = result.valuations.find((v) => v.method === 'direct_capitalization');
    expect(directCap).toBeDefined();
    // $10,000 x 6 = $60,000 actually earned; annualised at $10,000 x 12 =
    // $120,000; divided by a 5% cap rate = $2,400,000. Half that ($1,200,000)
    // is exactly what summing the six real months without annualising gives —
    // the bug this test exists to catch.
    expect(Number(directCap?.value)).toBeCloseTo(2_400_000, 2);
  });

  it('annualises the stabilized direct-capitalization basis when no full fiscal year exists yet', () => {
    const model = sixMonthFlatNoiModel({
      valuation: {
        discountRate: '0.08',
        saleCostPercent: '0',
        directCapAdjustments: '0',
        acquisitionCosts: '0',
        directCapRate: '0.05',
        directCapNoiBasis: 'stabilized',
      },
    });
    const result = calculate(model);
    const directCap = result.valuations.find((v) => v.method === 'direct_capitalization');
    expect(directCap).toBeDefined();
    expect(Number(directCap?.value)).toBeCloseTo(2_400_000, 2);
  });

  it('annualises going-in cap rate, yield on cost and year-1 debt yield', () => {
    const model = sixMonthFlatNoiModel({
      valuation: {
        discountRate: '0.08',
        saleCostPercent: '0',
        directCapAdjustments: '0',
        acquisitionCosts: '0',
        acquisitionPrice: '2400000',
      },
    });
    const result = calculate(model);
    // Annualised year-1 NOI ($120,000) over a $2,400,000 basis is exactly 5%.
    // The un-annualised bug read $60,000 over the same basis: 2.5%, half the
    // correct figure.
    expect(Number(result.returns.goingInCapRate)).toBeCloseTo(0.05, 6);
    expect(Number(result.returns.yieldOnCost)).toBeCloseTo(0.05, 6);
  });

  it('reports stabilizedCapRate as null rather than a false zero when the 13-24 month window does not exist', () => {
    const model = sixMonthFlatNoiModel({
      valuation: {
        discountRate: '0.08',
        saleCostPercent: '0',
        directCapAdjustments: '0',
        acquisitionCosts: '0',
        acquisitionPrice: '2400000',
      },
    });
    const result = calculate(model);
    expect(result.returns.stabilizedCapRate).toBeNull();
  });
});

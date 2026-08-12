import { describe, expect, it } from 'vitest';
import { calculate } from './engine.js';
import { aggregatePortfolio, type PortfolioMember } from './portfolio.js';
import { baseModel, extendModel } from './__fixtures__/builders.js';

/**
 * Portfolio "year 1" NOI, when a member's forecast does not start on its own
 * fiscal year's first month.
 *
 * Found by a repository-wide correctness audit: `AnnualSummaryRow.months` is
 * "12 except at the ends" precisely because a forecast beginning mid fiscal
 * year has a partial first bucket — a calendar-fiscal-year fund acquiring a
 * property in April, say, which is the ordinary case, not a contrived one.
 * `aggregatePortfolio` read that partial bucket as "year 1 NOI" unannualised,
 * understating both the reported figure and the going-in cap rate built from
 * it. See `docs/commercial-gap-analysis.md` for how this was found.
 */
describe('a portfolio member whose forecast starts mid fiscal year', () => {
  it('annualises the partial first fiscal-year bucket rather than reporting it as-is', () => {
    // Calendar fiscal year (starts January), forecast starts in April: the
    // first fiscal-year bucket covers April-December, 9 months. Flat
    // $10,000/month NOI makes the correct annualised answer unambiguous:
    // $90,000 actually earned x 12/9 = $120,000.
    const model = extendModel(baseModel(), {
      forecast: {
        startDate: '2026-04-01',
        months: 18,
        fiscalYearStartMonth: 1,
        proration: 'actual_days',
      },
      otherRevenue: [
        {
          id: 'OTHER',
          name: 'Flat other revenue',
          method: 'custom_monthly_schedule',
          monthlySchedule: Array.from({ length: 18 }, () => '10000'),
        },
      ],
      valuation: {
        discountRate: '0.08',
        saleCostPercent: '0',
        directCapAdjustments: '0',
        acquisitionCosts: '0',
        acquisitionPrice: '2400000',
      },
    });
    const result = calculate(model);
    expect(result.annual[0]?.months).toBe(9);

    const member: PortfolioMember = {
      propertyId: 'P1',
      propertyName: 'Fixture Property',
      propertyType: 'office',
      market: null,
      ownershipPercent: '1',
      rentableArea: '100000',
      unitCount: 0,
      result,
    };
    const aggregate = aggregatePortfolio([member]);

    // The bug reported $90,000 — the partial year's real total, un-annualised.
    expect(Number(aggregate.year1NetOperatingIncome)).toBeCloseTo(120_000, 2);
  });
});

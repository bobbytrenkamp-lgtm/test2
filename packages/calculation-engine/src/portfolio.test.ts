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

/**
 * Portfolio weighted exit cap rate, when one member's sale falls outside its
 * own forecast.
 *
 * Found by a third audit pass: `weightedExitCapRate`'s numerator
 * (`exitCapWeighted`) was accumulated whenever `result.returns.exitCapRate`
 * was set — which happens unconditionally from the input assumption,
 * independent of whether `computeSale` actually produced a valuation — while
 * its denominator (`valueWeightBasis`) was only accumulated when a `dcf`
 * valuation existed. A member whose `saleMonth` points past its own forecast
 * (an ordinary data-entry mistake, not a contrived state) still has its
 * `terminalCapRate` recorded as `exitCapRate` even though no sale was ever
 * priced, so its rate got weighted into the numerator against a value basis
 * that never included that member at all — silently skewing the portfolio's
 * reported exit cap rate toward whichever failed member's rate happened to
 * be, with no diagnostic.
 */
describe('a portfolio member whose sale month falls outside its own forecast', () => {
  it('excludes that member from the weighted exit cap rate instead of weighting its rate against the wrong base', () => {
    // Member A: a normal 12-month forecast, sale in the last (12th) month, so
    // computeSale succeeds and a `dcf` valuation is produced. 0% discount
    // rate makes every discount factor exactly 1, so the DCF value is
    // hand-derivable without simulating present-value arithmetic: trailing-12
    // NOI of $10,000 x 12 = $120,000, divided by a 5% exit cap rate =
    // $2,400,000 gross sale price (0% selling cost), plus the $120,000 of
    // operating cash flow collected over the 12 months = $2,520,000.
    const modelA = extendModel(baseModel(), {
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
        discountRate: '0',
        saleCostPercent: '0',
        directCapAdjustments: '0',
        acquisitionCosts: '0',
        acquisitionPrice: '1000000',
        saleMonth: 12,
        terminalCapRate: '0.05',
        terminalNoiBasis: 'trailing_12',
      },
    });
    const resultA = calculate(modelA);
    expect(resultA.valuations.find((v) => v.method === 'dcf')?.value).toBe('2520000');

    // Member B: `saleMonth: 15` on a 12-month forecast — outside the
    // forecast, so `computeSale` fails with `SALE_MONTH_OUT_OF_RANGE` and no
    // `dcf` valuation is produced. `directCapRate` is still configured, so a
    // `direct_capitalization` valuation succeeds independently: $8,000 x 12 =
    // $96,000 NOI divided by 5% = $1,920,000. `terminalCapRate` (6%) is still
    // recorded as this member's `exitCapRate` even though it was never used
    // to price anything.
    const modelB = extendModel(baseModel(), {
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
          monthlySchedule: Array.from({ length: 12 }, () => '8000'),
        },
      ],
      valuation: {
        discountRate: '0.08',
        saleCostPercent: '0',
        directCapAdjustments: '0',
        acquisitionCosts: '0',
        acquisitionPrice: '1000000',
        saleMonth: 15,
        terminalCapRate: '0.06',
        directCapRate: '0.05',
        directCapNoiBasis: 'year_1',
      },
    });
    const resultB = calculate(modelB);
    expect(resultB.valuations.find((v) => v.method === 'dcf')).toBeUndefined();
    expect(resultB.valuations.find((v) => v.method === 'direct_capitalization')?.value).toBe(
      '1920000',
    );
    expect(
      resultB.diagnostics.find((entry) => entry.code === 'SALE_MONTH_OUT_OF_RANGE')?.severity,
    ).toBe('error');
    expect(resultB.returns.exitCapRate).toBe('0.06');

    const memberA: PortfolioMember = {
      propertyId: 'A',
      propertyName: 'Property A',
      propertyType: 'office',
      market: null,
      ownershipPercent: '1',
      rentableArea: '100000',
      unitCount: 0,
      result: resultA,
    };
    const memberB: PortfolioMember = {
      propertyId: 'B',
      propertyName: 'Property B',
      propertyType: 'office',
      market: null,
      ownershipPercent: '1',
      rentableArea: '100000',
      unitCount: 0,
      result: resultB,
    };
    const aggregate = aggregatePortfolio([memberA, memberB]);

    // Hand-derived: only member A ever priced a sale, so it should be the
    // only member in both the numerator and the denominator, giving back
    // exactly its own 5% rate. The bug pulled member B's 6% into the
    // numerator against a denominator that excluded member B's $1,920,000 of
    // value entirely, reading (0.05 x 2,520,000 + 0.06 x 1,920,000) /
    // 2,520,000 = 9.571...% instead.
    expect(Number(aggregate.weightedExitCapRate)).toBeCloseTo(0.05, 6);
  });
});

/**
 * Portfolio going-in cap rate and loan-to-value, when one member has no
 * valuation at all.
 *
 * Found by an eleventh audit pass: `grossAssetValue` correctly reads ZERO for
 * a member with neither a `dcf` nor a `direct_capitalization` result (both
 * are legitimately optional — a model with no exit cap rate and no direct
 * cap rate configured still calculates and can still be a portfolio member),
 * but `year1Noi` and `totalDebt` were accumulated from *every* member
 * regardless, unconditionally. `weightedGoingInCapRate` and `loanToValue` are
 * both built as that full NOI/debt over the reduced `grossAssetValue` — a
 * numerator drawn from more members than the denominator, the exact mismatch
 * the already-fixed `weightedExitCapRate` gate above exists to prevent for
 * the same reason.
 */
describe('a portfolio member with no valuation at all', () => {
  it('excludes that member’s NOI and debt from the value-weighted ratios, without dropping them from the plain totals', () => {
    // Member A: a normal, valued property. $600,000/year NOI (flat,
    // $50,000/month, so annualisation is exact with nothing to round), a 6%
    // direct cap rate -> value = 600,000 / 0.06 = $10,000,000 exactly. No
    // debt.
    const modelA = extendModel(baseModel(), {
      forecast: {
        startDate: '2026-01-01',
        months: 12,
        fiscalYearStartMonth: 1,
        proration: 'actual_days',
      },
      otherRevenue: [
        {
          id: 'OTHER',
          name: 'Flat revenue',
          method: 'custom_monthly_schedule',
          monthlySchedule: Array.from({ length: 12 }, () => '50000'),
        },
      ],
      valuation: {
        discountRate: '0.08',
        saleCostPercent: '0',
        directCapAdjustments: '0',
        acquisitionCosts: '0',
        acquisitionPrice: '9500000',
        directCapRate: '0.06',
        directCapNoiBasis: 'year_1',
      },
    });
    const resultA = calculate(modelA);
    expect(resultA.valuations.find((v) => v.method === 'direct_capitalization')?.value).toBe(
      '10000000',
    );

    // Member B: no terminalCapRate, no grossSalePriceOverride and no
    // directCapRate anywhere in its valuation block (baseModel's own default
    // already omits all three) -> valuations is empty, but the model is
    // otherwise perfectly calculable. $300,000/year NOI, and a fully-drawn
    // $5,000,000 interest-only facility -> debtSchedules[0].rows[0]
    // .endingBalance is exactly $5,000,000.
    const modelB = extendModel(baseModel(), {
      forecast: {
        startDate: '2026-01-01',
        months: 12,
        fiscalYearStartMonth: 1,
        proration: 'actual_days',
      },
      otherRevenue: [
        {
          id: 'OTHER',
          name: 'Flat revenue',
          method: 'custom_monthly_schedule',
          monthlySchedule: Array.from({ length: 12 }, () => '25000'),
        },
      ],
      debt: [
        {
          id: 'D1',
          name: 'Bridge loan',
          type: 'bridge',
          commitment: '5000000',
          initialFunding: '5000000',
          fundingDate: '2026-01-01',
          interestOnlyMonths: 999,
          amortizationMonths: 0,
          termMonths: 12,
        },
      ],
    });
    const resultB = calculate(modelB);
    expect(resultB.valuations).toEqual([]);
    expect(resultB.debtSchedules[0]?.rows[0]?.endingBalance).toBe('5000000');

    const memberA: PortfolioMember = {
      propertyId: 'A',
      propertyName: 'Property A',
      propertyType: 'office',
      market: null,
      ownershipPercent: '1',
      rentableArea: '100000',
      unitCount: 0,
      result: resultA,
    };
    const memberB: PortfolioMember = {
      propertyId: 'B',
      propertyName: 'Property B',
      propertyType: 'office',
      market: null,
      ownershipPercent: '1',
      rentableArea: '100000',
      unitCount: 0,
      result: resultB,
    };
    const aggregate = aggregatePortfolio([memberA, memberB]);

    // Hand-derived, fixed: only A has a value ($10,000,000), so the cap rate
    // reads back exactly A's own 6% and A's own zero debt -- neither ratio
    // blends in B's income or B's debt, because neither is backed by
    // recognised value in this aggregate. The bug read 900,000 / 10,000,000
    // = 9.0% and 5,000,000 / 10,000,000 = 50% instead, both drawn from B
    // despite B contributing nothing to the $10,000,000 they were divided
    // by.
    expect(Number(aggregate.weightedGoingInCapRate)).toBeCloseTo(0.06, 6);
    expect(Number(aggregate.loanToValue)).toBeCloseTo(0, 6);

    // The plain totals are unaffected by the fix -- B's real NOI and real
    // debt still count toward the portfolio's actual totals, which is a
    // separate, still-true fact from what the two ratios above should read.
    expect(Number(aggregate.year1NetOperatingIncome)).toBeCloseTo(900_000, 2);
    expect(Number(aggregate.totalDebt)).toBeCloseTo(5_000_000, 2);
  });
});

/**
 * Portfolio unlevered/levered IRR and equity multiple, for a property bought
 * below its own concluded value.
 *
 * Found by a repository-wide correctness audit: `aggregatePortfolio` built
 * `initialUnlevered`/`initialEquity` from the member's *concluded* DCF or
 * direct-cap value, not what was actually paid for it. The property-level
 * `unleveredIrr`/`leveredIrr` in `engine.ts` correctly discount from
 * `acquisitionBasis + acquisitionCosts` (and the equity actually funded at
 * close) — buying below or above appraised value is the ordinary case, not a
 * contrived one, so the two bases routinely differ. A single property held
 * at 100% ownership must roll up to *exactly* its own property-level IRR and
 * equity multiple; any drift proves the portfolio is discounting the same
 * cash flows against a basis the property itself never used.
 */
describe('a portfolio member bought below its own concluded value', () => {
  it('rolls up to exactly the property-level unlevered IRR, levered IRR and equity multiple', () => {
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
          monthlySchedule: Array.from({ length: 12 }, () => '50000'),
        },
      ],
      valuation: {
        discountRate: '0',
        saleCostPercent: '0',
        directCapAdjustments: '0',
        acquisitionCosts: '0',
        // Priced well below the $2,520,000 the sale at a 5% terminal cap
        // rate is going to realise, so the two bases cannot coincidentally
        // agree.
        acquisitionPrice: '1000000',
        saleMonth: 12,
        terminalCapRate: '0.05',
        terminalNoiBasis: 'trailing_12',
      },
      debt: [
        {
          id: 'D1',
          name: 'Bridge loan',
          type: 'bridge',
          commitment: '500000',
          initialFunding: '500000',
          fundingDate: '2026-01-01',
          interestOnlyMonths: 999,
          amortizationMonths: 0,
          termMonths: 12,
        },
      ],
    });
    const result = calculate(model);
    const dcfValue = Number(result.valuations.find((v) => v.method === 'dcf')?.value);
    expect(dcfValue).toBeGreaterThan(1_000_000);
    expect(result.returns.unleveredIrr).not.toBeNull();
    expect(result.returns.leveredIrr).not.toBeNull();

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

    // The bug discounted the same cash flows against the ~$3.5M+ direct-cap
    // value instead of the $3,000,000 actually paid (less debt funded at
    // close for the levered figure), reporting a materially different,
    // understated IRR and equity multiple than the property itself.
    expect(Number(aggregate.portfolioUnleveredIrr)).toBeCloseTo(
      Number(result.returns.unleveredIrr),
      8,
    );
    expect(Number(aggregate.portfolioLeveredIrr)).toBeCloseTo(Number(result.returns.leveredIrr), 8);
    expect(Number(aggregate.portfolioEquityMultiple)).toBeCloseTo(
      Number(result.returns.equityMultiple),
      8,
    );
  });
});

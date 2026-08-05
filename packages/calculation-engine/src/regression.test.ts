import { describe, expect, it } from 'vitest';
import type { AnnualSummaryRow, CashFlowLine, ModelResult } from '@cre/domain-models';
import { calculate } from './engine.js';
import {
  ALL_FIXTURES,
  baseYearRecovery,
  contractionOption,
  expansionOption,
  expenseStopRecovery,
  floatingRateDebt,
  cashTrapDisabled,
  cashTrapOnBreach,
  lpGpWaterfall,
  multiplePoolRecovery,
  partialSpaceRecovery,
  percentageRentProperty,
  reconciledRecovery,
  sponsorFeeBases,
  refinanceScenario,
  renewalOption,
  singleTenantIndustrial,
  terminationOption,
} from './__fixtures__/properties.js';

/**
 * Calculation regression library.
 *
 * Expected results are derived by hand from the fixture assumptions, or
 * recomputed here by a different method than the engine uses (a closed-form
 * geometric series rather than a per-period loop, for example). No expected
 * value in this file was produced by running the engine and copying its
 * output, which is what keeps these tests from being circular.
 *
 * Tolerances are stated per assertion. Exact string comparisons are used
 * wherever the arithmetic is exact in decimal.
 */

const FIXED_CLOCK = '2026-01-01T00:00:00.000Z';

function run(input: Parameters<typeof calculate>[0], trace = false): ModelResult {
  return calculate(input, { calculatedAt: FIXED_CLOCK, trace: { enabled: trace } });
}

function year(result: ModelResult, fiscalYear: number): AnnualSummaryRow {
  const row = result.annual.find((entry) => entry.fiscalYear === fiscalYear);
  if (!row) throw new Error(`Fiscal year ${fiscalYear} is not in the result`);
  return row;
}

function line(result: ModelResult, fiscalYear: number, name: CashFlowLine): number {
  return Number(year(result, fiscalYear).lines[name]);
}

/* -------------------------------------------------------------------------- */

describe('Fixture 1: single-tenant industrial, triple net with 3% escalations', () => {
  const result = run(singleTenantIndustrial());

  it('bills the contract rent exactly', () => {
    // $6.00/sf/yr on 100,000 sf = $600,000 in year one, then 3% compounding
    // each January: 6.00, 6.18, 6.3654, 6.556362, 6.75305286 per sf.
    expect(year(result, 2026).lines.scheduledBaseRent).toBe('600000.00');
    expect(year(result, 2027).lines.scheduledBaseRent).toBe('618000.00');
    expect(year(result, 2028).lines.scheduledBaseRent).toBe('636540.00');
    expect(year(result, 2029).lines.scheduledBaseRent).toBe('655636.20');
    expect(year(result, 2030).lines.scheduledBaseRent).toBe('675305.29');
  });

  it('bills an even twelfth of annual rent each month', () => {
    // 600,000 / 12 = 50,000. Every month of year one is a full month.
    for (let i = 0; i < 12; i += 1) {
      expect(result.monthly.scheduledBaseRent[i]).toBe('50000.00');
    }
  });

  it('recovers the whole expense from the single triple-net tenant', () => {
    // Sole tenant, so the pro-rata share is 100,000/100,000 = 1.
    expect(year(result, 2026).lines.expenseRecoveries).toBe('50000.00');
    expect(year(result, 2026).lines.operatingExpenses).toBe('-50000.00');
    // A fully recovered expense leaves NOI equal to base rent.
    expect(year(result, 2026).lines.netOperatingIncome).toBe('600000.00');
    expect(year(result, 2030).lines.netOperatingIncome).toBe('675305.29');
  });

  it('shows no vacancy while the building is fully let', () => {
    expect(year(result, 2026).lines.absorptionAndTurnoverVacancy).toBe('0.00');
    expect(year(result, 2026).lines.generalVacancy).toBe('0.00');
    expect(result.occupancy[0]?.physicalOccupancyPercent).toBe('1.00000000');
  });

  it('capitalises the trailing-twelve NOI at the exit rate', () => {
    const dcf = result.valuations.find((v) => v.method === 'dcf');
    expect(dcf).toBeDefined();
    // Year-five NOI 675,305.286 / 6.5% = 10,389,312.0923...
    expect(Number(dcf?.detail.terminalNoi)).toBeCloseTo(675305.286, 3);
    expect(Number(dcf?.detail.grossSalePrice)).toBeCloseTo(675305.286 / 0.065, 2);
    expect(Number(dcf?.detail.sellingCosts)).toBeCloseTo((675305.286 / 0.065) * 0.01, 2);
  });

  it('matches a closed-form present value of the cash flows and reversion', () => {
    // Recomputed here as five geometric annuities plus a discounted reversion,
    // which is a different derivation from the engine's per-period loop.
    const v = Math.pow(1.08, -1 / 12);
    const annualRents = [600000, 618000, 636540, 655636.2, 675305.286];
    let pv = 0;
    annualRents.forEach((annual, yearIndex) => {
      const monthly = annual / 12;
      const first = yearIndex * 12 + 1;
      // Sum of v^first .. v^(first+11).
      const annuity = (Math.pow(v, first) * (1 - Math.pow(v, 12))) / (1 - v);
      pv += monthly * annuity;
    });
    const netProceeds = (675305.286 / 0.065) * 0.99;
    pv += netProceeds * Math.pow(v, 60);

    const dcf = result.valuations.find((m) => m.method === 'dcf');
    expect(Number(dcf?.value)).toBeCloseTo(pv, 1);
  });

  it('reports a going-in capitalisation rate on the stated purchase price', () => {
    // 600,000 / 9,000,000 = 6.667%.
    expect(Number(result.returns.goingInCapRate)).toBeCloseTo(600000 / 9000000, 10);
  });
});

/* -------------------------------------------------------------------------- */

describe('Fixture 7: base-year recovery', () => {
  const result = run(baseYearRecovery());

  it('recovers only the growth above the base year', () => {
    // Expense 500,000 growing 10% a year: 500,000 / 550,000 / 605,000 / 665,500.
    // Base year 2026, sole tenant, so the recovery is the excess over 500,000.
    expect(year(result, 2026).lines.expenseRecoveries).toBe('0.00');
    expect(year(result, 2027).lines.expenseRecoveries).toBe('50000.00');
    expect(year(result, 2028).lines.expenseRecoveries).toBe('105000.00');
    expect(year(result, 2029).lines.expenseRecoveries).toBe('165500.00');
  });

  it('charges the expense at the grown amount', () => {
    expect(year(result, 2026).lines.operatingExpenses).toBe('-500000.00');
    expect(year(result, 2027).lines.operatingExpenses).toBe('-550000.00');
    expect(year(result, 2028).lines.operatingExpenses).toBe('-605000.00');
    expect(year(result, 2029).lines.operatingExpenses).toBe('-665500.00');
  });

  it('holds NOI flat, which is what a base-year stop is designed to do', () => {
    // 1,000,000 base rent + recovery - expense = 500,000 in every year.
    for (const fiscalYear of [2026, 2027, 2028, 2029]) {
      expect(year(result, fiscalYear).lines.netOperatingIncome).toBe('500000.00');
    }
  });

  it('publishes the recovery workings for every year', () => {
    const detail = result.recoveryDetail.filter((row) => row.leaseId === 'L1');
    expect(detail).toHaveLength(4);
    const secondYear = detail.find((row) => row.fiscalYear === 2027);
    expect(Number(secondYear?.proRataShare)).toBeCloseTo(1, 10);
    expect(Number(secondYear?.grossedUpExpensePool)).toBeCloseTo(550000, 6);
    expect(Number(secondYear?.baseYearAmount)).toBeCloseTo(500000, 6);
    expect(Number(secondYear?.finalRecovery)).toBeCloseTo(50000, 6);
  });
});

/* -------------------------------------------------------------------------- */

describe('Fixture 8: expense stop with a half-building pro-rata share', () => {
  const result = run(expenseStopRecovery());

  it('recovers the pro-rata share above the stop, and nothing from the gross tenant', () => {
    // Pool 1,000,000; T1 share 0.5 = 500,000; stop 8.00 x 50,000 = 400,000.
    expect(year(result, 2026).lines.expenseRecoveries).toBe('100000.00');
    expect(year(result, 2027).lines.expenseRecoveries).toBe('100000.00');
    const stopTenant = result.recoveryDetail.find((row) => row.leaseId === 'L1');
    expect(Number(stopTenant?.proRataShare)).toBeCloseTo(0.5, 10);
    expect(Number(stopTenant?.expenseStopAmount)).toBeCloseTo(400000, 6);
    // The full-service tenant produces no recovery rows at all.
    expect(result.recoveryDetail.some((row) => row.leaseId === 'L2')).toBe(false);
  });

  it('reconciles to NOI', () => {
    // Base rent 1,250,000 + 1,400,000 = 2,650,000; plus 100,000 recovery,
    // less 1,000,000 of expenses.
    expect(year(result, 2026).lines.scheduledBaseRent).toBe('2650000.00');
    expect(year(result, 2026).lines.effectiveGrossRevenue).toBe('2750000.00');
    expect(year(result, 2026).lines.netOperatingIncome).toBe('1750000.00');
  });
});

/* -------------------------------------------------------------------------- */

describe('Fixture 9: percentage rent on a natural breakpoint', () => {
  const result = run(percentageRentProperty());

  it('charges the overage above the natural breakpoint', () => {
    // Base rent 20,000 sf x $15 = 300,000; natural breakpoint 300,000 / 5%
    // = 6,000,000 of sales. Year one sales 8,000,000, so the overage is
    // (8,000,000 - 6,000,000) x 5% = 100,000.
    expect(year(result, 2026).lines.percentageRent).toBe('100000.00');
    // Year two sales grow 5% to 8,400,000 while the breakpoint is unchanged,
    // because base rent is flat: (8,400,000 - 6,000,000) x 5% = 120,000.
    expect(year(result, 2027).lines.percentageRent).toBe('120000.00');
  });

  it('includes overage rent in gross potential revenue', () => {
    expect(year(result, 2026).lines.grossPotentialRevenue).toBe('400000.00');
  });
});

/* -------------------------------------------------------------------------- */

describe('Fixture 10: floating-rate debt with an index floor', () => {
  const result = run(floatingRateDebt());
  const schedule = result.debtSchedules[0];

  it('applies index plus spread, floored', () => {
    // Index 5.0 / 4.5 / 3.5 / 3.0 plus a 2.5 spread gives 7.5 / 7.0 / 6.0 /
    // 5.5; the 6.5% floor binds in years three and four.
    expect(Number(schedule?.rows[0]?.appliedRate)).toBeCloseTo(0.075, 10);
    expect(Number(schedule?.rows[12]?.appliedRate)).toBeCloseTo(0.07, 10);
    expect(Number(schedule?.rows[24]?.appliedRate)).toBeCloseTo(0.065, 10);
    expect(Number(schedule?.rows[36]?.appliedRate)).toBeCloseTo(0.065, 10);
  });

  it('charges interest-only on the full balance', () => {
    // 6,000,000 x 7.5% / 12 = 37,500 a month in year one.
    expect(Number(schedule?.rows[0]?.cashInterest)).toBeCloseTo(37500, 6);
    expect(line(result, 2026, 'interestExpense')).toBeCloseTo(-450000, 2);
    expect(line(result, 2027, 'interestExpense')).toBeCloseTo(-420000, 2);
    expect(line(result, 2028, 'interestExpense')).toBeCloseTo(-390000, 2);
    expect(line(result, 2029, 'interestExpense')).toBeCloseTo(-390000, 2);
  });

  it('charges the origination fee on the commitment at funding', () => {
    // 6,000,000 x 1% = 60,000, all of it in the funding month.
    expect(Number(schedule?.rows[0]?.fees)).toBeCloseTo(60000, 6);
  });

  it('amortizes nothing and repays the balloon at maturity', () => {
    // The facility is interest-only for its whole 48-month term.
    expect(Math.abs(line(result, 2026, 'principalAmortization'))).toBe(0);
    expect(Math.abs(line(result, 2029, 'principalAmortization'))).toBe(0);
    expect(Number(schedule?.rows[47]?.endingBalance)).toBe(0);
    expect(line(result, 2029, 'debtPayoff')).toBeCloseTo(-6000000, 2);
  });
});

/* -------------------------------------------------------------------------- */

describe('Fixture 11: amortizing loan replaced by a refinancing', () => {
  const result = run(refinanceScenario());
  const original = result.debtSchedules.find((s) => s.facilityId === 'D-INITIAL');
  const replacement = result.debtSchedules.find((s) => s.facilityId === 'D-REFI');

  it('amortizes the original loan on a standard 30-year schedule', () => {
    // 5,000,000 at 6% nominal: month-one interest is 5,000,000 x 0.005 = 25,000.
    expect(Number(original?.rows[0]?.cashInterest)).toBeCloseTo(25000, 6);
    // Level payment = P*r / (1 - (1+r)^-n) with r = 0.005, n = 360.
    const payment = (5000000 * 0.005) / (1 - Math.pow(1.005, -360));
    expect(Number(original?.rows[0]?.principal)).toBeCloseTo(payment - 25000, 4);
  });

  it('repays the original balance at its 24-month maturity', () => {
    // Closed-form remaining balance after k payments:
    // B_k = P(1+r)^k - pmt((1+r)^k - 1)/r.
    // Row 23 is month 24, so its opening balance follows 23 payments.
    const r = 0.005;
    const pmt = (5000000 * r) / (1 - Math.pow(1 + r, -360));
    const afterPayments = (k: number): number =>
      5000000 * Math.pow(1 + r, k) - (pmt * (Math.pow(1 + r, k) - 1)) / r;
    expect(Number(original?.rows[23]?.beginningBalance)).toBeCloseTo(afterPayments(23), 2);
    // The balloon repays whatever is left after the twenty-fourth payment.
    expect(Number(original?.rows[23]?.endingBalance)).toBe(0);
    const payoff =
      Number(original?.rows[23]?.beginningBalance) - Number(original?.rows[23]?.principal);
    expect(payoff).toBeCloseTo(afterPayments(24), 2);
  });

  it('funds the replacement loan in the month after maturity', () => {
    // Months 1-24 carry the original loan; the refinancing funds in month 25.
    expect(Number(replacement?.rows[23]?.endingBalance)).toBe(0);
    expect(Number(replacement?.rows[24]?.draws)).toBeCloseTo(6500000, 2);
    expect(Number(replacement?.rows[24]?.endingBalance)).toBeCloseTo(6500000, 2);
    // 6,500,000 x 5.5% / 12 = 29,791.67 of interest while interest-only.
    expect(Number(replacement?.rows[25]?.cashInterest)).toBeCloseTo((6500000 * 0.055) / 12, 4);
  });
});

/* -------------------------------------------------------------------------- */

describe('Fixture 12: LP/GP waterfall', () => {
  const result = run(lpGpWaterfall());
  const lp = result.waterfall.find((p) => p.partnerId === 'LP');
  const gp = result.waterfall.find((p) => p.partnerId === 'GP');

  it('splits contributions on the stated shares', () => {
    // 7,000,000 of equity at 90/10.
    expect(Number(lp?.contributions)).toBeCloseTo(6300000, 2);
    expect(Number(gp?.contributions)).toBeCloseTo(700000, 2);
  });

  it('distributes every dollar of positive equity cash flow', () => {
    const distributed = Number(lp?.distributions) + Number(gp?.distributions);
    // 4 years of 500,000 NOI plus net sale proceeds of 500,000 / 5.5% x 99%.
    const expected = 4 * 500000 + (500000 / 0.055) * 0.99;
    expect(distributed).toBeCloseTo(expected, 0);
  });

  it('pays the sponsor a promote above its contribution share', () => {
    const totalProfit = Number(lp?.profit) + Number(gp?.profit);
    const gpShareOfProfit = Number(gp?.profit) / totalProfit;
    expect(totalProfit).toBeGreaterThan(0);
    // The sponsor contributed 10% but earns more than that once the preferred
    // return is satisfied and the catch-up and promote engage.
    expect(gpShareOfProfit).toBeGreaterThan(0.1);
    const catchUp = gp?.byTier.find((tier) => tier.tierId === 'T-CATCHUP');
    expect(Number(catchUp?.amount)).toBeGreaterThan(0);
  });

  it('clears the preferred return for the limited partner', () => {
    expect(Number(lp?.irr)).toBeGreaterThan(0.08);
  });

  it('allocates through the preferred tier before returning capital', () => {
    const pref = lp?.byTier.find((tier) => tier.tierId === 'T-PREF');
    const roc = lp?.byTier.find((tier) => tier.tierId === 'T-ROC');
    expect(Number(pref?.amount)).toBeGreaterThan(0);
    expect(Number(roc?.amount)).toBeCloseTo(6300000, 0);
  });
});

/* -------------------------------------------------------------------------- */

describe('engine-wide invariants', () => {
  for (const [name, factory] of Object.entries(ALL_FIXTURES)) {
    describe(name, () => {
      const result = run(factory());

      it('produces the same result for the same input', () => {
        const again = run(factory());
        expect(again.monthly).toEqual(result.monthly);
        expect(again.valuations).toEqual(result.valuations);
        expect(again.returns).toEqual(result.returns);
      });

      it('reconciles effective gross revenue to its components', () => {
        result.annual.forEach((row) => {
          const gpr = Number(row.lines.grossPotentialRevenue);
          const components =
            Number(row.lines.scheduledBaseRent) +
            Number(row.lines.percentageRent) +
            Number(row.lines.expenseRecoveries) +
            Number(row.lines.otherLeaseRevenue) +
            Number(row.lines.otherPropertyRevenue);
          expect(gpr).toBeCloseTo(components, 1);

          const egr = Number(row.lines.effectiveGrossRevenue);
          expect(egr).toBeCloseTo(
            gpr + Number(row.lines.generalVacancy) + Number(row.lines.creditLoss),
            1,
          );
          expect(Number(row.lines.netOperatingIncome)).toBeCloseTo(
            egr + Number(row.lines.operatingExpenses),
            1,
          );
        });
      });

      it('reconciles scheduled base rent to potential rent less vacancy and free rent', () => {
        result.annual.forEach((row) => {
          expect(Number(row.lines.contractualBaseRent)).toBeCloseTo(
            Number(row.lines.potentialBaseRent) + Number(row.lines.absorptionAndTurnoverVacancy),
            1,
          );
          expect(Number(row.lines.scheduledBaseRent)).toBeCloseTo(
            Number(row.lines.contractualBaseRent) + Number(row.lines.freeRent),
            1,
          );
        });
      });

      it('reconciles unlevered cash flow to NOI less capital', () => {
        result.annual.forEach((row) => {
          expect(Number(row.lines.unleveredCashFlow)).toBeCloseTo(
            Number(row.lines.netOperatingIncome) +
              Number(row.lines.tenantImprovements) +
              Number(row.lines.leasingCommissions) +
              Number(row.lines.capitalExpenditures),
            1,
          );
        });
      });

      it('reconciles occupied and vacant area to the rentable total', () => {
        result.occupancy.forEach((row) => {
          expect(Number(row.occupiedArea) + Number(row.availableArea)).toBeCloseTo(
            Number(row.totalRentableArea),
            3,
          );
          expect(Number(row.physicalOccupancyPercent)).toBeGreaterThanOrEqual(0);
          expect(Number(row.physicalOccupancyPercent)).toBeLessThanOrEqual(1.0001);
        });
      });

      it('never deducts general vacancy that the lease forecast already captured', () => {
        result.monthly.generalVacancy.forEach((value, index) => {
          const modelled = Math.abs(Number(result.monthly.absorptionAndTurnoverVacancy[index]));
          const general = Math.abs(Number(value));
          const scheduled = Number(result.monthly.scheduledBaseRent[index]);
          const recoveries = Number(result.monthly.expenseRecoveries[index]);
          const other = Number(result.monthly.otherPropertyRevenue[index]);
          const target = 0.06 * (scheduled + recoveries + other);
          // With netting on, the general allowance can never exceed the target
          // rate, and it shrinks as modelled vacancy grows.
          if (modelled > 0) expect(general).toBeLessThanOrEqual(target + 1);
        });
      });

      it('reports no critical calculation errors', () => {
        const errors = result.diagnostics.filter((entry) => entry.severity === 'error');
        expect(errors).toEqual([]);
      });

      it('stamps the engine version onto the result', () => {
        expect(result.engineVersion).toMatch(/^\d+\.\d+\.\d+$/);
      });
    });
  }
});

/* -------------------------------------------------------------------------- */

/**
 * Lease options.
 *
 * Every figure below is one line of arithmetic on the fixture: 10,000 sf at
 * $24.00/sf/yr is $240,000 a year and exactly $20,000 a month, flat, with no
 * recoveries or expenses in the way. That is deliberate — an option's effect on
 * a cash flow should be checkable without a spreadsheet.
 *
 * The lease is excluded from rollover in these fixtures, so what is measured is
 * the option alone rather than a market-leasing branch layered on top of it.
 */
describe('Fixture 13: renewal option at 60%', () => {
  const result = run(renewalOption());

  it('bills the contract term in full, whichever way the option goes', () => {
    // Both branches hold the whole building to 2028-12-31, so the weights sum
    // back to one and the contract years are unaffected by the option.
    expect(year(result, 2026).lines.scheduledBaseRent).toBe('240000.00');
    expect(year(result, 2027).lines.scheduledBaseRent).toBe('240000.00');
    expect(year(result, 2028).lines.scheduledBaseRent).toBe('240000.00');
  });

  it('bills the extension at the option rent, weighted by its probability', () => {
    // Exercised branch only: 0.60 x 10,000 sf x $30.00 = $180,000 a year.
    // The 40% branch has no lease after 2028 and contributes nothing.
    expect(year(result, 2029).lines.scheduledBaseRent).toBe('180000.00');
    expect(year(result, 2030).lines.scheduledBaseRent).toBe('180000.00');
  });

  it('carries occupancy at the exercise probability once the term has run', () => {
    // 60% of the building is occupied in expectation from 2029.
    const january2029 = result.occupancy[36];
    expect(Number(january2029?.physicalOccupancyPercent)).toBeCloseTo(0.6, 6);
    // The contract term is fully occupied on both branches.
    expect(Number(result.occupancy[0]?.physicalOccupancyPercent)).toBeCloseTo(1, 6);
  });

  it('raises no critical error', () => {
    expect(result.diagnostics.filter((entry) => entry.severity === 'error')).toEqual([]);
  });
});

describe('Fixture 14: termination option at 25%', () => {
  const result = run(terminationOption());

  it('bills both branches in full before the exercise date', () => {
    expect(year(result, 2026).lines.scheduledBaseRent).toBe('240000.00');
    expect(year(result, 2027).lines.scheduledBaseRent).toBe('240000.00');
  });

  it('bills the exercise year as the weighted blend of a short and a full year', () => {
    // Terminating branch (25%): January to June inclusive, 6 x $20,000 =
    // $120,000. Continuing branch (75%): the full $240,000.
    //   0.25 x 120,000 + 0.75 x 240,000 = 30,000 + 180,000 = 210,000
    expect(year(result, 2028).lines.scheduledBaseRent).toBe('210000.00');
  });

  it('bills only the continuing branch thereafter', () => {
    // 0.75 x 240,000 = 180,000.
    expect(year(result, 2029).lines.scheduledBaseRent).toBe('180000.00');
    expect(year(result, 2030).lines.scheduledBaseRent).toBe('180000.00');
  });

  it('carries occupancy at the complement of the termination probability', () => {
    // July 2028 is period 31 (1-based month 31 = index 30).
    expect(Number(result.occupancy[30]?.physicalOccupancyPercent)).toBeCloseTo(0.75, 6);
  });

  it('raises no critical error', () => {
    expect(result.diagnostics.filter((entry) => entry.severity === 'error')).toEqual([]);
  });
});

describe('Fixture 15: contraction option at 50%', () => {
  const result = run(contractionOption());

  it('bills the full premises before the exercise date', () => {
    expect(year(result, 2026).lines.scheduledBaseRent).toBe('240000.00');
    expect(year(result, 2027).lines.scheduledBaseRent).toBe('240000.00');
  });

  it('bills the reduced premises on the exercising branch only', () => {
    // Contracting branch (50%): 6,000 sf x $24.00 = $144,000.
    // Continuing branch (50%): 10,000 sf x $24.00 = $240,000.
    //   0.5 x 144,000 + 0.5 x 240,000 = 72,000 + 120,000 = 192,000
    expect(year(result, 2028).lines.scheduledBaseRent).toBe('192000.00');
    expect(year(result, 2029).lines.scheduledBaseRent).toBe('192000.00');
    expect(year(result, 2030).lines.scheduledBaseRent).toBe('192000.00');
  });

  it('leaves the surrendered area vacant rather than re-letting it', () => {
    // 0.5 x 6,000 + 0.5 x 10,000 = 8,000 of 10,000 occupied in expectation.
    expect(Number(result.occupancy[24]?.physicalOccupancyPercent)).toBeCloseTo(0.8, 6);
  });

  it('raises no critical error', () => {
    expect(result.diagnostics.filter((entry) => entry.severity === 'error')).toEqual([]);
  });
});

describe('options the engine deliberately does not model', () => {
  it('says so, rather than silently ignoring an expansion option', () => {
    const result = run(expansionOption());
    const warning = result.diagnostics.find((entry) => entry.code === 'LEASE_OPTION_NOT_MODELLED');
    expect(warning).toBeDefined();
    expect(warning?.severity).toBe('warning');
    expect(warning?.message).toContain('expansion');
    // The reason has to be in the message: a warning nobody can act on is
    // noise, and the reader needs to know it is the missing space reference.
    expect(warning?.message).toContain('which space');
  });

  it('leaves the cash flow untouched by an option it will not model', () => {
    // Identical to the contraction fixture's lease but with an expansion option
    // instead, so the rent must be the plain unoptioned $240,000 a year.
    const result = run(expansionOption());
    expect(year(result, 2028).lines.scheduledBaseRent).toBe('240000.00');
    expect(year(result, 2030).lines.scheduledBaseRent).toBe('240000.00');
  });
});

/* -------------------------------------------------------------------------- */

describe('calculation traces', () => {
  it('explains base rent, recoveries, terminal value and present value', () => {
    const result = run(baseYearRecovery(), true);
    const targets = result.trace.map((entry) => entry.formula);
    expect(targets).toContain('lease.baseRent');
    expect(targets).toContain('recovery.base_year');
    expect(targets).toContain('valuation.terminalValue');
    expect(targets).toContain('valuation.dcf');

    const rentTrace = result.trace.find((entry) => entry.formula === 'lease.baseRent');
    expect(rentTrace?.sources).toContain('lease:L1');
    expect(rentTrace?.inputs).toHaveProperty('area');
    expect(rentTrace?.result).toBeDefined();
  });

  it('records nothing when tracing is off', () => {
    const result = run(baseYearRecovery(), false);
    expect(result.trace).toEqual([]);
  });
});

/* -------------------------------------------------------------------------- */

describe('Fixture 16: two recovery pools settling on different terms', () => {
  const result = run(multiplePoolRecovery());

  /*
   * Derived by hand from the fixture, not from the engine.
   *
   *   Operating costs pool: 400,000 growing 10% -> 400,000 / 440,000 / 484,000
   *   Tax pool:             300,000 growing 10% -> 300,000 / 330,000 / 363,000
   *   Tenant share:         50,000 / 100,000 = 0.5
   *
   *   OPEX (expense stop 2.00/sf = 100,000, capped 5% a year):
   *     FY2026  200,000 - 100,000 = 100,000, first year so uncapped
   *     FY2027  220,000 - 100,000 = 120,000, ceiling 100,000 x 1.05 = 105,000
   *     FY2028  242,000 - 100,000 = 142,000, ceiling 105,000 x 1.05 = 110,250
   *
   *   TAX (triple net, uncapped):
   *     FY2026  150,000   FY2027  165,000   FY2028  181,500
   */
  it('settles each pool on its own terms and sums them', () => {
    expect(year(result, 2026).lines.expenseRecoveries).toBe('250000.00');
    expect(year(result, 2027).lines.expenseRecoveries).toBe('270000.00');
    expect(year(result, 2028).lines.expenseRecoveries).toBe('291750.00');
  });

  it('does not let one pool cap the other', () => {
    // The distinction the whole feature exists for. Merged into one capped
    // entitlement, FY2027 would be 250,000 x 1.05 = 262,500 and FY2028 would be
    // 275,625 — the taxes would have been capped by an operating-cost clause
    // that says nothing about them.
    expect(year(result, 2027).lines.expenseRecoveries).not.toBe('262500.00');

    const taxes = result.recoveryDetail.filter((row) => row.poolCode === 'TAX');
    expect(taxes.map((row) => row.capAdjustment)).toEqual(['0', '0', '0']);
    expect(Number(taxes.find((row) => row.fiscalYear === 2028)?.finalRecovery)).toBeCloseTo(
      181500,
      6,
    );
  });

  it('reports the cap it applied, on the pool it applied to', () => {
    const opex = result.recoveryDetail.filter((row) => row.poolCode === 'OPEX');
    expect(opex).toHaveLength(3);
    // FY2027: entitled to 120,000, capped to 105,000, so the adjustment is -15,000.
    expect(Number(opex.find((row) => row.fiscalYear === 2027)?.recoveryBeforeCaps)).toBeCloseTo(
      120000,
      6,
    );
    expect(Number(opex.find((row) => row.fiscalYear === 2027)?.capAdjustment)).toBeCloseTo(
      -15000,
      6,
    );
    expect(Number(opex.find((row) => row.fiscalYear === 2028)?.capAdjustment)).toBeCloseTo(
      -31750,
      6,
    );
  });

  it('names both pools in the detail, so the workings can be read apart', () => {
    const codes = [...new Set(result.recoveryDetail.map((row) => row.poolCode))].sort();
    expect(codes).toEqual(['OPEX', 'TAX']);
    expect(result.recoveryDetail.every((row) => row.poolName.length > 0)).toBe(true);
    // The full-service tenant still produces nothing.
    expect(result.recoveryDetail.some((row) => row.leaseId === 'L2')).toBe(false);
  });

  it('raises no critical error', () => {
    expect(result.diagnostics.filter((entry) => entry.severity === 'error')).toEqual([]);
  });
});

/* -------------------------------------------------------------------------- */

describe('Fixture 17: recoveries estimated on the prior year, reconciled in arrears', () => {
  const result = run(reconciledRecovery());

  /*
   * Derived by hand from the fixture.
   *
   *   Expense 500,000 growing 10%: 500,000 / 550,000 / 605,000 / 665,500.
   *   Sole tenant, triple net, so the settled entitlement equals the expense.
   *
   *   Estimated (prior year's settled amount; the first year has no prior year
   *   and falls back to its own):
   *     FY2026  500,000   FY2027  500,000   FY2028  550,000   FY2029  605,000
   *
   *   True-up (settled - estimated), billed three months after year end:
   *     FY2026        0
   *     FY2027   50,000 -> March 2028
   *     FY2028   55,000 -> March 2029
   *     FY2029   60,500 -> March 2030, beyond a 48-month forecast
   *
   *   Recovery revenue recognised:
   *     FY2026  500,000
   *     FY2027  500,000
   *     FY2028  550,000 + 50,000 = 600,000
   *     FY2029  605,000 + 55,000 = 660,000
   */
  it('bills the estimate during the year, not the settled amount', () => {
    expect(year(result, 2026).lines.expenseRecoveries).toBe('500000.00');
    expect(year(result, 2027).lines.expenseRecoveries).toBe('500000.00');
  });

  it('bills the shortfall in the month the reconciliation lands', () => {
    expect(year(result, 2028).lines.expenseRecoveries).toBe('600000.00');
    expect(year(result, 2029).lines.expenseRecoveries).toBe('660000.00');
  });

  it('puts the true-up in one month rather than spreading it', () => {
    // Period 27 is March 2028: the FY2028 estimate of 550,000/12 = 45,833.33,
    // plus the whole 50,000 owed for FY2027.
    // The monthly series is presented rounded to the currency's two decimals,
    // so the comparison is made at that precision rather than the engine's.
    const monthly = result.monthly.expenseRecoveries;
    expect(Number(monthly[26])).toBeCloseTo(95833.33, 2);
    expect(Number(monthly[25])).toBeCloseTo(45833.33, 2);
    expect(Number(monthly[27])).toBeCloseTo(45833.33, 2);
  });

  it('says so when a true-up falls beyond the forecast, rather than losing it', () => {
    const warning = result.diagnostics.find(
      (entry) => entry.code === 'RECONCILIATION_OUTSIDE_FORECAST',
    );
    expect(warning).toBeDefined();
    expect(warning?.severity).toBe('warning');
    expect(warning?.message).toContain('60500.00');
  });

  it('recognises everything settled except the true-up it warned about', () => {
    // Settled over four years: 500,000 + 550,000 + 605,000 + 665,500 = 2,320,500.
    // Recognised: 500,000 + 500,000 + 600,000 + 660,000 = 2,260,000.
    // The 60,500 difference is exactly the FY2029 true-up that fell outside.
    const recognised = [2026, 2027, 2028, 2029].reduce(
      (sum, fiscalYear) => sum + line(result, fiscalYear, 'expenseRecoveries'),
      0,
    );
    expect(recognised).toBeCloseTo(2260000, 4);

    const settled = result.recoveryDetail.reduce((sum, row) => sum + Number(row.finalRecovery), 0);
    expect(settled).toBeCloseTo(2320500, 4);
    expect(settled - recognised).toBeCloseTo(60500, 4);
  });

  it('publishes the estimate and the true-up separately', () => {
    const fy2027 = result.recoveryDetail.find((row) => row.fiscalYear === 2027);
    expect(Number(fy2027?.finalRecovery)).toBeCloseTo(550000, 6);
    expect(Number(fy2027?.estimatedRecovery)).toBeCloseTo(500000, 6);
    expect(Number(fy2027?.trueUpAmount)).toBeCloseTo(50000, 6);
    // Zero-based period 26 is the 27th month, March 2028.
    expect(fy2027?.trueUpPeriodIndex).toBe(26);

    const fy2029 = result.recoveryDetail.find((row) => row.fiscalYear === 2029);
    expect(Number(fy2029?.trueUpAmount)).toBeCloseTo(60500, 6);
    expect(fy2029?.trueUpPeriodIndex).toBeNull();
  });
});

/* -------------------------------------------------------------------------- */

describe('Fixture 18: a lease covering part of a space', () => {
  const result = run(partialSpaceRecovery());

  /*
   * 40,000 of a single 100,000 sqft space. Two different fractions are in play
   * and they must not be multiplied together:
   *
   *   pro-rata share  = 40,000 / 100,000 = 0.4  (of the property's expenses)
   *   share of space  = 40,000 / 100,000 = 0.4  (of the suite it sits on)
   *
   * Entitlement = 500,000 x 0.4 = 200,000, present all twelve months.
   * Physical occupancy = 0.4, because 60,000 of the floor is empty.
   */
  it('recovers the tenant’s pro-rata share, undiminished by its share of the space', () => {
    // Applying the area share twice would bill 200,000 x 0.4 = 80,000, which is
    // what versions 2.0.0 and 2.1.0 did.
    expect(year(result, 2026).lines.expenseRecoveries).toBe('200000.00');
  });

  it('still reports the floor as 40% occupied', () => {
    // The correction must not undo what 2.0.0 fixed: the 60,000 sqft the tenant
    // does not hold is vacant, and reporting the floor as full would overstate
    // occupancy and understate general vacancy.
    expect(Number(result.occupancy[0]?.physicalOccupancyPercent)).toBeCloseTo(0.4, 10);
    expect(Number(result.occupancy[0]?.occupiedArea)).toBeCloseTo(40000, 6);
  });

  it('reconciles to NOI', () => {
    // Base rent 40,000 x 20.00 = 800,000, plus 200,000 recovered, less 500,000.
    expect(year(result, 2026).lines.scheduledBaseRent).toBe('800000.00');
    expect(year(result, 2026).lines.netOperatingIncome).toBe('500000.00');
  });
});

/* -------------------------------------------------------------------------- */

describe('Fixture 19: a covenant breach that traps cash', () => {
  const trapped = run(cashTrapOnBreach());
  const untrapped = run(cashTrapDisabled());

  /*
   * 100,000 sqft at $6.00/sqft/yr is 600,000 of NOI with no expenses. A
   * 5,000,000 interest-only loan at 6% is 300,000 of annual debt service, so
   * the DSCR is exactly 2.0 — under the 3.0 the covenant requires. A rent step
   * to $12.00 from 2029 doubles NOI and takes the DSCR to 4.0, curing it.
   */
  it('leaves the property’s own performance untouched', () => {
    // The whole point: a trap moves cash, it does not change the asset. Every
    // operating line must be identical with the trigger on and off.
    for (const fiscalYear of [2026, 2028, 2030]) {
      expect(line(trapped, fiscalYear, 'netOperatingIncome')).toBeCloseTo(
        line(untrapped, fiscalYear, 'netOperatingIncome'),
        6,
      );
      expect(line(trapped, fiscalYear, 'unleveredCashFlow')).toBeCloseTo(
        line(untrapped, fiscalYear, 'unleveredCashFlow'),
        6,
      );
    }
  });

  it('withholds the surplus from equity while the covenant is breached', () => {
    // 600,000 of NOI less 300,000 of interest leaves 300,000 a year, and none
    // of it reaches equity while the loan is out of compliance.
    expect(line(untrapped, 2027, 'leveredCashFlow')).toBeCloseTo(300000, 2);
    expect(line(trapped, 2027, 'leveredCashFlow')).toBeCloseTo(0, 2);
    expect(line(trapped, 2027, 'restrictedCash')).toBeCloseTo(-300000, 2);
  });

  it('returns it once the covenant is met again', () => {
    // Nothing is kept. Over the whole forecast the restricted line nets to
    // zero: every pound trapped is a pound released.
    const total = trapped.annual.reduce((sum, row) => sum + Number(row.lines.restrictedCash), 0);
    expect(total).toBeCloseTo(0, 2);
  });

  it('lowers the levered return without lowering the property’s', () => {
    // Deferring cash cannot improve an internal rate of return, and the
    // unlevered return never sees the trap at all. This is the figure the
    // feature exists to correct: a model that reported the breach and
    // distributed the cash anyway overstated exactly these years.
    expect(Number(trapped.returns.leveredIrr)).toBeLessThan(Number(untrapped.returns.leveredIrr));
    expect(Number(trapped.returns.unleveredIrr)).toBeCloseTo(
      Number(untrapped.returns.unleveredIrr),
      10,
    );
  });

  it('says when the trap sprang and when it released', () => {
    const codes = trapped.diagnostics.map((entry) => entry.code);
    expect(codes).toContain('CASH_TRAP_SPRUNG');
    expect(codes).toContain('CASH_TRAP_RELEASED');
    // A trap nobody is told about is indistinguishable from a modelling error.
    const sprung = trapped.diagnostics.find((entry) => entry.code === 'CASH_TRAP_SPRUNG');
    expect(sprung?.severity).toBe('warning');
    expect(sprung?.message).toContain('withheld from equity');
  });

  it('reports nothing at all when the trigger is off', () => {
    const codes = untrapped.diagnostics.map((entry) => entry.code);
    expect(codes).not.toContain('CASH_TRAP_SPRUNG');
    for (const row of untrapped.annual) {
      expect(Number(row.lines.restrictedCash)).toBe(0);
    }
  });
});

/* -------------------------------------------------------------------------- */

describe('Fixture 20: development and refinance fee bases', () => {
  const result = run(sponsorFeeBases());

  /*
   * Capital spend is 100,000 a month for twelve months: 1,200,000, so a 4%
   * development fee is 48,000. The loan funds 2,000,000 at the start and draws
   * a further 1,000,000 in 2028; a 1% refinance fee is 10,000 on the second
   * draw only.
   *
   * Fees are paid out of equity cash flow, so they do not appear on a cash-flow
   * line — they show up as the difference between the property's levered return
   * and the equity holder's. The waterfall's contributions carry them.
   */
  it('charges the development fee as cost is incurred, not in a lump', () => {
    // The whole year-one spend attracts the fee; nothing afterwards does,
    // because nothing is spent afterwards.
    const spendYearOne = -line(result, 2026, 'capitalExpenditures');
    expect(spendYearOne).toBeCloseTo(1200000, 2);
    const spendYearTwo = -line(result, 2027, 'capitalExpenditures');
    expect(spendYearTwo).toBeCloseTo(0, 2);
  });

  it('raises no diagnostic saying the fee type is not modelled', () => {
    // Until now a development or refinance fee was silently not charged and
    // said so only in an informational diagnostic nobody reads.
    const notModelled = result.diagnostics.filter(
      (entry) => entry.code === 'FEE_TYPE_NOT_MODELLED',
    );
    expect(notModelled).toEqual([]);
  });

  it('takes exactly the fees out of what the partners receive', () => {
    /*
     * The same model with no fees at all is the control.
     *
     *   development  4% x 1,200,000 of capital spend = 48,000
     *   refinance    1% x 1,000,000 of the later draw = 10,000
     *                                                  ───────
     *                                                   58,000
     *
     * Sponsor fees are paid out of equity cash flow before the waterfall, so
     * the partnership is 58,000 worse off — but the two fees land differently,
     * and that difference is the point.
     *
     * The development fee falls in the construction months, when the deal is
     * already cash-negative. A fee charged against a deficit is not a smaller
     * distribution, it is a larger capital call: the partners fund it. So it
     * appears as 48,000 of extra contributions.
     *
     * The refinance fee falls in 2028, when the property is throwing off cash,
     * so it simply reduces what is distributed — 10,000 of it.
     *
     * Neither touches the property's own return: a sponsor fee is a
     * distribution of the deal's cash, not a cost of the building. The headline
     * levered figures are solved from levered cash flow, which is before fees,
     * so they are unchanged by design.
     */
    const base = sponsorFeeBases();
    const withoutFees = run({ ...base, equity: { ...base.equity, fees: [] } });

    const distributed = (model: typeof result): number =>
      model.waterfall.reduce((sum, partner) => sum + Number(partner.distributions), 0);
    const contributed = (model: typeof result): number =>
      model.waterfall.reduce((sum, partner) => sum + Number(partner.contributions), 0);

    expect(contributed(result) - contributed(withoutFees)).toBeCloseTo(48000, 2);
    expect(distributed(withoutFees) - distributed(result)).toBeCloseTo(10000, 2);

    // Together, exactly the 58,000 the sponsor is owed.
    const net = (model: typeof result): number => distributed(model) - contributed(model);
    expect(net(withoutFees) - net(result)).toBeCloseTo(58000, 2);

    expect(Number(result.returns.unleveredIrr)).toBeCloseTo(
      Number(withoutFees.returns.unleveredIrr),
      10,
    );
  });

  it('does not charge a refinance fee on the initial funding', () => {
    /*
     * The acquisition fee already covers putting the deal together. Charging
     * the refinance fee on the first draw as well would take 1% of 3,000,000
     * rather than of 1,000,000 — 30,000 instead of 10,000 — and would inflate
     * the sponsor's take on every model that never refinanced at all.
     *
     * Proved by removing the later draw: with no refinancing there should be no
     * refinance fee, so the equity multiple matches a model with no refinance
     * fee configured.
     */
    const base = sponsorFeeBases();
    const noRefinancing = {
      ...base,
      debt: base.debt.map((facility) => ({ ...facility, draws: [] })),
    };
    const withFee = run(noRefinancing);
    const withoutFee = run({
      ...noRefinancing,
      equity: {
        ...base.equity,
        fees: base.equity.fees.filter((fee) => fee.type !== 'refinance'),
      },
    });

    const distributed = (model: typeof result): number =>
      model.waterfall.reduce((sum, partner) => sum + Number(partner.distributions), 0);

    // No refinancing, so configuring the fee changes nothing at all.
    expect(distributed(withFee)).toBeCloseTo(distributed(withoutFee), 2);

    // And with the refinancing back, it is exactly 1% of the 1,000,000 drawn.
    const refinanced = run(base);
    const refinancedNoFee = run({
      ...base,
      equity: {
        ...base.equity,
        fees: base.equity.fees.filter((fee) => fee.type !== 'refinance'),
      },
    });
    expect(distributed(refinancedNoFee) - distributed(refinanced)).toBeCloseTo(10000, 2);
  });

  it('raises no critical error', () => {
    expect(result.diagnostics.filter((entry) => entry.severity === 'error')).toEqual([]);
  });
});

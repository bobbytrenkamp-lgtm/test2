import { describe, expect, it } from 'vitest';
import type { AnnualSummaryRow, CashFlowLine, ModelResult } from '@cre/domain-models';
import { calculate } from './engine.js';
import {
  ALL_FIXTURES,
  baseYearRecovery,
  expenseStopRecovery,
  floatingRateDebt,
  lpGpWaterfall,
  percentageRentProperty,
  refinanceScenario,
  singleTenantIndustrial,
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

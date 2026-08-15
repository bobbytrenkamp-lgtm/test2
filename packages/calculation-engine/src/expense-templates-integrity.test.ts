import { describe, expect, it } from 'vitest';
import Decimal from 'decimal.js';
import type { AnnualSummaryRow, CashFlowLine, ModelInput, ModelResult } from '@cre/domain-models';
import { calculate } from './engine.js';
import { buildModel } from './__fixtures__/builders.js';

/**
 * Numerical-integrity checks for the operating expense assumption library
 * (`docs/commercial-gap-analysis.md` item 13) at institutional scale.
 *
 * These are not new calculation *behaviour* — the expense library only adds
 * a way to seed an `operating_expenses` row from a reusable organization
 * template; `computeExpenseSeries` (`expenses.ts`) never reads
 * `sourceTemplateCode`/`sourceTemplateName` (`OperatingExpense` has no such
 * fields — provenance lives only on the API/DB row, never in `ModelInput`),
 * so a template-seeded expense and a hand-typed one with the same field
 * values are the same input to the engine by construction. What this file
 * checks instead is that expense arithmetic — the thing a template now makes
 * easy to reuse at scale across many models — holds exactly at the dollar
 * magnitudes a real institutional acquisition uses, with no native
 * floating-point money arithmetic anywhere on the path.
 *
 * Every expected value below is derived independently of the engine: by
 * closed-form arithmetic written out in the comments (exact fractions, not
 * `Math.pow`, which cannot represent 0.0375 exactly), or by re-deriving an
 * accounting identity from the engine's own line composition
 * (`engine.ts`) and asserting it holds on the engine's *output*, which is a
 * different check than asserting the output equals some pre-computed
 * number. `toBe` is used wherever the arithmetic is exact in decimal, never
 * `toBeCloseTo`, to allow zero cents of unexplained drift at these
 * magnitudes.
 */

const FIXED_CLOCK = '2026-01-01T00:00:00.000Z';

function run(input: ModelInput): ModelResult {
  return calculate(input, { calculatedAt: FIXED_CLOCK, trace: { enabled: false } });
}

function year(result: ModelResult, fiscalYear: number): AnnualSummaryRow {
  const row = result.annual.find((entry) => entry.fiscalYear === fiscalYear);
  if (!row) throw new Error(`Fiscal year ${fiscalYear} is not in the result`);
  return row;
}

function annualLine(result: ModelResult, fiscalYear: number, name: CashFlowLine): string {
  return year(result, fiscalYear).lines[name];
}

/* -------------------------------------------------------------------------- */
/* Math Check A - large fixed annual expense                                  */
/* -------------------------------------------------------------------------- */

describe('Math Check A: a large fixed-annual expense', () => {
  // $987,654,321,098.76/year, no growth, no revenue on the model at all, so
  // every dollar of NOI is this one expense's sign flipped.
  const model = buildModel({
    modelId: 'math-a',
    modelName: 'Math Check A fixture',
    forecast: {
      startDate: '2026-01-01',
      months: 12,
      fiscalYearStartMonth: 1,
      proration: 'actual_days',
    },
    property: { id: 'P1', name: 'Math A property', propertyType: 'office', rentableArea: '500000' },
    expenses: [
      {
        id: 'E1',
        name: 'Large fixed expense',
        category: 'operating',
        method: 'fixed_annual',
        amount: '987654321098.76',
        recoverableShare: '0',
        variableShare: '0',
      },
    ],
    valuation: {
      discountRate: '0.08',
      saleCostPercent: '0',
      directCapAdjustments: '0',
      acquisitionCosts: '0',
    },
  });
  const result = run(model);

  it('bills exactly one twelfth of the annual amount each month', () => {
    // 987,654,321,098.76 / 12 = 82,304,526,758.23 exactly (987,654,321,098.76
    // is an exact multiple of 12: 82,304,526,758.23 * 12 = 987,654,321,098.76).
    for (let i = 0; i < 12; i += 1) {
      expect(result.monthly.operatingExpenses[i]).toBe('-82304526758.23');
    }
  });

  it('sums to the exact annual amount, to the cent', () => {
    expect(annualLine(result, 2026, 'operatingExpenses')).toBe('-987654321098.76');
  });

  it('flows straight through to NOI and unlevered cash flow with no revenue to offset it', () => {
    expect(annualLine(result, 2026, 'netOperatingIncome')).toBe('-987654321098.76');
    expect(annualLine(result, 2026, 'unleveredCashFlow')).toBe('-987654321098.76');
  });
});

/* -------------------------------------------------------------------------- */
/* Math Check B - huge per-area expense                                       */
/* -------------------------------------------------------------------------- */

describe('Math Check B: a per-area expense on a huge property', () => {
  // area x rate = 125,000,000 x 123.456789 = 15,432,098,625 exactly:
  // 123,456,789 x 125 = 15,432,098,625 (123,456,789 x 100 = 12,345,678,900;
  // 123,456,789 x 25 = 3,086,419,725; sum = 15,432,098,625), and the /1,000,000
  // scale of the rate's six decimal places cancels exactly against
  // 125,000,000's six trailing zeros' worth of factors of 10.
  const model = buildModel({
    modelId: 'math-b',
    modelName: 'Math Check B fixture',
    forecast: {
      startDate: '2026-01-01',
      months: 12,
      fiscalYearStartMonth: 1,
      proration: 'actual_days',
    },
    property: {
      id: 'P1',
      name: 'Math B property',
      propertyType: 'industrial',
      rentableArea: '125000000',
    },
    // The engine derives the recovery/occupancy denominator (and, for
    // per_area_per_year expenses, ctx.rentableArea) from the space list, not
    // from property.rentableArea directly — see engine.ts's totalRentableArea.
    spaces: [{ id: 'S1', code: 'Building A', area: '125000000', spaceType: 'warehouse' }],
    expenses: [
      {
        id: 'E1',
        name: 'Huge per-area expense',
        category: 'operating',
        method: 'per_area_per_year',
        amount: '123.456789',
        recoverableShare: '0',
        variableShare: '0',
      },
    ],
    valuation: {
      discountRate: '0.08',
      saleCostPercent: '0',
      directCapAdjustments: '0',
      acquisitionCosts: '0',
    },
  });
  const result = run(model);

  it('derives the annual pool as area times rate, independently multiplied', () => {
    expect(annualLine(result, 2026, 'operatingExpenses')).toBe('-15432098625.00');
  });

  it('derives the monthly figure as the annual pool over twelve, exactly', () => {
    // 15,432,098,625 / 12 = 1,286,008,218.75 exactly (x 12 = 15,432,098,625).
    for (let i = 0; i < 12; i += 1) {
      expect(result.monthly.operatingExpenses[i]).toBe('-1286008218.75');
    }
  });
});

/* -------------------------------------------------------------------------- */
/* Math Check C - growth over multiple years                                  */
/* -------------------------------------------------------------------------- */

describe('Math Check C: growth compounding on a large starting expense', () => {
  // $400,000,000/year, growing 3.75% every forecast year from year 2 onward.
  // Year N = 400,000,000 x 1.0375^(N-1), computed here by hand as exact
  // fractions (0.0375 = 3/80) rather than by calling the engine's own
  // CurveSet.factors():
  //   Year 1: factor 1              -> 400,000,000.00
  //   Year 2: factor 1.0375         -> 415,000,000.00
  //   Year 3: factor 1.0375^2 = 1.07640625            -> 430,562,500.00
  //   Year 4: factor 1.0375^3 = 1.116771484375         -> 446,708,593.75
  //   Year 5: factor 1.0375^4 = 1.15865041503906250    -> 463,460,166.02 (rounds
  //     up from ...166.015625, more than halfway to the next cent)
  const model = buildModel({
    modelId: 'math-c',
    modelName: 'Math Check C fixture',
    forecast: {
      startDate: '2026-01-01',
      months: 60,
      fiscalYearStartMonth: 1,
      proration: 'actual_days',
    },
    property: { id: 'P1', name: 'Math C property', propertyType: 'office', rentableArea: '500000' },
    growthCurves: [{ id: 'G375', name: '3.75% growth', defaultRate: '0.0375' }],
    expenses: [
      {
        id: 'E1',
        name: 'Growing fixed expense',
        category: 'operating',
        method: 'fixed_annual',
        amount: '400000000',
        growthCurveId: 'G375',
        recoverableShare: '0',
        variableShare: '0',
      },
    ],
    valuation: {
      discountRate: '0.08',
      saleCostPercent: '0',
      directCapAdjustments: '0',
      acquisitionCosts: '0',
    },
  });
  const result = run(model);

  const expected: Record<number, string> = {
    2026: '-400000000.00',
    2027: '-415000000.00',
    2028: '-430562500.00',
    2029: '-446708593.75',
    2030: '-463460166.02',
  };

  it.each(Object.entries(expected))(
    'fiscal year %s matches the hand-derived compounding',
    (fy, value) => {
      expect(annualLine(result, Number(fy), 'operatingExpenses')).toBe(value);
    },
  );
});

/* -------------------------------------------------------------------------- */
/* Math Check D - recoverable/variable split at scale                         */
/* -------------------------------------------------------------------------- */

describe('Math Check D: recoverable and variable shares at scale', () => {
  // A single tenant occupies the whole 10,000,000 sf building at $20/sf/yr
  // triple net, so recovered dollars have a real revenue line to reconcile
  // against, not just an internal engine field.
  const model = buildModel({
    modelId: 'math-d',
    modelName: 'Math Check D fixture',
    forecast: {
      startDate: '2026-01-01',
      months: 12,
      fiscalYearStartMonth: 1,
      proration: 'actual_days',
    },
    property: {
      id: 'P1',
      name: 'Math D property',
      propertyType: 'industrial',
      rentableArea: '10000000',
    },
    spaces: [{ id: 'S1', code: 'Building A', area: '10000000', spaceType: 'warehouse' }],
    tenants: [{ id: 'T1', name: 'Scale Test Tenant', industry: 'Logistics' }],
    leases: [
      {
        id: 'L1',
        tenantId: 'T1',
        spaceIds: ['S1'],
        status: 'occupied',
        area: '10000000',
        commencementDate: '2026-01-01',
        expirationDate: '2035-12-31',
        baseRent: '20',
        baseRentBasis: 'per_area_per_year',
        recovery: { method: 'triple_net' },
        excludeFromRollover: true,
      },
    ],
    expenses: [
      {
        id: 'E1',
        name: 'Large partly-recoverable expense',
        category: 'operating',
        method: 'fixed_annual',
        amount: '600000000',
        recoverableShare: '0.8',
        variableShare: '0.3',
      },
    ],
    valuation: {
      discountRate: '0.08',
      saleCostPercent: '0',
      directCapAdjustments: '0',
      acquisitionCosts: '0',
    },
  });
  const result = run(model);

  it('bills the full gross expense — at 100% occupancy the fixed/variable split does not change the total', () => {
    // fixedShare (0.7) + variableShare (0.3) x occupancy (1) = 1, so the
    // occupancy adjustment is a no-op at full occupancy regardless of the split.
    expect(annualLine(result, 2026, 'operatingExpenses')).toBe('-600000000.00');
  });

  it('recovers exactly the recoverable share, sole tenant at 100% pro-rata', () => {
    // 600,000,000 x 0.8 = 480,000,000, and the sole tenant's pro-rata share
    // (10,000,000 / 10,000,000) is 1, with estimate = actual (no true-up).
    expect(annualLine(result, 2026, 'expenseRecoveries')).toBe('480000000.00');
  });

  it('reconciles recoverable + nonrecoverable to the gross expense, exactly', () => {
    const gross = new Decimal(annualLine(result, 2026, 'operatingExpenses')).abs();
    const recovered = new Decimal(annualLine(result, 2026, 'expenseRecoveries'));
    const nonrecoverable = gross.minus(recovered);
    // 600,000,000 - 480,000,000 = 120,000,000, the 20% nonrecoverable share.
    expect(nonrecoverable.toFixed(2)).toBe('120000000.00');
  });

  it('leaves NOI equal to base rent less the nonrecoverable share', () => {
    // Base rent 20 x 10,000,000 = 200,000,000; nonrecoverable is 120,000,000.
    // 200,000,000 - 120,000,000 = 80,000,000.
    expect(annualLine(result, 2026, 'scheduledBaseRent')).toBe('200000000.00');
    expect(annualLine(result, 2026, 'netOperatingIncome')).toBe('80000000.00');
  });
});

/* -------------------------------------------------------------------------- */
/* Math Check F - a very large complete acquisition                           */
/* -------------------------------------------------------------------------- */

/**
 * Builds a single-tenant, fully triple-net acquisition at an arbitrary
 * dollar/area scale, for both Math Check F (identities at one large scale)
 * and Math Check G (identities preserved across two different scales).
 */
function largeAcquisition(scale: number): ModelInput {
  const s = (n: number): string => new Decimal(n).times(scale).toFixed(6);
  return buildModel({
    modelId: `math-fg-${scale}`,
    modelName: `Large acquisition fixture (scale ${scale})`,
    forecast: {
      startDate: '2026-01-01',
      months: 36,
      fiscalYearStartMonth: 1,
      proration: 'actual_days',
    },
    property: {
      id: 'P1',
      name: 'Large acquisition property',
      propertyType: 'office',
      rentableArea: s(8000000),
    },
    spaces: [{ id: 'S1', code: 'Tower', area: s(8000000), spaceType: 'office' }],
    tenants: [{ id: 'T1', name: 'Large Acquisition Tenant', industry: 'Finance' }],
    leases: [
      {
        id: 'L1',
        tenantId: 'T1',
        spaceIds: ['S1'],
        status: 'occupied',
        area: s(8000000),
        commencementDate: '2026-01-01',
        expirationDate: '2035-12-31',
        baseRent: '50',
        baseRentBasis: 'per_area_per_year',
        recovery: { method: 'triple_net' },
        excludeFromRollover: true,
      },
    ],
    expenses: [
      {
        id: 'E1',
        name: 'Operating expenses',
        category: 'operating',
        method: 'fixed_annual',
        amount: s(150000000),
        recoverableShare: '1',
        variableShare: '0',
      },
    ],
    capital: [
      {
        id: 'C1',
        name: 'Capital improvements',
        category: 'building_improvement',
        method: 'one_time',
        amount: s(300000000),
        startDate: '2026-01-01',
      },
    ],
    debt: [
      {
        id: 'D1',
        name: 'Acquisition loan',
        type: 'bridge',
        commitment: s(4000000000),
        initialFunding: s(4000000000),
        fundingDate: '2026-01-01',
        rateType: 'fixed',
        fixedRate: '0.05',
        interestOnlyMonths: 36,
        amortizationMonths: 0,
        termMonths: 36,
        repayOnSale: true,
      },
    ],
    valuation: {
      discountRate: '0.08',
      terminalCapRate: '0.06',
      terminalNoiBasis: 'trailing_12',
      saleMonth: 36,
      saleCostPercent: '0.02',
      acquisitionPrice: s(6000000000),
      acquisitionCosts: '0',
      directCapAdjustments: '0',
    },
  });
}

describe('Math Check F: accounting identities on a multi-billion-dollar acquisition', () => {
  const result = run(largeAcquisition(1));

  it('NOI equals effective gross revenue plus operating expenses, every period', () => {
    for (const row of result.annual) {
      const egi = new Decimal(row.lines.effectiveGrossRevenue);
      const opex = new Decimal(row.lines.operatingExpenses);
      expect(egi.plus(opex).toFixed(2)).toBe(new Decimal(row.lines.netOperatingIncome).toFixed(2));
    }
  });

  it('unlevered cash flow equals NOI plus TI, LC and capital (all signed as stored)', () => {
    for (const row of result.annual) {
      const sum = [
        'netOperatingIncome',
        'tenantImprovements',
        'leasingCommissions',
        'capitalExpenditures',
      ].reduce((acc, key) => acc.plus(row.lines[key as CashFlowLine]), new Decimal(0));
      expect(sum.toFixed(2)).toBe(new Decimal(row.lines.unleveredCashFlow).toFixed(2));
    }
  });

  it('levered cash flow reconciles to unlevered cash flow plus every financing and disposition line', () => {
    for (const row of result.annual) {
      const sum = [
        'unleveredCashFlow',
        'debtProceeds',
        'interestExpense',
        'principalAmortization',
        'financingFees',
        'grossSaleProceeds',
        'sellingCosts',
        'debtPayoff',
        'restrictedCash',
      ].reduce((acc, key) => acc.plus(row.lines[key as CashFlowLine]), new Decimal(0));
      // Each addend on the right is itself independently rounded to the cent
      // before being reported (interest in particular is a repeating decimal —
      // an annual rate divided by 12 — rounded once as its own line), so
      // re-summing eight already-rounded lines can land a cent or two away
      // from the also-independently-rounded `leveredCashFlow` on the left.
      // `regression.test.ts` accepts the same one-decimal tolerance for the
      // equivalent NOI-composition identity, for the same reason.
      expect(sum.toNumber()).toBeCloseTo(Number(row.lines.leveredCashFlow), 1);
    }
  });

  it('net cash flow equals levered cash flow, every period', () => {
    for (const row of result.annual) {
      expect(row.lines.netCashFlow).toBe(row.lines.leveredCashFlow);
    }
  });

  it('the debt schedule rolls forward exactly: beginning + draws + capitalized interest - principal - payoff = ending', () => {
    const schedule = result.debtSchedules.find((s) => s.facilityId === 'D1');
    expect(schedule).toBeDefined();
    for (const row of schedule?.rows ?? []) {
      // A balloon/sale payoff (debt.ts's `payoff`) zeroes the balance without
      // being folded into the row's own `principal` column — it only shows up
      // as the model-level `debtPayoff` cash-flow line, so the roll-forward
      // has to pull it in from there by period.
      const payoffLine = result.monthly.debtPayoff[row.periodIndex - 1] ?? '0';
      const rolled = new Decimal(row.beginningBalance)
        .plus(row.draws)
        .plus(row.capitalizedInterest)
        .minus(row.principal)
        .plus(payoffLine); // negative when a payoff occurred
      expect(rolled.toFixed(6)).toBe(new Decimal(row.endingBalance).toFixed(6));
    }
  });

  it('has no NaN, Infinity or scientific-notation corruption anywhere in the annual output', () => {
    for (const row of result.annual) {
      for (const value of Object.values(row.lines)) {
        expect(value).not.toMatch(/[eE]/);
        expect(Number.isFinite(Number(value))).toBe(true);
      }
    }
  });
});

/* -------------------------------------------------------------------------- */
/* Math Check G - scale invariance                                            */
/* -------------------------------------------------------------------------- */

describe('Math Check G: scale invariance', () => {
  const base = run(largeAcquisition(1));
  const scaled = run(largeAcquisition(1000));

  const dollarLines: CashFlowLine[] = [
    'effectiveGrossRevenue',
    'operatingExpenses',
    'netOperatingIncome',
    'unleveredCashFlow',
    'leveredCashFlow',
  ];

  it('every dollar line scales by the multiplier, within the rounding a repeating-decimal quantity picks up at each scale', () => {
    // NOI's own base-rent component divides an annual figure by 12 (a
    // repeating decimal at $50/sf on 8,000,000 sf), and every monthly line is
    // reported already rounded to the cent. Multiplying the *base* scale's
    // rounded cents by 1,000 is not the same number as independently
    // computing and rounding the *scaled* run's own repeating decimal, so an
    // exact match is not the right check here — the two roundings can differ
    // by up to about half a cent on each side, i.e. up to roughly a cent
    // times the multiplier in the worst case. That bound (not an arbitrarily
    // loosened tolerance) is what is asserted below.
    const bound = 1000 * 0.01 + 0.01;
    for (const key of dollarLines) {
      base.monthly[key].forEach((value, i) => {
        const naiveScaled = new Decimal(value).times(1000);
        const actualScaled = new Decimal(scaled.monthly[key][i] as string);
        expect(actualScaled.minus(naiveScaled).abs().toNumber()).toBeLessThan(bound);
      });
    }
  });

  it('the debt schedule balances scale by exactly the multiplier (whole-dollar draws and balances, no repeating decimals involved)', () => {
    const baseSchedule = base.debtSchedules.find((s) => s.facilityId === 'D1');
    const scaledSchedule = scaled.debtSchedules.find((s) => s.facilityId === 'D1');
    expect(baseSchedule?.rows.length).toBe(scaledSchedule?.rows.length);
    baseSchedule?.rows.forEach((row, i) => {
      const expected = new Decimal(row.endingBalance).times(1000);
      const actual = new Decimal(scaledSchedule?.rows[i]?.endingBalance ?? '0');
      expect(actual.equals(expected)).toBe(true);
    });
  });

  it('rate-like outputs are scale-invariant: DSCR, IRR and the implied going-in cap rate are unchanged', () => {
    const baseSchedule = base.debtSchedules.find((s) => s.facilityId === 'D1');
    const scaledSchedule = scaled.debtSchedules.find((s) => s.facilityId === 'D1');
    baseSchedule?.rows.forEach((row, i) => {
      if (row.dscr === null) return;
      expect(Number(scaledSchedule?.rows[i]?.dscr)).toBeCloseTo(Number(row.dscr), 6);
    });

    expect(Number(scaled.returns.unleveredIrr)).toBeCloseTo(Number(base.returns.unleveredIrr), 8);
    expect(Number(scaled.returns.leveredIrr)).toBeCloseTo(Number(base.returns.leveredIrr), 8);

    const baseCapRate = Number(annualLine(base, 2026, 'netOperatingIncome')) / 6000000000;
    const scaledCapRate =
      Number(annualLine(scaled, 2026, 'netOperatingIncome')) / (6000000000 * 1000);
    expect(scaledCapRate).toBeCloseTo(baseCapRate, 10);
  });
});

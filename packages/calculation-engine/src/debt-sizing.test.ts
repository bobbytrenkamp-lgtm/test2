import { describe, expect, it } from 'vitest';
import { d } from './decimal.js';
import { levelPayment } from './debt.js';
import { loanAmountForPayment, sizeLoan } from './debt-sizing.js';

/**
 * Expected values are computed independently of `sizeLoan` — plain arithmetic
 * for the value-basis constraints (LTV, LTC, debt yield), and `Math.pow` for
 * the DSCR constraint's level-payment inversion, never the engine's own
 * output.
 */

describe('loanAmountForPayment', () => {
  it('is the exact algebraic inverse of levelPayment', () => {
    // If P produces payment pmt at rate r over n months, then pmt must
    // produce P back. True for any principal, rate and term — a mathematical
    // identity, not a fixture-specific number — so it is checked across
    // several combinations rather than one.
    const cases: Array<{ principal: string; rate: string; months: number }> = [
      { principal: '1000000', rate: '0.005', months: 360 },
      { principal: '5500000', rate: '0.0075', months: 120 },
      { principal: '250000', rate: '0.004166666667', months: 60 },
    ];
    for (const { principal, rate, months } of cases) {
      const payment = levelPayment(d(principal), d(rate), months);
      const recovered = loanAmountForPayment(payment, d(rate), months);
      expect(recovered.toDecimalPlaces(6).toNumber()).toBeCloseTo(Number(principal), 4);
    }
  });

  it('reduces to payment times months when the rate is zero, matching levelPayment', () => {
    // levelPayment(P, 0, n) = P/n, so its own inverse is pmt * n.
    const payment = levelPayment(d('120000'), d('0'), 24);
    expect(payment.toString()).toBe('5000');
    expect(loanAmountForPayment(payment, d('0'), 24).toString()).toBe('120000');
  });

  it('is zero for a non-positive term, the same boundary levelPayment itself uses', () => {
    expect(loanAmountForPayment(d('1000'), d('0.005'), 0).toString()).toBe('0');
  });
});

describe('sizeLoan', () => {
  it('sizes to the LTV constraint alone', () => {
    const result = sizeLoan({
      sizingNoi: '1000000',
      propertyValue: '10000000',
      annualRate: '0.06',
      amortizationMonths: 360,
      maximumLtv: '0.65',
    });
    // Hand-derived: 10,000,000 x 0.65 = 6,500,000, the only constraint given.
    expect(result.sizedAmount).toBe('6500000');
    expect(result.bindingConstraints).toEqual(['maximum_ltv']);
    expect(result.constraints).toHaveLength(1);
  });

  it('sizes to the LTC constraint alone', () => {
    const result = sizeLoan({
      sizingNoi: '1000000',
      totalCost: '9000000',
      annualRate: '0.06',
      amortizationMonths: 360,
      maximumLtc: '0.70',
    });
    // Hand-derived: 9,000,000 x 0.70 = 6,300,000.
    expect(result.sizedAmount).toBe('6300000');
    expect(result.bindingConstraints).toEqual(['maximum_ltc']);
  });

  it('sizes to the debt yield constraint alone', () => {
    const result = sizeLoan({
      sizingNoi: '1000000',
      annualRate: '0.06',
      amortizationMonths: 360,
      minimumDebtYield: '0.08',
    });
    // Hand-derived: 1,000,000 / 0.08 = 12,500,000.
    expect(result.sizedAmount).toBe('12500000');
    expect(result.bindingConstraints).toEqual(['minimum_debt_yield']);
  });

  it('sizes to the DSCR constraint, amortizing, checked against an independent Math.pow annuity', () => {
    // Hand-derived: max annual debt service = 1,000,000 / 1.25 = 800,000,
    // max monthly payment = 66,666.6667. At 6% (monthly rate 0.005) over 360
    // months, the loan a level payment of that size supports is
    // pmt x (1 - (1+r)^-n) / r, computed here with Math.pow rather than
    // decimal.js so the check does not share code with the implementation.
    const result = sizeLoan({
      sizingNoi: '1000000',
      annualRate: '0.06',
      amortizationMonths: 360,
      minimumDscr: '1.25',
    });
    const maxMonthlyPayment = 1_000_000 / 1.25 / 12;
    const monthlyRate = 0.06 / 12;
    const expected = (maxMonthlyPayment * (1 - Math.pow(1 + monthlyRate, -360))) / monthlyRate;
    expect(result.bindingConstraints).toEqual(['minimum_dscr']);
    expect(Number(result.sizedAmount)).toBeCloseTo(expected, 0);
  });

  it('sizes to the DSCR constraint, interest-only, as pure debt service over rate', () => {
    // Hand-derived: an interest-only loan's "payment" is pure interest, so
    // the DSCR constraint reduces to maxAnnualDebtService / annualRate with
    // no level-payment inversion at all: 800,000 / 0.05 = 16,000,000.
    const result = sizeLoan({
      sizingNoi: '1000000',
      annualRate: '0.05',
      amortizationMonths: 0,
      minimumDscr: '1.25',
    });
    expect(result.sizedAmount).toBe('16000000');
    expect(result.bindingConstraints).toEqual(['minimum_dscr']);
  });

  it('sizes to the smallest of several active constraints, and names the one that binds', () => {
    // LTV -> 6,500,000; LTC -> 6,300,000; debt yield -> 12,500,000;
    // DSCR (interest-only, 5%) -> 16,000,000. The smallest, 6,300,000, is
    // the LTC constraint — the others would each individually allow more.
    const result = sizeLoan({
      sizingNoi: '1000000',
      propertyValue: '10000000',
      totalCost: '9000000',
      annualRate: '0.05',
      amortizationMonths: 0,
      minimumDscr: '1.25',
      maximumLtv: '0.65',
      maximumLtc: '0.70',
      minimumDebtYield: '0.08',
    });
    expect(result.sizedAmount).toBe('6300000');
    expect(result.bindingConstraints).toEqual(['maximum_ltc']);
    expect(result.constraints).toHaveLength(4);
  });

  it('names every constraint that ties at the sized amount', () => {
    // LTV: 10,000,000 x 0.5 = 5,000,000. Debt yield: 1,000,000 / 0.20 =
    // 5,000,000. Both constraints independently land on the same figure.
    const result = sizeLoan({
      sizingNoi: '1000000',
      propertyValue: '10000000',
      annualRate: '0.05',
      amortizationMonths: 0,
      maximumLtv: '0.5',
      minimumDebtYield: '0.20',
    });
    expect(result.sizedAmount).toBe('5000000');
    expect(result.bindingConstraints).toEqual(['maximum_ltv', 'minimum_debt_yield']);
  });

  it('skips a value-basis constraint whose paired value is not supplied', () => {
    // maximumLtv is given, but propertyValue is not: LTV cannot be evaluated
    // without a value to apply it to, so it is left out entirely rather than
    // silently sized against a missing (zero) value.
    const result = sizeLoan({
      sizingNoi: '1000000',
      annualRate: '0.06',
      amortizationMonths: 360,
      maximumLtv: '0.65',
      minimumDebtYield: '0.08',
    });
    expect(result.constraints.map((c) => c.constraint)).toEqual(['minimum_debt_yield']);
    expect(result.sizedAmount).toBe('12500000');
  });

  it('returns null with no constraints when none are supplied', () => {
    const result = sizeLoan({
      sizingNoi: '1000000',
      annualRate: '0.06',
      amortizationMonths: 360,
    });
    expect(result.sizedAmount).toBeNull();
    expect(result.constraints).toEqual([]);
    expect(result.bindingConstraints).toEqual([]);
  });
});

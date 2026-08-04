import { describe, expect, it } from 'vitest';
import { Decimal, d } from './decimal.js';
import { parseDate } from './calendar.js';
import {
  breakevenOccupancy,
  discountFactor,
  discountFactors,
  equityMultiple,
  irrMonthly,
  npvMonthly,
  xirr,
} from './metrics.js';
import { levelPayment } from './debt.js';

/**
 * Expected values here are computed from the closed-form definitions of each
 * formula, independently of the implementation under test.
 */

describe('discounting', () => {
  it('discounts an annual effective rate by the monthly exponent', () => {
    // Month 12 at 8% annual effective discounts by exactly 1/1.08.
    expect(discountFactor(d('0.08'), 12).toFixed(12)).toBe((1 / 1.08).toFixed(12));
    // Month 6 discounts by 1.08^(-0.5).
    expect(discountFactor(d('0.08'), 6).toFixed(12)).toBe(Math.pow(1.08, -0.5).toFixed(12));
  });

  it('applies mid-period discounting half a month earlier', () => {
    expect(discountFactor(d('0.08'), 12, 'mid_period').toFixed(12)).toBe(
      Math.pow(1.08, -11.5 / 12).toFixed(12),
    );
  });
});

describe('the batched discount factor series', () => {
  /**
   * `discountFactors` exists because taking a fractional power per period made
   * the engine roughly twenty times slower than it needed to be.
   *
   * The substitution is only safe if the two agree far beyond any precision the
   * platform reports at, so that is asserted to 28 decimal places rather than
   * left as "close enough". They are **not** bit-identical at all 34 significant
   * digits — repeated multiplication and a direct power differ in the last digit
   * or two — which is why the change carried an engine version bump. See
   * `metrics.ts` and the 2.1.0 note in `engine.ts`.
   */
  for (const convention of ['end_of_period', 'mid_period'] as const) {
    it(`matches the per-period factor to 28 decimal places, ${convention}`, () => {
      const rate = d('0.0825');
      const batched = discountFactors(rate, 120, convention);
      for (let i = 0; i < 120; i += 1) {
        expect((batched[i] as Decimal).toFixed(28)).toBe(
          discountFactor(rate, i + 1, convention).toFixed(28),
        );
      }
    });
  }

  it('matches at a rate of zero, where every factor is one', () => {
    const factors = discountFactors(d('0'), 5);
    for (const factor of factors) expect(factor.toFixed(20)).toBe('1.00000000000000000000');
  });

  it('returns zero factors for a rate that would make the base non-positive', () => {
    // A discount rate of -100% or worse has no meaningful factor; returning
    // zero keeps the caller from raising a negative number to a fraction.
    const factors = discountFactors(d('-1'), 3);
    expect(factors.map((factor) => factor.toString())).toEqual(['0', '0', '0']);
  });
});

describe('net present value', () => {
  it('matches a closed-form geometric annuity', () => {
    // 24 monthly payments of 1,000 discounted at 6% annual effective.
    const flows = Array.from({ length: 24 }, () => d('1000'));
    const v = Math.pow(1.06, -1 / 12);
    // Sum of v^1..v^24 = v(1 - v^24)/(1 - v).
    const expected = 1000 * ((v * (1 - Math.pow(v, 24))) / (1 - v));
    const actual = npvMonthly(flows, d('0.06'));
    expect(Number(actual.toFixed(6))).toBeCloseTo(expected, 4);
  });

  it('returns the undiscounted sum at a zero rate', () => {
    const flows = [d('100'), d('200'), d('300')];
    expect(npvMonthly(flows, d('0')).toString()).toBe('600');
  });
});

describe('internal rate of return', () => {
  it('recovers a known rate from a single-period investment', () => {
    // Pay 100 now, receive 110 in twelve months: 10% annual effective.
    const flows = Array.from({ length: 12 }, (_, i) => (i === 11 ? d('110') : d('0')));
    const irr = irrMonthly(flows, d('-100'));
    expect(irr).not.toBeNull();
    expect(Number((irr as Decimal).toFixed(8))).toBeCloseTo(0.1, 6);
  });

  it('drives net present value to zero at the solved rate', () => {
    const flows = [d('-500'), d('80'), d('90'), d('120'), d('700')];
    const irr = irrMonthly(flows, d('-1000'));
    expect(irr).not.toBeNull();
    const npv = npvMonthly(flows, irr as Decimal, 'end_of_period', d('-1000'));
    expect(Number(npv.toFixed(4))).toBeCloseTo(0, 3);
  });

  it('returns null when the cash flows never change sign', () => {
    expect(irrMonthly([d('10'), d('20')], d('30'))).toBeNull();
    expect(irrMonthly([d('-10'), d('-20')], d('-30'))).toBeNull();
  });
});

describe('xirr', () => {
  it('recovers a known rate over an exact 365-day year', () => {
    const flows = [
      { date: parseDate('2026-01-01'), amount: d('-1000') },
      { date: parseDate('2027-01-01'), amount: d('1120') },
    ];
    const rate = xirr(flows);
    expect(rate).not.toBeNull();
    // 2026 is not a leap year, so the span is exactly 365 days: 12%.
    expect(Number((rate as Decimal).toFixed(8))).toBeCloseTo(0.12, 6);
  });

  it('counts the leap day in the day difference', () => {
    const flows = [
      { date: parseDate('2024-01-01'), amount: d('-1000') },
      { date: parseDate('2025-01-01'), amount: d('1120') },
    ];
    const rate = xirr(flows) as Decimal;
    // 366 days at a 365-day basis makes the annualised rate slightly lower.
    expect(Number(rate.toFixed(8))).toBeLessThan(0.12);
    expect(Number(rate.toFixed(8))).toBeCloseTo(Math.pow(1.12, 365 / 366) - 1, 6);
  });
});

describe('equity multiple', () => {
  it('divides total distributions by total contributions', () => {
    const flows = [d('-1000'), d('100'), d('100'), d('1600')];
    expect((equityMultiple(flows) as Decimal).toString()).toBe('1.8');
  });

  it('is null with no contributions', () => {
    expect(equityMultiple([d('100'), d('200')])).toBeNull();
  });
});

describe('level payment', () => {
  it('matches the standard annuity payment formula', () => {
    // 1,000,000 at 6% nominal (0.5% monthly) over 360 months.
    const payment = levelPayment(d('1000000'), d('0.06').dividedBy(12), 360);
    const r = 0.06 / 12;
    const expected = (1000000 * r) / (1 - Math.pow(1 + r, -360));
    expect(Number(payment.toFixed(6))).toBeCloseTo(expected, 4);
    // Cross-check against the widely published figure for these terms.
    expect(Number(payment.toFixed(2))).toBeCloseTo(5995.51, 2);
  });

  it('divides evenly at a zero rate', () => {
    expect(levelPayment(d('1200'), d('0'), 12).toString()).toBe('100');
  });
});

describe('breakeven occupancy', () => {
  it('is the share of potential revenue absorbed by expenses and debt service', () => {
    const result = breakevenOccupancy(d('1000000'), d('400000'), d('350000'));
    expect((result as Decimal).toString()).toBe('0.75');
  });
});

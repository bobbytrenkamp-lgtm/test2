import { Decimal, ONE, TWELVE, ZERO, d } from './decimal.js';
import { type CalendarDate, toEpochDay } from './calendar.js';

/**
 * Return metrics. Formulas are documented in
 * docs/calculation-specification.md; each function here is the single
 * implementation the whole platform uses.
 */

/**
 * Net present value of a monthly cash-flow series at an annual effective rate.
 *
 * Period i (1-based) is discounted by (1 + r)^(-i/12) for end-of-period
 * discounting or (1 + r)^(-(i - 0.5)/12) for mid-period. A monthly exponent of
 * an annual rate is used rather than r/12 so that the stated discount rate is
 * an annual effective rate, consistent with how the exit capitalisation rate
 * and the IRR are quoted.
 */
export function npvMonthly(
  cashFlows: Decimal[],
  annualRate: Decimal,
  convention: 'end_of_period' | 'mid_period' = 'end_of_period',
  /** Cash flow occurring at time zero, undiscounted. */
  initial: Decimal = ZERO,
): Decimal {
  const factors = discountFactors(annualRate, cashFlows.length, convention);
  let total = initial;
  for (let i = 0; i < cashFlows.length; i += 1) {
    total = total.plus((cashFlows[i] as Decimal).times(factors[i] as Decimal));
  }
  return total;
}

/** Twenty-four: a half-month step expressed against an annual rate. */
const TWENTY_FOUR = new Decimal(24);
/** XIRR's year basis: actual days over a fixed 365, as the spreadsheet does. */
const DAYS_PER_YEAR = new Decimal(365);

/**
 * The whole series of discount factors, in one pass.
 *
 * A factor is `(1 + r)^(-i/12)`, a **fractional** power. decimal.js evaluates
 * those through a natural logarithm and an exponential at full precision, which
 * is by far the most expensive operation in the engine — and the naive loop
 * calls it once per period. Since `(1 + r)^(-i/12)` is just `f^i` where
 * `f = (1 + r)^(-1/12)`, the fractional power need only be taken once and the
 * rest of the series follows by multiplication.
 *
 * That matters far more than it looks. `irrMonthly` evaluates an NPV on every
 * one of its 200 bisection steps, so a 120-month model went from 24,000
 * fractional powers per IRR to 200. Measured on the benchmark, a single-tenant
 * ten-year model fell from roughly 2.4 seconds to well under a tenth of that.
 *
 * Mid-period discounting shifts every factor by half a month, which is one
 * further fractional power for the whole series rather than one per period.
 *
 * ## On precision, stated exactly
 *
 * A single factor from here agrees with the direct power to at least 28 decimal
 * places, which `metrics.test.ts` asserts. Every figure the platform reports —
 * money to the cent, rates to their stated precision — is unchanged, and the
 * regression fixtures, which assert exact strings, all pass.
 *
 * It is **not** bit-identical at full precision. Repeated multiplication and a
 * direct power differ in the last digit or two of 34, and downstream arithmetic
 * carries that into fields the result serialises untruncated, such as a loan-to
 * -value ratio. A result stored by an earlier build therefore will not compare
 * byte-for-byte against a recalculation by this one. That is why this arrived
 * with an engine version bump rather than quietly: reproducing a stored
 * valuation exactly is a promise the platform makes, and it is kept per engine
 * version, not across them.
 */
export function discountFactors(
  annualRate: Decimal,
  count: number,
  convention: 'end_of_period' | 'mid_period' = 'end_of_period',
): Decimal[] {
  const base = ONE.plus(annualRate);
  if (base.lessThanOrEqualTo(0)) return new Array<Decimal>(count).fill(ZERO);

  const monthly = base.pow(ONE.dividedBy(TWELVE).negated());
  // Mid-period sits half a month earlier, so it is discounted half a month less.
  const midShift = convention === 'mid_period' ? base.pow(ONE.dividedBy(TWENTY_FOUR)) : ONE;

  const factors: Decimal[] = [];
  let compounded = ONE;
  for (let i = 0; i < count; i += 1) {
    compounded = compounded.times(monthly);
    factors.push(convention === 'mid_period' ? compounded.times(midShift) : compounded);
  }
  return factors;
}

export function discountFactor(
  annualRate: Decimal,
  periodIndex: number,
  convention: 'end_of_period' | 'mid_period' = 'end_of_period',
): Decimal {
  const exponent =
    convention === 'mid_period' ? new Decimal(periodIndex).minus('0.5') : new Decimal(periodIndex);
  const base = ONE.plus(annualRate);
  if (base.lessThanOrEqualTo(0)) return ZERO;
  return base.pow(exponent.dividedBy(12).negated());
}

const IRR_TOLERANCE = new Decimal('1e-9');
const IRR_MAX_ITERATIONS = 200;

/**
 * Internal rate of return for a monthly series, expressed as an annual
 * effective rate. Solved by bisection over a wide bracket rather than by
 * Newton's method: bisection cannot diverge, and a deterministic fixed
 * iteration count keeps the result reproducible across platforms.
 *
 * Returns null when the cash flows never change sign, since no rate solves it.
 */
export function irrMonthly(cashFlows: Decimal[], initial: Decimal = ZERO): Decimal | null {
  const all = [initial, ...cashFlows];
  const hasPositive = all.some((v) => v.greaterThan(0));
  const hasNegative = all.some((v) => v.lessThan(0));
  if (!hasPositive || !hasNegative) return null;

  const f = (rate: Decimal): Decimal => npvMonthly(cashFlows, rate, 'end_of_period', initial);

  let low = new Decimal('-0.9999');
  let high = new Decimal('100');
  let fLow = f(low);
  let fHigh = f(high);
  if (fLow.times(fHigh).greaterThan(0)) return null;

  for (let i = 0; i < IRR_MAX_ITERATIONS; i += 1) {
    const mid = low.plus(high).dividedBy(2);
    const fMid = f(mid);
    if (fMid.abs().lessThan(IRR_TOLERANCE) || high.minus(low).lessThan(IRR_TOLERANCE)) {
      return mid;
    }
    if (fLow.times(fMid).lessThan(0)) {
      high = mid;
      fHigh = fMid;
    } else {
      low = mid;
      fLow = fMid;
    }
  }
  return low.plus(high).dividedBy(2);
}

export interface DatedCashFlow {
  date: CalendarDate;
  amount: Decimal;
}

/**
 * XIRR: annual effective rate that discounts dated cash flows to zero, using
 * actual day counts on a 365-day year. Leap days are counted in the day
 * difference but the year basis stays at 365, which is the convention the
 * spreadsheet function of the same name uses.
 */
export function xirr(flows: DatedCashFlow[]): Decimal | null {
  if (flows.length < 2) return null;
  const sorted = [...flows].sort((a, b) => toEpochDay(a.date) - toEpochDay(b.date));
  const start = toEpochDay((sorted[0] as DatedCashFlow).date);
  const hasPositive = sorted.some((f) => f.amount.greaterThan(0));
  const hasNegative = sorted.some((f) => f.amount.lessThan(0));
  if (!hasPositive || !hasNegative) return null;

  // Day offsets do not depend on the rate, so they are computed once rather
  // than on all 200 bisection steps.
  const offsets = sorted.map((flow) => toEpochDay(flow.date) - start);

  const f = (rate: Decimal): Decimal => {
    const base = ONE.plus(rate);
    if (base.lessThanOrEqualTo(0)) return new Decimal('1e30');

    // `base^(-days/365)` is `(base^(-1/365))^days`. The fractional power — the
    // expensive one, evaluated through a logarithm and an exponential — is
    // therefore taken once per rate rather than once per cash flow.
    const daily = base.pow(ONE.dividedBy(DAYS_PER_YEAR).negated());

    // The remaining exponent is a whole number of days, but raising to it
    // directly still costs a repeated squaring per flow. The flows are sorted,
    // so each one is only a few weeks further out than the last: carrying the
    // running factor forward and multiplying by the gap turns the whole series
    // into one multiplication each. A monthly series has only a handful of
    // distinct gaps — the lengths of a month — so those are computed once.
    const gapFactors = new Map<number, Decimal>();
    let carried = ONE;
    let carriedOffset = 0;
    let total = ZERO;

    for (let i = 0; i < sorted.length; i += 1) {
      const offset = offsets[i] as number;
      const gap = offset - carriedOffset;
      if (gap > 0) {
        let factor = gapFactors.get(gap);
        if (!factor) {
          factor = daily.pow(gap);
          gapFactors.set(gap, factor);
        }
        carried = carried.times(factor);
        carriedOffset = offset;
      }
      total = total.plus((sorted[i] as DatedCashFlow).amount.times(carried));
    }
    return total;
  };

  let low = new Decimal('-0.9999');
  let high = new Decimal('100');
  let fLow = f(low);
  if (fLow.times(f(high)).greaterThan(0)) return null;

  for (let i = 0; i < IRR_MAX_ITERATIONS; i += 1) {
    const mid = low.plus(high).dividedBy(2);
    const fMid = f(mid);
    if (fMid.abs().lessThan(IRR_TOLERANCE) || high.minus(low).lessThan(IRR_TOLERANCE)) return mid;
    if (fLow.times(fMid).lessThan(0)) {
      high = mid;
    } else {
      low = mid;
      fLow = fMid;
    }
  }
  return low.plus(high).dividedBy(2);
}

/**
 * Equity multiple: total distributions divided by total contributions.
 * Contributions are the negative flows; distributions the positive ones.
 */
export function equityMultiple(cashFlows: Decimal[]): Decimal | null {
  let contributions = ZERO;
  let distributions = ZERO;
  for (const flow of cashFlows) {
    if (flow.lessThan(0)) contributions = contributions.plus(flow.negated());
    else distributions = distributions.plus(flow);
  }
  if (contributions.isZero()) return null;
  return distributions.dividedBy(contributions);
}

/** Sum of an array, for readability at call sites. */
export function total(values: Decimal[]): Decimal {
  return values.reduce((acc, v) => acc.plus(v), ZERO);
}

/** Sum of a slice [from, to) of a series. */
export function slice(values: Decimal[], from: number, to: number): Decimal {
  let out = ZERO;
  for (let i = Math.max(0, from); i < Math.min(values.length, to); i += 1) {
    out = out.plus(values[i] as Decimal);
  }
  return out;
}

/**
 * Breakeven occupancy: the physical occupancy at which effective gross revenue
 * exactly covers operating expenses plus debt service.
 * (operating expenses + debt service) / gross potential revenue.
 */
export function breakevenOccupancy(
  grossPotentialRevenue: Decimal,
  operatingExpenses: Decimal,
  debtService: Decimal,
): Decimal | null {
  if (grossPotentialRevenue.isZero()) return null;
  return operatingExpenses.plus(debtService).dividedBy(grossPotentialRevenue);
}

export function safeDivide(numerator: Decimal, denominator: Decimal): Decimal | null {
  if (denominator.isZero()) return null;
  return numerator.dividedBy(denominator);
}

export function toStringOrNull(value: Decimal | null): string | null {
  return value === null ? null : value.toString();
}

export { d, ZERO, ONE };

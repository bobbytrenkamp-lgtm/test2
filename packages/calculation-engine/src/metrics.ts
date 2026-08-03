import { Decimal, ONE, ZERO, d } from './decimal.js';
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
  let total = initial;
  for (let i = 0; i < cashFlows.length; i += 1) {
    total = total.plus((cashFlows[i] as Decimal).times(discountFactor(annualRate, i + 1, convention)));
  }
  return total;
}

export function discountFactor(
  annualRate: Decimal,
  periodIndex: number,
  convention: 'end_of_period' | 'mid_period' = 'end_of_period',
): Decimal {
  const exponent = convention === 'mid_period' ? new Decimal(periodIndex).minus('0.5') : new Decimal(periodIndex);
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
export function irrMonthly(
  cashFlows: Decimal[],
  initial: Decimal = ZERO,
): Decimal | null {
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

  const f = (rate: Decimal): Decimal => {
    const base = ONE.plus(rate);
    if (base.lessThanOrEqualTo(0)) return new Decimal('1e30');
    let total = ZERO;
    for (const flow of sorted) {
      const years = new Decimal(toEpochDay(flow.date) - start).dividedBy(365);
      total = total.plus(flow.amount.times(base.pow(years.negated())));
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

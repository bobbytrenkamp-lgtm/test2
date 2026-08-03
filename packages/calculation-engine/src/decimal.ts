import Decimal from 'decimal.js';

/**
 * All engine arithmetic runs through decimal.js with a fixed configuration.
 *
 * 34 significant digits comfortably covers portfolio-scale currency amounts
 * while leaving room for the intermediate division that discounting and
 * pro-rata allocation require. ROUND_HALF_EVEN is used for intermediate work so
 * that long additive chains do not drift upward; presentation rounding to two
 * decimals happens only at the boundary of the engine.
 */
Decimal.set({
  precision: 34,
  rounding: Decimal.ROUND_HALF_EVEN,
  toExpNeg: -30,
  toExpPos: 30,
});

export { Decimal };

export const ZERO = new Decimal(0);
export const ONE = new Decimal(1);
export const TWELVE = new Decimal(12);

export type DecimalInput = Decimal | string | number | null | undefined;

/** Coerces any accepted representation into a Decimal, treating null as zero. */
export function d(value: DecimalInput): Decimal {
  if (value === null || value === undefined || value === '') return ZERO;
  if (value instanceof Decimal) return value;
  return new Decimal(value);
}

/** Currency rounding: 2 decimal places, half-even. */
export function money(value: DecimalInput): Decimal {
  return d(value).toDecimalPlaces(2, Decimal.ROUND_HALF_EVEN);
}

/** Serialises a value for transport as a fixed 2-decimal currency string. */
export function moneyString(value: DecimalInput): string {
  return money(value).toFixed(2);
}

/** Serialises a rate or ratio with 8 decimal places of resolution. */
export function rateString(value: DecimalInput): string {
  return d(value).toDecimalPlaces(8, Decimal.ROUND_HALF_EVEN).toFixed(8);
}

/** Serialises an area with 4 decimal places. */
export function areaString(value: DecimalInput): string {
  return d(value).toDecimalPlaces(4, Decimal.ROUND_HALF_EVEN).toFixed(4);
}

export function sum(values: Iterable<DecimalInput>): Decimal {
  let total = ZERO;
  for (const v of values) total = total.plus(d(v));
  return total;
}

/** Element-wise addition of two equal-length series. */
export function addSeries(a: Decimal[], b: Decimal[]): Decimal[] {
  return a.map((v, i) => v.plus(b[i] ?? ZERO));
}

/** Allocates `total` across `weights` so the parts sum exactly back to total. */
export function allocate(total: Decimal, weights: Decimal[]): Decimal[] {
  const weightTotal = sum(weights);
  if (weightTotal.isZero()) return weights.map(() => ZERO);
  const raw = weights.map((w) => total.times(w).dividedBy(weightTotal));
  const rounded = raw.map((v) => money(v));
  const drift = money(total).minus(sum(rounded));
  if (!drift.isZero() && rounded.length > 0) {
    // Push any rounding residual onto the largest share so the parts reconcile.
    let largest = 0;
    for (let i = 1; i < rounded.length; i += 1) {
      if ((rounded[i] as Decimal).greaterThan(rounded[largest] as Decimal)) largest = i;
    }
    rounded[largest] = (rounded[largest] as Decimal).plus(drift);
  }
  return rounded;
}

export function zeros(length: number): Decimal[] {
  return Array.from({ length }, () => ZERO);
}

export function maxOf(a: Decimal, b: Decimal): Decimal {
  return a.greaterThan(b) ? a : b;
}

export function minOf(a: Decimal, b: Decimal): Decimal {
  return a.lessThan(b) ? a : b;
}

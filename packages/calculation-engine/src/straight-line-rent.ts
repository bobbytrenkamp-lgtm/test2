import { Decimal, ZERO, d, money } from './decimal.js';

/**
 * Straight-line (GAAP) rent recognition.
 *
 * A lease with rent steps or free rent bills a different amount every month,
 * but ASC 842 (and its predecessor, ASC 840) requires the *expense/income
 * statement* to recognise a constant amount across the lease term — the
 * total contractual consideration, spread evenly, regardless of when it is
 * actually billed. The gap between what is recognised and what is actually
 * billed in a given period is the deferred rent asset or liability.
 *
 * Deliberately a standalone calculation, not part of `calculate()`'s own
 * output. It operates on a net rent series the caller has already restricted
 * to the span it wants straight-lined — ordinarily one signed lease's own
 * term, read from `LeaseCashFlowRow.baseRent` less `LeaseCashFlowRow.freeRent`
 * over the periods the lease is in effect. Deciding which periods that is (a
 * lease's term inside a shorter forecast window, a renewal that resets the
 * straight-line calculation, a rollover branch that should not be
 * straight-lined at all because nothing is signed) is a judgment call this
 * function does not make on the caller's behalf, the same way `sizeLoan`
 * leaves the choice of sizing NOI to its caller.
 */

export interface StraightLineRentResult {
  /** The constant monthly amount recognised, before the final period's residual. */
  straightLineMonthlyRent: string;
  /**
   * Recognised rent in each period. Constant except the last period, which
   * absorbs the residual left by rounding every other period to the cent, so
   * the series sums back to exactly the same total as `actualRent`.
   */
  recognizedRent: string[];
  /** The actual net rent billed in each period, unchanged from the input. */
  actualRent: string[];
  /**
   * Cumulative (recognized − actual) at the end of each period: the deferred
   * rent balance. Positive means more has been recognised than billed so far
   * — a deferred rent **asset** — which is the ordinary shape during a free
   * rent period or ahead of a rent step. Negative means more has been billed
   * than recognised — a deferred rent **liability** — which happens when
   * rent starts high and steps down, or after a large step-up has been
   * billed but not yet "caught up to" by the constant recognised amount.
   * Returns to exactly zero in the final period: by construction, everything
   * recognised over the term equals everything actually billed.
   */
  deferredRentBalance: string[];
}

export function computeStraightLineRent(actualRentByPeriod: string[]): StraightLineRentResult {
  const n = actualRentByPeriod.length;
  if (n === 0) {
    return {
      straightLineMonthlyRent: '0',
      recognizedRent: [],
      actualRent: [],
      deferredRentBalance: [],
    };
  }

  const actual = actualRentByPeriod.map((value) => d(value));
  const total = actual.reduce((sum, value) => sum.plus(value), ZERO);
  const straightLineMonthlyRent = money(total.dividedBy(n));

  // Every period but the last recognises the same rounded amount; the last
  // absorbs whatever rounding residual is left, so the series sums back to
  // the actual total exactly rather than drifting by a cent or two over a
  // long term.
  const recognized: Decimal[] = [];
  let recognizedSoFar = ZERO;
  for (let i = 0; i < n; i += 1) {
    const amount = i === n - 1 ? total.minus(recognizedSoFar) : straightLineMonthlyRent;
    recognized.push(amount);
    recognizedSoFar = recognizedSoFar.plus(amount);
  }

  const deferredRentBalance: Decimal[] = [];
  let cumulative = ZERO;
  for (let i = 0; i < n; i += 1) {
    cumulative = cumulative.plus(recognized[i] as Decimal).minus(actual[i] as Decimal);
    deferredRentBalance.push(cumulative);
  }

  return {
    straightLineMonthlyRent: straightLineMonthlyRent.toString(),
    recognizedRent: recognized.map((value) => value.toString()),
    actualRent: actual.map((value) => value.toString()),
    deferredRentBalance: deferredRentBalance.map((value) => value.toString()),
  };
}

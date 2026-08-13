import { Decimal, TWELVE, ZERO, d } from './decimal.js';

/**
 * Loan sizing: given a set of target covenants, what is the largest loan
 * that satisfies all of them?
 *
 * A `DebtFacility` (see `debt.ts`) takes a loan amount as an input and
 * reports whether it happens to satisfy the same covenant fields
 * (`minimumDscr`, `maximumLtv`, `maximumLtc`, `minimumDebtYield`) once
 * drawn. This is the inverse question, asked before a facility is modelled
 * at all: given a target for each covenant a lender actually underwrites to,
 * what loan amount does each imply, and which one binds?
 *
 * Deliberately a standalone calculation, not folded into `computeDebt`. The
 * engine's own DSCR test is circular by construction — it is computed from
 * the debt service a facility's *own* modelled amount produces — so sizing
 * cannot live inside that loop without solving a fixed point for a value the
 * loop takes as a given input. A sizing result is meant to be read and then
 * typed into a facility's `commitment`, the same way an appraiser's
 * conclusion is read and then typed into `acquisitionPrice`.
 */

export type LoanSizingConstraintName =
  'minimum_dscr' | 'maximum_ltv' | 'maximum_ltc' | 'minimum_debt_yield';

export interface LoanSizingInput {
  /**
   * Annual net operating income used as the sizing basis. The caller decides
   * which NOI this is — Year 1, a stabilized year, trailing twelve months —
   * the same choice `directCapRate` already leaves to the same field
   * elsewhere in the engine, and for the same reason: what "the" NOI means
   * for sizing is a judgment call this function does not make on the
   * caller's behalf.
   */
  sizingNoi: string;
  /** Property value, for the LTV constraint. Omit to skip that constraint. */
  propertyValue?: string | null;
  /** Total project cost, for the LTC constraint. Omit to skip that constraint. */
  totalCost?: string | null;
  /** Annual interest rate applied to size the DSCR constraint's debt service. */
  annualRate: string;
  /**
   * Amortization term in months, for the DSCR constraint's level payment.
   * Zero sizes an interest-only loan: debt service is pure interest, with no
   * level-payment schedule to invert.
   */
  amortizationMonths: number;
  minimumDscr?: string | null;
  maximumLtv?: string | null;
  maximumLtc?: string | null;
  minimumDebtYield?: string | null;
}

export interface LoanSizingConstraintResult {
  constraint: LoanSizingConstraintName;
  /** The loan amount this constraint alone would allow. */
  impliedAmount: string;
}

export interface LoanSizingResult {
  /**
   * The smallest amount satisfying every constraint the caller supplied, or
   * null when none were — there is nothing to size against.
   */
  sizedAmount: string | null;
  /** Every constraint that was evaluated, in evaluation order. */
  constraints: LoanSizingConstraintResult[];
  /**
   * Which constraint(s) produced the sized amount. More than one when two
   * constraints happen to imply the identical amount.
   */
  bindingConstraints: LoanSizingConstraintName[];
}

/**
 * The principal a level payment supports: the algebraic inverse of
 * `levelPayment` in `debt.ts` (`pmt = P * r / (1 - (1 + r)^-n)`), solved for
 * `P` instead of `pmt`.
 */
export function loanAmountForPayment(
  payment: Decimal,
  monthlyRate: Decimal,
  months: number,
): Decimal {
  if (months <= 0) return ZERO;
  if (monthlyRate.isZero()) return payment.times(months);
  const factor = monthlyRate.plus(1).pow(-months);
  return payment.times(new Decimal(1).minus(factor)).dividedBy(monthlyRate);
}

export function sizeLoan(input: LoanSizingInput): LoanSizingResult {
  const constraints: LoanSizingConstraintResult[] = [];
  const sizingNoi = d(input.sizingNoi);

  if (input.minimumDscr) {
    const minimumDscr = d(input.minimumDscr);
    if (minimumDscr.greaterThan(0)) {
      const maxAnnualDebtService = sizingNoi.dividedBy(minimumDscr);
      const annualRate = d(input.annualRate);
      const impliedAmount =
        input.amortizationMonths > 0
          ? loanAmountForPayment(
              maxAnnualDebtService.dividedBy(TWELVE),
              annualRate.dividedBy(TWELVE),
              input.amortizationMonths,
            )
          : annualRate.isZero()
            ? ZERO
            : maxAnnualDebtService.dividedBy(annualRate);
      constraints.push({ constraint: 'minimum_dscr', impliedAmount: impliedAmount.toString() });
    }
  }

  if (input.maximumLtv && input.propertyValue) {
    const impliedAmount = d(input.propertyValue).times(d(input.maximumLtv));
    constraints.push({ constraint: 'maximum_ltv', impliedAmount: impliedAmount.toString() });
  }

  if (input.maximumLtc && input.totalCost) {
    const impliedAmount = d(input.totalCost).times(d(input.maximumLtc));
    constraints.push({ constraint: 'maximum_ltc', impliedAmount: impliedAmount.toString() });
  }

  if (input.minimumDebtYield) {
    const minimumDebtYield = d(input.minimumDebtYield);
    if (minimumDebtYield.greaterThan(0)) {
      const impliedAmount = sizingNoi.dividedBy(minimumDebtYield);
      constraints.push({
        constraint: 'minimum_debt_yield',
        impliedAmount: impliedAmount.toString(),
      });
    }
  }

  if (constraints.length === 0) {
    return { sizedAmount: null, constraints: [], bindingConstraints: [] };
  }

  const sizedAmount = constraints.reduce(
    (min, entry) => Decimal.min(min, d(entry.impliedAmount)),
    d(constraints[0]?.impliedAmount),
  );
  const bindingConstraints = constraints
    .filter((entry) => d(entry.impliedAmount).equals(sizedAmount))
    .map((entry) => entry.constraint);

  return { sizedAmount: sizedAmount.toString(), constraints, bindingConstraints };
}

import type { DebtFacility, DebtSchedule, DebtScheduleRow } from '@cre/domain-models';
import { Decimal, ONE, TWELVE, ZERO, d, maxOf, minOf, zeros } from './decimal.js';
import { type ForecastCalendar, monthDifference, parseDate } from './calendar.js';
import type { CurveSet } from './curves.js';
import { TraceRecorder, traceInputs } from './trace.js';

export interface DebtContext {
  calendar: ForecastCalendar;
  curves: CurveSet;
  trace: TraceRecorder;
  /** Net operating income per period, for covenant testing. */
  noi: Decimal[];
  /** Property value per period, for LTV. Usually the concluded DCF value. */
  propertyValue: Decimal;
  /** Total project cost, for LTC. */
  totalCost: Decimal;
  /** 0-based index of the sale period, or null for a hold-forever model. */
  saleIndex: number | null;
}

export interface DebtResult {
  schedules: DebtSchedule[];
  /** Loan fundings received in each period. */
  proceeds: Decimal[];
  /** Cash interest paid in each period, as a positive amount. */
  interest: Decimal[];
  /** Scheduled principal amortization, as a positive amount. */
  principal: Decimal[];
  /** Origination, unused, exit and extension fees, as a positive amount. */
  fees: Decimal[];
  /** Balloon and sale payoffs, as a positive amount. */
  payoff: Decimal[];
  /** Combined ending balance across all facilities, per period. */
  endingBalance: Decimal[];
}

/**
 * Level payment for an amortizing loan.
 * pmt = P * r / (1 - (1 + r)^-n), reduced to P/n when the rate is zero.
 */
export function levelPayment(principal: Decimal, monthlyRate: Decimal, months: number): Decimal {
  if (months <= 0) return ZERO;
  if (monthlyRate.isZero()) return principal.dividedBy(months);
  const factor = ONE.plus(monthlyRate).pow(-months);
  return principal.times(monthlyRate).dividedBy(ONE.minus(factor));
}

export function computeDebt(
  facilities: DebtFacility[],
  ctx: DebtContext,
  recordTrace: boolean,
): DebtResult {
  const n = ctx.calendar.periods.length;
  const result: DebtResult = {
    schedules: [],
    proceeds: zeros(n),
    interest: zeros(n),
    principal: zeros(n),
    fees: zeros(n),
    payoff: zeros(n),
    endingBalance: zeros(n),
  };

  const forecastStart = ctx.calendar.periods[0]?.start;
  if (!forecastStart) return result;

  for (const facility of facilities) {
    const commitment = d(facility.commitment);
    const fundingDate = parseDate(facility.fundingDate);
    const fundingIndex = monthDifference(forecastStart, fundingDate);
    const maturityIndex = fundingIndex + facility.termMonths - 1;

    if (facility.termMonths <= 0) {
      ctx.trace.error(
        'INVALID_DEBT_TERM',
        `Facility "${facility.name}" has a non-positive term.`,
        `debt:${facility.id}`,
        'termMonths',
      );
      continue;
    }
    if (fundingIndex < 0) {
      // The period loop below only ever indexes forward from 0, so a draw
      // stored at a negative index is never applied: the facility would
      // silently run at a zero balance for its entire term — no interest, no
      // principal, no fees, and nothing in the diagnostics to say why. An
      // existing loan carried into the forecast is a real scenario (a
      // refinance, an assumed mortgage), but computing its balance as of the
      // forecast start means running its amortization from `fundingDate`
      // first, which this engine does not do. Refusing outright is the
      // correct behaviour until that is built — silently pretending the
      // facility does not exist is worse than refusing.
      ctx.trace.error(
        'DEBT_FUNDED_BEFORE_FORECAST',
        `Facility "${facility.name}" is funded on ${facility.fundingDate}, before the forecast starts. An existing facility's balance as of the forecast start cannot be computed without modelling its amortization from the funding date; set the funding date to on or after the forecast start, or model the balance as of the forecast start as the facility's initial funding.`,
        `debt:${facility.id}`,
        'fundingDate',
      );
      continue;
    }
    if (maturityIndex < n - 1 && ctx.saleIndex !== null && maturityIndex < ctx.saleIndex) {
      ctx.trace.warn(
        'DEBT_MATURES_BEFORE_SALE',
        `Facility "${facility.name}" matures in forecast month ${maturityIndex + 1}, before the modelled sale in month ${ctx.saleIndex + 1}. The balance is repaid at maturity and no refinancing is assumed unless a replacement facility is modelled.`,
        `debt:${facility.id}`,
        'termMonths',
      );
    }

    const draws = new Map<number, Decimal>();
    if (d(facility.initialFunding).greaterThan(0)) {
      draws.set(fundingIndex, d(facility.initialFunding));
    }
    for (const draw of facility.draws) {
      const index = monthDifference(forecastStart, parseDate(draw.date));
      draws.set(index, (draws.get(index) ?? ZERO).plus(d(draw.amount)));
    }

    const drawnTotal = [...draws.values()].reduce((acc, v) => acc.plus(v), ZERO);
    if (drawnTotal.greaterThan(commitment)) {
      ctx.trace.error(
        'DEBT_EXCEEDS_COMMITMENT',
        `Facility "${facility.name}" draws ${drawnTotal.toFixed(2)} against a commitment of ${commitment.toFixed(2)}.`,
        `debt:${facility.id}`,
        'draws',
      );
    }

    const rows: DebtScheduleRow[] = [];
    const breaches: DebtSchedule['covenantBreaches'] = [];
    let balance = ZERO;
    let remainingAmortMonths = facility.amortizationMonths;

    for (let i = 0; i < n; i += 1) {
      const beginning = balance;
      const draw = draws.get(i) ?? ZERO;
      const monthsSinceFunding = i - fundingIndex;
      const active = monthsSinceFunding >= 0 && i <= maturityIndex;

      let cashInterest = ZERO;
      let capitalizedInterest = ZERO;
      let principal = ZERO;
      let fees = ZERO;
      let appliedRate = ZERO;

      if (draw.greaterThan(0)) {
        balance = balance.plus(draw);
        result.proceeds[i] = (result.proceeds[i] as Decimal).plus(draw);
        if (i === fundingIndex) {
          fees = fees.plus(commitment.times(d(facility.originationFeePercent)));
        }
      }

      if (active) {
        appliedRate = periodRate(facility, ctx, i);
        const monthlyRate = appliedRate.dividedBy(TWELVE);
        // Draws are treated as funding on the first day of the period, so they
        // carry a full month of interest. Interest is therefore accrued on the
        // balance after the draw, not the balance brought forward.
        const accrued = balance.times(monthlyRate);

        if (facility.capitalizeInterest) {
          capitalizedInterest = accrued;
          balance = balance.plus(accrued);
        } else {
          cashInterest = accrued;
        }

        const pastInterestOnly = monthsSinceFunding >= facility.interestOnlyMonths;
        if (pastInterestOnly && facility.amortizationMonths > 0 && remainingAmortMonths > 0) {
          const payment = levelPayment(balance, monthlyRate, remainingAmortMonths);
          principal = minOf(maxOf(payment.minus(accrued), ZERO), balance);
          balance = balance.minus(principal);
          remainingAmortMonths -= 1;
        }

        if (d(facility.unusedFeePercent).greaterThan(0)) {
          const undrawn = maxOf(commitment.minus(balance), ZERO);
          fees = fees.plus(undrawn.times(d(facility.unusedFeePercent)).dividedBy(TWELVE));
        }
      }

      // Payoff: at maturity, or on sale when the facility is repaid from proceeds.
      const isMaturity = i === maturityIndex;
      const isSalePayoff = ctx.saleIndex !== null && i === ctx.saleIndex && facility.repayOnSale;
      if ((isMaturity || isSalePayoff) && balance.greaterThan(0)) {
        const exitFee = balance.times(d(facility.exitFeePercent));
        fees = fees.plus(exitFee);
        result.payoff[i] = (result.payoff[i] as Decimal).plus(balance);
        balance = ZERO;
        remainingAmortMonths = 0;
      }

      result.interest[i] = (result.interest[i] as Decimal).plus(cashInterest);
      result.principal[i] = (result.principal[i] as Decimal).plus(principal);
      result.fees[i] = (result.fees[i] as Decimal).plus(fees);
      result.endingBalance[i] = (result.endingBalance[i] as Decimal).plus(balance);

      // Covenants are tested on a trailing annualised basis once a full year of
      // operating history exists inside the forecast.
      const annualNoi = trailingAnnualNoi(ctx.noi, i);
      const annualDebtService = cashInterest.plus(principal).times(TWELVE);
      const dscr = annualDebtService.isZero() ? null : annualNoi.dividedBy(annualDebtService);
      const debtYield = balance.isZero() ? null : annualNoi.dividedBy(balance);
      const ltv = ctx.propertyValue.isZero() ? null : balance.dividedBy(ctx.propertyValue);

      if (facility.minimumDscr && dscr && dscr.lessThan(d(facility.minimumDscr))) {
        breaches.push({
          periodIndex: i + 1,
          covenant: 'minimum_dscr',
          value: dscr.toString(),
          limit: d(facility.minimumDscr).toString(),
        });
      }
      if (facility.maximumLtv && ltv && ltv.greaterThan(d(facility.maximumLtv))) {
        breaches.push({
          periodIndex: i + 1,
          covenant: 'maximum_ltv',
          value: ltv.toString(),
          limit: d(facility.maximumLtv).toString(),
        });
      }
      if (
        facility.minimumDebtYield &&
        debtYield &&
        debtYield.lessThan(d(facility.minimumDebtYield))
      ) {
        breaches.push({
          periodIndex: i + 1,
          covenant: 'minimum_debt_yield',
          value: debtYield.toString(),
          limit: d(facility.minimumDebtYield).toString(),
        });
      }
      if (facility.maximumLtc && !ctx.totalCost.isZero()) {
        const ltc = balance.dividedBy(ctx.totalCost);
        if (ltc.greaterThan(d(facility.maximumLtc))) {
          breaches.push({
            periodIndex: i + 1,
            covenant: 'maximum_ltc',
            value: ltc.toString(),
            limit: d(facility.maximumLtc).toString(),
          });
        }
      }

      rows.push({
        periodIndex: i + 1,
        beginningBalance: beginning.toString(),
        draws: draw.toString(),
        capitalizedInterest: capitalizedInterest.toString(),
        cashInterest: cashInterest.toString(),
        principal: principal.toString(),
        fees: fees.toString(),
        endingBalance: balance.toString(),
        appliedRate: appliedRate.toString(),
        dscr: dscr ? dscr.toString() : null,
        debtYield: debtYield ? debtYield.toString() : null,
        ltv: ltv ? ltv.toString() : null,
      });
    }

    if (recordTrace) {
      ctx.trace.record({
        target: `debt:${facility.id}:schedule`,
        formula: `debt.${facility.rateType}`,
        description: `${facility.name}: ${facility.type.replace(/_/g, ' ')} facility, ${facility.interestOnlyMonths} months interest-only, ${facility.amortizationMonths || 'no'} month amortization, ${facility.termMonths} month term.`,
        inputs: traceInputs({
          commitment: facility.commitment,
          initialFunding: facility.initialFunding,
          fundingDate: facility.fundingDate,
          rateType: facility.rateType,
          fixedRate: facility.fixedRate,
          spread: facility.spread,
          indexCurve: facility.indexCurveId ?? 'none',
        }),
        result: rows.reduce((acc, row) => acc.plus(d(row.cashInterest)), ZERO).toString(),
        sources: [`debt:${facility.id}`],
      });
    }

    result.schedules.push({
      facilityId: facility.id,
      facilityName: facility.name,
      rows,
      covenantBreaches: breaches,
    });
  }

  return result;
}

/** Annualised rate applied in a period, after index lookup, floor and cap. */
function periodRate(facility: DebtFacility, ctx: DebtContext, periodIndex: number): Decimal {
  if (facility.rateType === 'fixed') return d(facility.fixedRate);
  const forecastYear = Math.floor(periodIndex / 12) + 1;
  const index = ctx.curves.rateForYear(facility.indexCurveId, forecastYear);
  let rate = index.plus(d(facility.spread));
  if (facility.rateFloor !== null && facility.rateFloor !== undefined) {
    rate = maxOf(rate, d(facility.rateFloor));
  }
  if (facility.rateCap !== null && facility.rateCap !== undefined) {
    rate = minOf(rate, d(facility.rateCap));
  }
  return rate;
}

/** Trailing twelve months of NOI, annualised when fewer months are available. */
function trailingAnnualNoi(noi: Decimal[], index: number): Decimal {
  const from = Math.max(0, index - 11);
  let total = ZERO;
  let months = 0;
  for (let i = from; i <= index && i < noi.length; i += 1) {
    total = total.plus(noi[i] as Decimal);
    months += 1;
  }
  if (months === 0) return ZERO;
  return total.times(TWELVE).dividedBy(months);
}

/** Total debt outstanding immediately before a given period's activity. */
export function balanceBefore(result: DebtResult, index: number): Decimal {
  if (index <= 0) return ZERO;
  return result.endingBalance[index - 1] ?? ZERO;
}

/* -------------------------------------------------------------------------- */
/* Cash management on covenant breach                                         */
/* -------------------------------------------------------------------------- */

export interface CashTrapResult {
  /**
   * Cash withheld from equity in each period, positive when trapped and
   * negative when released. Subtracting this from levered cash flow gives what
   * actually reaches the equity holder.
   */
  movement: Decimal[];
  /** Balance held by the lender at the end of each period. */
  restrictedBalance: Decimal[];
  events: Array<{
    periodIndex: number;
    event: 'trapped' | 'released';
    amount: string;
    /** The covenant that sprang the trap, or the cure that released it. */
    reason: string;
  }>;
}

/**
 * Applies cash-management triggers to a levered cash flow.
 *
 * A covenant breach the engine only reports is a breach with no consequence,
 * and the consequence is the whole point. When a loan traps cash, the property
 * performs exactly as before and the equity holder receives nothing, which
 * moves the levered return without moving a single operating figure. A model
 * that shows the breach but distributes the cash anyway overstates the return
 * in precisely the years the lender is most worried about.
 *
 * ## What this deliberately does not model
 *
 * **Cash sweep** — trapped cash applied to principal rather than held. That
 * would make the amortisation schedule depend on the cash flow, which depends
 * on the schedule: a fixed point the engine would have to solve. Approximating
 * it would misstate the balance, and a misstated balance misstates every
 * covenant tested against it thereafter. A trap holds the cash; a sweep spends
 * it, and the difference belongs in the loan documents, not in a guess.
 */
export function applyCashTrap(
  facilities: DebtFacility[],
  schedules: DebtSchedule[],
  leveredCashFlow: Decimal[],
): CashTrapResult {
  const n = leveredCashFlow.length;
  const movement = zeros(n);
  const restrictedBalance = zeros(n);
  const events: CashTrapResult['events'] = [];

  const triggering = facilities.filter((facility) => facility.cashTrap?.enabled);
  if (triggering.length === 0) return { movement, restrictedBalance, events };

  // Which periods breached, per facility, restricted to the covenants that
  // facility's trigger names.
  const breachedIn = new Map<string, Set<number>>();
  for (const facility of triggering) {
    const trigger = facility.cashTrap.trigger;
    const schedule = schedules.find((entry) => entry.facilityId === facility.id);
    const periods = new Set<number>();
    for (const breach of schedule?.covenantBreaches ?? []) {
      if (trigger === 'any_covenant' || breach.covenant === trigger) {
        periods.add(breach.periodIndex - 1);
      }
    }
    breachedIn.set(facility.id, periods);
  }

  let held = ZERO;
  let trapped = false;
  let compliantRun = 0;
  // The strictest cure requirement among the facilities that can trap, because
  // cash held for one lender is not available to equity whatever the others say.
  const cureAfter = Math.max(
    ...triggering.map((facility) => facility.cashTrap.cureConsecutivePeriods),
  );

  for (let i = 0; i < n; i += 1) {
    const breachedNow = triggering.filter((facility) => breachedIn.get(facility.id)?.has(i));

    if (breachedNow.length > 0) {
      compliantRun = 0;
      if (!trapped) {
        trapped = true;
        events.push({
          periodIndex: i + 1,
          event: 'trapped',
          amount: '0',
          reason: `${breachedNow[0]?.name ?? 'A facility'} breached its covenant`,
        });
      }
    } else if (trapped) {
      compliantRun += 1;
      if (compliantRun >= cureAfter) {
        // Released in full: the trap exists to secure the lender while the
        // breach persists, not to keep the money.
        if (!held.isZero()) {
          movement[i] = (movement[i] as Decimal).minus(held);
          events.push({
            periodIndex: i + 1,
            event: 'released',
            amount: held.toString(),
            reason: `Covenant met for ${compliantRun} consecutive periods`,
          });
          held = ZERO;
        }
        trapped = false;
        compliantRun = 0;
      }
    }

    if (trapped) {
      // Only a surplus can be trapped. A deficit is money the owner has to
      // fund, and a lender does not collect it by refusing a distribution.
      const surplus = Decimal.max(leveredCashFlow[i] as Decimal, ZERO);
      if (!surplus.isZero()) {
        movement[i] = (movement[i] as Decimal).plus(surplus);
        held = held.plus(surplus);
      }
    }

    restrictedBalance[i] = held;
  }

  // Anything still held at the end of the forecast is released: the loan is
  // repaid on sale, and cash the lender no longer secures belongs to equity.
  // Leaving it stranded would understate the return by the full amount.
  if (!held.isZero() && n > 0) {
    const last = n - 1;
    movement[last] = (movement[last] as Decimal).minus(held);
    restrictedBalance[last] = ZERO;
    events.push({
      periodIndex: n,
      event: 'released',
      amount: held.toString(),
      reason: 'End of the forecast: the facility is repaid and the balance released',
    });
  }

  return { movement, restrictedBalance, events };
}

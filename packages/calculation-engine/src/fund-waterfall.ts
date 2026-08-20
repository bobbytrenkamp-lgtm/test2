import type { EquityStructure } from '@cre/domain-models';
import type { FundInvestor, FundTransaction } from './fund.js';
import { type CalendarDate, compareDates, dayCount, parseDate } from './calendar.js';
import { Decimal, ONE, ZERO, d } from './decimal.js';

/**
 * Fund-level carried interest and catch-up.
 *
 * `fund.ts` deliberately does not model this: its own transactions are
 * dated, per-investor facts the caller states (a distribution of $400,000 to
 * Investor A on 2027-03-01), not something derived from a stated tier
 * structure. This module is the other half — given the same facts and a
 * stated waterfall (return of capital, a preferred return, a GP catch-up, a
 * residual split, in whatever order and combination the governing document
 * uses), it answers the question those facts alone cannot: **how should the
 * next distribution split?**
 *
 * ## Why this cannot reuse the deal-level waterfall
 *
 * `waterfall.ts`'s `computeWaterfall` assumes one aggregate cash flow per
 * *period* (a fixed monthly grid) and one *constant* contribution share per
 * partner applied to every capital call. Both are true of a single deal's
 * modelled equity structure and false of a real fund: investors are admitted
 * and called at genuinely different times and amounts, on no fixed grid at
 * all, and treating them as though they shared one constant proportion of
 * every dollar would misstate whose capital was actually at risk in which
 * month — precisely the kind of plausible-looking wrong number this
 * codebase's own testing philosophy exists to catch. This module tracks each
 * investor's own accrual from their own real transaction history instead.
 *
 * ## The two things a distribution date can mean
 *
 * A **past** distribution already has a real, per-investor amount — a fact
 * the caller states, exactly as `fund.ts` already treats it. This module
 * never recomputes what already happened; recomputing an amount someone
 * actually wired would silently overwrite a fact with a guess, the one thing
 * `fund.ts`'s own recallable-distribution rules already refuse to do. What it
 * *does* do is walk that known amount through the tier order — paying down
 * this investor's own accrued preferred, then their own unreturned capital,
 * crediting whatever is left as profit — so the running ledger (owed,
 * unreturned, profit distributed) is correct going forward. Catch-up and
 * residual-split tiers have nothing to compute for an amount that is already
 * decided; whatever a known distribution does not spend on capital and
 * preferred is booked as profit without asking which named tier it came
 * from, because for a fact already given there is no other tier left to ask.
 *
 * A **new** distribution has no per-investor amount yet — that is what this
 * module is for. Given the fund's current, real, accrual-correct state, it
 * runs the *same* tier-resolution algorithm `computeWaterfall` uses for a
 * single deal (return of capital pro rata on what is owed, preferred return
 * pro rata on what has accrued, a catch-up sized to close the gap to its
 * stated target share of profit distributed so far, a residual split on
 * stated shares) — proving an allocation, not stating one.
 *
 * ## Accrual on real dates, not a monthly grid
 *
 * A preferred return compounds from the date capital was actually called,
 * not from the first of a period it may never have aligned with. Each
 * investor's own accrual runs on actual day counts over a 365-day year —
 * `(1 + rate)^(days/365)` — the same day-count convention `xirr` already uses
 * for this fund's own IRR, so the two figures are never computed two
 * different ways for the same money.
 */

export type FundWaterfallTier = EquityStructure['tiers'][number];

export interface FundWaterfallInput {
  investors: FundInvestor[];
  /**
   * Every transaction to date: contributions, recalls, and distributions
   * already recorded as fact. Order does not matter — they are sorted by
   * date internally, and a contribution/recall is always booked before a
   * distribution on the same date (capital called on a day is at risk
   * before any distribution that same day can net against it) — but every
   * one must predate `distributionDate`, or a distribution on or after it
   * would be double-counted against the new amount this call is itself
   * proposing.
   */
  transactions: FundTransaction[];
  /**
   * Tiers, evaluated in order, exactly as `EquityStructure.tiers` at the
   * deal level. `splits[].partnerId` names a `FundInvestor.id` here, not a
   * deal partner — the fund's investors are the only parties a fund
   * waterfall ever has.
   */
  tiers: FundWaterfallTier[];
  /** The date of the distribution being proposed. */
  distributionDate: string;
  /** The amount available to distribute on that date. */
  distributableAmount: string;
}

export interface FundWaterfallAllocation {
  investorId: string;
  investorName: string;
  byTier: Array<{ tierId: string; tierName: string; amount: string }>;
  total: string;
}

export interface FundWaterfallResult {
  distributionDate: string;
  distributableAmount: string;
  allocations: FundWaterfallAllocation[];
}

interface InvestorState {
  id: string;
  name: string;
  /** Capital called and not yet returned. Never below zero. */
  unreturnedCapital: Decimal;
  /** Per accrual-tier (`preferred_return`/`irr_hurdle`) balance owed. */
  accrued: Map<string, Decimal>;
  /** Cumulative profit — everything paid past return of capital. */
  profitDistributed: Decimal;
  lastAccrualDate: CalendarDate;
}

const ACCRUAL_TYPES = new Set(['preferred_return', 'irr_hurdle']);
const DAYS_PER_YEAR = new Decimal(365);

/** Grows every accrual-tier balance for one investor from its last accrual date to `to`. */
function accrue(state: InvestorState, to: CalendarDate, tiers: FundWaterfallTier[]): void {
  const days = dayCount(state.lastAccrualDate, to);
  state.lastAccrualDate = to;
  if (days <= 0) return;
  for (const tier of tiers) {
    if (!ACCRUAL_TYPES.has(tier.type)) continue;
    const rate = d(tier.hurdleRate ?? '0');
    if (rate.isZero()) continue;
    const owed = state.accrued.get(tier.id) as Decimal;
    if (tier.compounding) {
      const base = state.unreturnedCapital.plus(owed);
      if (base.lessThanOrEqualTo(0)) continue;
      // (1 + rate)^(days/365) — actual days over a fixed 365-day year,
      // matching xirr's own convention (see the module comment above).
      const factor = ONE.plus(rate).pow(new Decimal(days).dividedBy(DAYS_PER_YEAR));
      state.accrued.set(tier.id, owed.plus(base.times(factor.minus(ONE))));
    } else {
      if (state.unreturnedCapital.lessThanOrEqualTo(0)) continue;
      // Non-compounding accrues on unreturned capital alone — never folding
      // the growing balance itself back into next period's base — using a
      // rate de-compounded down to one day, `(1 + rate)^(1/365) - 1`, applied
      // linearly across the elapsed days. This is the same relationship
      // `docs/calculation-specification.md`'s deal-level formula has to its
      // own monthly rate (`(1 + hurdle)^(1/12) − 1`, applied once per period
      // without compounding): the fixed period rate is still derived from
      // the stated annual rate's root, not from dividing it evenly, so
      // "non-compounding" is never computed two different ways for the same
      // money depending on which part of the engine asks.
      const dailyRate = ONE.plus(rate).pow(ONE.dividedBy(DAYS_PER_YEAR)).minus(ONE);
      const growth = state.unreturnedCapital.times(dailyRate).times(days);
      state.accrued.set(tier.id, owed.plus(growth));
    }
  }
}

/** Splits `amount` across a tier's stated shares, crediting each recipient's profit. */
function distributeBySplits(
  tier: FundWaterfallTier,
  amount: Decimal,
  states: Map<string, InvestorState>,
  credit: (investorId: string, tierId: string, amount: Decimal) => void,
): void {
  if (amount.lessThanOrEqualTo(0)) return;
  const shareTotal = tier.splits.reduce((acc, split) => acc.plus(d(split.share)), ZERO);
  if (shareTotal.isZero()) return;
  for (const split of tier.splits) {
    const share = d(split.share);
    if (share.isZero()) continue;
    const state = states.get(split.partnerId);
    if (!state) continue;
    const allocation = amount.times(share).dividedBy(shareTotal);
    state.profitDistributed = state.profitDistributed.plus(allocation);
    credit(split.partnerId, tier.id, allocation);
  }
}

export function computeFundWaterfall(input: FundWaterfallInput): FundWaterfallResult {
  const { investors, tiers } = input;
  const distributionDate = parseDate(input.distributionDate);

  // Every investor state and every allocation below is keyed by `investor.id`
  // — a caller-assembled duplicate would silently merge two investors' ledgers
  // into one `Map` entry and then report that single merged total twice (once
  // per duplicate `investors` entry) in `allocations`, double-counting against
  // `distributableAmount` with nothing to say so. Refusing outright is the
  // same "name the problem, do not guess" answer this module gives the
  // unallocated-remainder and misconfigured-catch-up cases below.
  const seenIds = new Set<string>();
  for (const investor of investors) {
    if (seenIds.has(investor.id)) {
      throw new Error(
        `Investor id ${investor.id} appears more than once in this fund's investor list.`,
      );
    }
    seenIds.add(investor.id);
  }

  const states = new Map<string, InvestorState>(
    investors.map((investor) => [
      investor.id,
      {
        id: investor.id,
        name: investor.name,
        unreturnedCapital: ZERO,
        accrued: new Map(
          tiers.filter((tier) => ACCRUAL_TYPES.has(tier.type)).map((tier) => [tier.id, ZERO]),
        ),
        profitDistributed: ZERO,
        // Reset to each investor's own first transaction below; a fund with
        // no prior transactions for an investor accrues nothing before the
        // distribution date, which is the correct reading of "just admitted".
        lastAccrualDate: distributionDate,
      },
    ]),
  );

  // A contribution/recall sorts before a distribution on the same date, so
  // the result never depends on the order the caller happened to list
  // same-day transactions in (`transactions`'s own doc comment above
  // promises exactly that). Capital called on a day is at risk before any
  // distribution that same day can net against it.
  const eventPriority = (event: FundTransaction): number => (event.type === 'distribution' ? 1 : 0);
  const events = [...input.transactions].sort((a, b) => {
    const byDate = compareDates(parseDate(a.date), parseDate(b.date));
    return byDate !== 0 ? byDate : eventPriority(a) - eventPriority(b);
  });
  for (const event of events) {
    if (compareDates(parseDate(event.date), distributionDate) >= 0) {
      throw new Error(
        `Transaction on ${event.date} is not before the proposed distribution date ` +
          `${input.distributionDate}; it would be double-counted against the amount being proposed.`,
      );
    }
  }

  // Each investor's own clock starts at their own first transaction, not the
  // fund's — an investor admitted in year three of the fund has never
  // accrued anything before they had any capital at risk to accrue on.
  for (const investor of investors) {
    const first = events.find((event) => event.investorId === investor.id);
    const state = states.get(investor.id) as InvestorState;
    if (first) state.lastAccrualDate = parseDate(first.date);
  }

  for (const event of events) {
    const state = states.get(event.investorId);
    if (!state) continue;
    const eventDate = parseDate(event.date);
    accrue(state, eventDate, tiers);

    if (event.type === 'contribution' || event.type === 'recall') {
      // A recall is capital leaving the investor again, exactly like a fresh
      // call — see fund.ts's own `investorFlows` — so it puts that money
      // back at risk for accrual purposes the same way a call does.
      state.unreturnedCapital = state.unreturnedCapital.plus(d(event.amount));
      continue;
    }

    // A distribution already on the books: book it against this investor's
    // own ledger in tier order, never recompute it. See the module comment.
    let remaining = d(event.amount);
    for (const tier of tiers) {
      if (remaining.lessThanOrEqualTo(0)) break;
      if (ACCRUAL_TYPES.has(tier.type)) {
        const owed = state.accrued.get(tier.id) as Decimal;
        if (owed.lessThanOrEqualTo(0)) continue;
        const paid = Decimal.min(remaining, owed);
        state.accrued.set(tier.id, owed.minus(paid));
        remaining = remaining.minus(paid);
        continue;
      }
      if (tier.type === 'return_of_capital') {
        if (state.unreturnedCapital.lessThanOrEqualTo(0)) continue;
        const paid = Decimal.min(remaining, state.unreturnedCapital);
        state.unreturnedCapital = state.unreturnedCapital.minus(paid);
        remaining = remaining.minus(paid);
        continue;
      }
      // catch_up and residual_split have nothing to compute for an amount
      // that is already a fact — see the module comment.
    }
    if (remaining.greaterThan(0)) state.profitDistributed = state.profitDistributed.plus(remaining);
  }

  // Bring every investor's accrual current as of the proposed date.
  for (const state of states.values()) accrue(state, distributionDate, tiers);

  const byInvestorTier = new Map<string, Map<string, Decimal>>(
    investors.map((investor) => [investor.id, new Map<string, Decimal>()]),
  );
  const credit = (investorId: string, tierId: string, amount: Decimal): void => {
    if (amount.lessThanOrEqualTo(0)) return;
    const byTier = byInvestorTier.get(investorId);
    if (!byTier) return;
    byTier.set(tierId, (byTier.get(tierId) ?? ZERO).plus(amount));
  };

  let remaining = d(input.distributableAmount);
  for (const tier of tiers) {
    if (remaining.lessThanOrEqualTo(0)) break;

    if (ACCRUAL_TYPES.has(tier.type)) {
      const owed = investors.map((investor) => ({
        investor,
        owed: (states.get(investor.id) as InvestorState).accrued.get(tier.id) as Decimal,
      }));
      const owedTotal = owed.reduce((acc, o) => acc.plus(o.owed), ZERO);
      if (owedTotal.lessThanOrEqualTo(0)) continue;
      const paid = Decimal.min(remaining, owedTotal);
      for (const { investor, owed: investorOwed } of owed) {
        if (investorOwed.lessThanOrEqualTo(0)) continue;
        const amount = paid.times(investorOwed).dividedBy(owedTotal);
        const state = states.get(investor.id) as InvestorState;
        state.accrued.set(tier.id, investorOwed.minus(amount));
        state.profitDistributed = state.profitDistributed.plus(amount);
        credit(investor.id, tier.id, amount);
      }
      remaining = remaining.minus(paid);
      continue;
    }

    if (tier.type === 'return_of_capital') {
      const owedTotal = investors.reduce(
        (acc, investor) => acc.plus((states.get(investor.id) as InvestorState).unreturnedCapital),
        ZERO,
      );
      if (owedTotal.lessThanOrEqualTo(0)) continue;
      const paid = Decimal.min(remaining, owedTotal);
      for (const investor of investors) {
        const state = states.get(investor.id) as InvestorState;
        if (state.unreturnedCapital.lessThanOrEqualTo(0)) continue;
        const amount = paid.times(state.unreturnedCapital).dividedBy(owedTotal);
        state.unreturnedCapital = state.unreturnedCapital.minus(amount);
        credit(investor.id, tier.id, amount);
      }
      remaining = remaining.minus(paid);
      continue;
    }

    if (tier.type === 'catch_up') {
      const target = d(tier.catchUpTargetShare ?? '0').clamp(0, new Decimal('0.999'));
      if (target.isZero()) continue;
      const recipients = tier.splits.filter((split) => d(split.share).greaterThan(0));
      // No recipient means nothing this tier could actually pay — matching
      // the `owedTotal <= 0` "continue" used above for the accrual and
      // return-of-capital tiers. Without this, `paid` would still be
      // subtracted from `remaining` below while `distributeBySplits` credits
      // nobody (its own `shareTotal.isZero()` guard), so the money would
      // simply vanish from the reported allocations without tripping the
      // unallocated-remainder check at the end of this function.
      if (recipients.length === 0) continue;
      const sponsorProfit = recipients.reduce((acc, split) => {
        const state = states.get(split.partnerId);
        return state ? acc.plus(state.profitDistributed) : acc;
      }, ZERO);
      const otherProfit = investors
        .filter((investor) => !recipients.some((r) => r.partnerId === investor.id))
        .reduce(
          (acc, investor) => acc.plus((states.get(investor.id) as InvestorState).profitDistributed),
          ZERO,
        );
      // Bring the recipients' collective profit up to `target` of everyone's.
      const needed = otherProfit.times(target).dividedBy(ONE.minus(target)).minus(sponsorProfit);
      if (needed.lessThanOrEqualTo(0)) continue;
      const paid = Decimal.min(remaining, needed);
      distributeBySplits(tier, paid, states, credit);
      remaining = remaining.minus(paid);
      continue;
    }

    // residual_split consumes whatever is left.
    distributeBySplits(tier, remaining, states, credit);
    remaining = ZERO;
  }

  // A distribution's own tiers have to spend the whole amount: no residual
  // tier, or one whose shares sum to zero, are configuration defects, not
  // situations worth guessing a fallback split for. Unlike the deal-level
  // waterfall — which runs as one line inside a full model calculation and
  // falls back to contribution shares with a warning so one misconfigured
  // deal does not block the rest of the run — this function is invoked on
  // demand, for one proposed distribution, specifically so a GP can decide
  // whether it looks right before a single dollar moves. Silently spreading
  // the leftover by guesswork would be exactly the kind of plausible wrong
  // number this codebase's tests exist to catch; refusing outright, with the
  // shortfall named, is the honest answer.
  if (remaining.greaterThan(0)) {
    const allocated = d(input.distributableAmount).minus(remaining).toString();
    throw new Error(
      `This waterfall's tiers only account for ${allocated} of the ${input.distributableAmount} ` +
        `being distributed, leaving ${remaining.toString()} unallocated. Add a residual_split ` +
        `tier, or check that an existing one's shares sum to more than zero.`,
    );
  }

  const allocations: FundWaterfallAllocation[] = investors.map((investor) => {
    const byTier = byInvestorTier.get(investor.id) ?? new Map<string, Decimal>();
    const total = [...byTier.values()].reduce((acc, v) => acc.plus(v), ZERO);
    return {
      investorId: investor.id,
      investorName: investor.name,
      byTier: [...byTier.entries()].map(([tierId, amount]) => ({
        tierId,
        tierName: tiers.find((tier) => tier.id === tierId)?.name ?? tierId,
        amount: amount.toString(),
      })),
      total: total.toString(),
    };
  });

  return {
    distributionDate: input.distributionDate,
    distributableAmount: input.distributableAmount,
    allocations,
  };
}

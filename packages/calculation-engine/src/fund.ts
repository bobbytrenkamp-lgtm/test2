import { parseDate } from './calendar.js';
import { Decimal, ZERO, d } from './decimal.js';
import { safeDivide, toStringOrNull, xirr, type DatedCashFlow } from './metrics.js';

/**
 * Fund-level investor economics.
 *
 * A fund is not a bigger property. Its investors commit capital, the manager
 * calls it over time, and distributions come back on their own schedule — so
 * the numbers that matter are about *that* pattern, not about the assets:
 * how much of a commitment is still unfunded, how much has come back against
 * what went in, and what rate the timing of those flows implies.
 *
 * Two rules, both inherited from the portfolio module for the same reasons.
 *
 * A fund's internal rate of return is solved from the fund's own dated flows,
 * never averaged from investor or asset returns. Averaging rates is wrong
 * whenever the amounts or the timing differ, which for a fund they always do.
 *
 * A multiple is rebuilt from its own numerator and denominator at every level.
 * The fund's DPI is total distributions over total contributions — not the
 * average of its investors' DPIs, which would weight a $1m investor the same as
 * a $100m one.
 *
 * ## Recallable distributions
 *
 * A distribution can be marked `recallable`, and a later `recall` transaction
 * draws against it. Both are facts the caller states, not inferences this
 * module makes: whether a given distribution may be recalled, and whether one
 * actually was, are LPA terms and GP decisions no engine should guess at.
 *
 * What the arithmetic itself is deliberately conservative about: a recall
 * nets against `distributed` (so DPI reflects what an investor actually kept,
 * not what passed through their hands before being asked back) and against
 * `recallableOutstanding` (so a report can show how much recall right is
 * still live) — full stop. It does **not** restore unfunded commitment or
 * expand how much more can be called beyond the stated commitment. Some LPAs
 * let a recalled dollar be called again as if it were fresh capital, up to a
 * cap stated in the agreement; that is exactly the kind of document-specific
 * mechanism this module has always refused to guess at, and adding a `recall`
 * type does not change that stance.
 *
 * ## What this deliberately does not model
 *
 * - **Fund-level carried interest and catch-up.** The deal waterfall in
 *   `waterfall.ts` models tiers for a single investment. A fund-level waterfall
 *   settles across the whole portfolio with its own hurdle and clawback, which
 *   is a different calculation and not this one.
 * - **Management fee mechanics** — offsets, step-downs, fees on invested rather
 *   than committed capital. A fee that has been charged appears here as the
 *   contribution it was funded by; how it was computed is upstream.
 *
 * Each is a real part of fund accounting, and reporting a number that quietly
 * assumed one of them would be worse than not reporting it.
 */

export interface FundInvestor {
  id: string;
  name: string;
  /** Investor class, e.g. `lp` or `gp`. Reported, not used in the arithmetic. */
  investorClass: string;
  /** Total capital committed, in the fund's currency. */
  commitment: string;
}

export interface FundTransaction {
  investorId: string;
  /** `YYYY-MM-DD`. */
  date: string;
  /**
   * `recall` draws back capital from a distribution already made — money
   * leaving the investor again, the same direction as a `contribution`, but
   * kept as its own type so a report can show what was called for a new
   * investment separately from what was called back.
   */
  type: 'contribution' | 'distribution' | 'recall';
  /** Always positive. The direction is decided by `type`, not by a sign. */
  amount: string;
  /**
   * Meaningful only on a `distribution`: whether the fund's governing
   * document lets the GP call this money back later. Not enforced against a
   * later `recall` — this module states what happened, not what the LPA
   * permits.
   */
  recallable?: boolean;
}

export interface FundInvestorPosition {
  investorId: string;
  investorName: string;
  investorClass: string;
  commitment: string;
  /** Capital actually drawn. */
  contributed: string;
  /** Commitment not yet drawn, floored at zero. */
  unfunded: string;
  /** `contributed ÷ commitment`, null when the commitment is zero. */
  percentCalled: string | null;
  /**
   * Gross distributions less any recall — what this investor actually kept.
   * `distributed` plus `recalled` reconstructs gross distributions, so
   * nothing here is hidden.
   */
  distributed: string;
  /** Total drawn back by a `recall` transaction. */
  recalled: string;
  /**
   * The not-yet-recalled portion of distributions marked `recallable`,
   * floored at zero: how much recall right is still live. Already counted
   * inside `distributed` — this is a breakdown of it, not an addition to it.
   */
  recallableOutstanding: string;
  /** This investor's share of the fund's residual value. */
  netAssetValue: string;
  /** Distributions over contributions — realised return. */
  dpi: string | null;
  /** Residual value over contributions — unrealised return. */
  rvpi: string | null;
  /** The two together. */
  tvpi: string | null;
  /** Solved from this investor's own dated flows. */
  netIrr: string | null;
}

export interface FundSummary {
  investorCount: number;
  totalCommitment: string;
  totalContributed: string;
  totalUnfunded: string;
  totalDistributed: string;
  totalRecalled: string;
  totalRecallableOutstanding: string;
  netAssetValue: string;
  percentCalled: string | null;
  dpi: string | null;
  rvpi: string | null;
  tvpi: string | null;
  netIrr: string | null;
  positions: FundInvestorPosition[];
  /** Every dated flow the fund IRR was solved from, so the figure can be checked. */
  cashFlows: Array<{ date: string; amount: string; label: string }>;
}

export interface FundInput {
  investors: FundInvestor[];
  transactions: FundTransaction[];
  /**
   * Residual value of the fund's assets, from the portfolio aggregate's net
   * asset value. Allocated between investors by their share of contributed
   * capital.
   */
  netAssetValue: string;
  /**
   * The date the residual value is measured at. It enters the IRR as a final
   * inflow, which is what makes an unrealised fund's return comparable to a
   * realised one.
   */
  valuationDate: string;
}

/**
 * Splits the residual value between investors by contributed capital.
 *
 * Contributed rather than committed: an investor who has funded half its
 * commitment owns half as much of the assets as one who has funded all of it,
 * whatever they each promised. A fund whose investors have all been called the
 * same proportion — the usual case — gives the same answer either way.
 *
 * With nothing contributed there is nothing to divide, so every share is zero
 * rather than the fund's value being split arbitrarily.
 */
function navShares(
  positions: Array<{ investorId: string; contributed: Decimal }>,
  netAssetValue: Decimal,
): Map<string, Decimal> {
  const total = positions.reduce((sum, position) => sum.plus(position.contributed), ZERO);
  const shares = new Map<string, Decimal>();
  for (const position of positions) {
    shares.set(
      position.investorId,
      total.isZero() ? ZERO : netAssetValue.times(position.contributed).dividedBy(total),
    );
  }
  return shares;
}

/**
 * Investor cash flows, in the sign convention the IRR needs: capital called
 * is money leaving the investor, distributions and residual value are money
 * arriving. A recall is money leaving the investor again — the same
 * direction as a contribution, whatever it is called back against.
 */
function investorFlows(
  transactions: FundTransaction[],
  netAssetValue: Decimal,
  valuationDate: string,
): DatedCashFlow[] {
  const flows: DatedCashFlow[] = transactions.map((transaction) => ({
    date: parseDate(transaction.date),
    amount:
      transaction.type === 'contribution' || transaction.type === 'recall'
        ? d(transaction.amount).negated()
        : d(transaction.amount),
  }));
  if (!netAssetValue.isZero()) {
    flows.push({ date: parseDate(valuationDate), amount: netAssetValue });
  }
  return flows;
}

export function computeFund(input: FundInput): FundSummary {
  const netAssetValue = d(input.netAssetValue);

  const byInvestor = new Map<string, FundTransaction[]>();
  for (const transaction of input.transactions) {
    const bucket = byInvestor.get(transaction.investorId);
    if (bucket) bucket.push(transaction);
    else byInvestor.set(transaction.investorId, [transaction]);
  }

  const drawn = input.investors.map((investor) => {
    const transactions = byInvestor.get(investor.id) ?? [];
    const contributed = transactions
      .filter((transaction) => transaction.type === 'contribution')
      .reduce((sum, transaction) => sum.plus(d(transaction.amount)), ZERO);
    const grossDistributed = transactions
      .filter((transaction) => transaction.type === 'distribution')
      .reduce((sum, transaction) => sum.plus(d(transaction.amount)), ZERO);
    const recallableDistributed = transactions
      .filter((transaction) => transaction.type === 'distribution' && transaction.recallable)
      .reduce((sum, transaction) => sum.plus(d(transaction.amount)), ZERO);
    const recalled = transactions
      .filter((transaction) => transaction.type === 'recall')
      .reduce((sum, transaction) => sum.plus(d(transaction.amount)), ZERO);
    // Floored for the same reason `unfunded` is: a recall the caller records
    // beyond what was ever marked recallable is a data anomaly, not grounds
    // to report a negative "still live" figure.
    const recallableOutstanding = Decimal.max(recallableDistributed.minus(recalled), ZERO);
    // Floored too: `distributed` means "money that flowed out and stayed
    // out". A recall exceeding gross distributions cannot happen in a real
    // fund, and showing a negative figure would read as the fund owing
    // money for a reason distributed was never meant to carry.
    const distributed = Decimal.max(grossDistributed.minus(recalled), ZERO);
    return { investor, transactions, contributed, distributed, recalled, recallableOutstanding };
  });

  const shares = navShares(
    drawn.map((entry) => ({ investorId: entry.investor.id, contributed: entry.contributed })),
    netAssetValue,
  );

  const positions: FundInvestorPosition[] = drawn.map((entry) => {
    const commitment = d(entry.investor.commitment);
    const share = shares.get(entry.investor.id) ?? ZERO;
    const flows = investorFlows(entry.transactions, share, input.valuationDate);
    const rate = xirr(flows);

    return {
      investorId: entry.investor.id,
      investorName: entry.investor.name,
      investorClass: entry.investor.investorClass,
      commitment: commitment.toString(),
      contributed: entry.contributed.toString(),
      // Floored: an investor called beyond its commitment has nothing left
      // unfunded, and a negative figure would read as the fund owing it money.
      unfunded: Decimal.max(commitment.minus(entry.contributed), ZERO).toString(),
      percentCalled: toStringOrNull(safeDivide(entry.contributed, commitment)),
      distributed: entry.distributed.toString(),
      recalled: entry.recalled.toString(),
      recallableOutstanding: entry.recallableOutstanding.toString(),
      netAssetValue: share.toString(),
      dpi: toStringOrNull(safeDivide(entry.distributed, entry.contributed)),
      rvpi: toStringOrNull(safeDivide(share, entry.contributed)),
      tvpi: toStringOrNull(safeDivide(entry.distributed.plus(share), entry.contributed)),
      netIrr: toStringOrNull(rate),
    };
  });

  const totalCommitment = drawn.reduce((sum, e) => sum.plus(d(e.investor.commitment)), ZERO);
  const totalContributed = drawn.reduce((sum, e) => sum.plus(e.contributed), ZERO);
  const totalDistributed = drawn.reduce((sum, e) => sum.plus(e.distributed), ZERO);
  const totalRecalled = drawn.reduce((sum, e) => sum.plus(e.recalled), ZERO);
  const totalRecallableOutstanding = drawn.reduce(
    (sum, e) => sum.plus(e.recallableOutstanding),
    ZERO,
  );
  const totalUnfunded = positions.reduce((sum, position) => sum.plus(d(position.unfunded)), ZERO);

  // Solved from the fund's own flows. Summing the investors' IRRs, or averaging
  // them, would be wrong for the same reason it is wrong across properties.
  const fundFlows = investorFlows(input.transactions, netAssetValue, input.valuationDate);
  const fundRate = xirr(fundFlows);

  return {
    investorCount: input.investors.length,
    totalCommitment: totalCommitment.toString(),
    totalContributed: totalContributed.toString(),
    totalUnfunded: totalUnfunded.toString(),
    totalDistributed: totalDistributed.toString(),
    totalRecalled: totalRecalled.toString(),
    totalRecallableOutstanding: totalRecallableOutstanding.toString(),
    netAssetValue: netAssetValue.toString(),
    percentCalled: toStringOrNull(safeDivide(totalContributed, totalCommitment)),
    dpi: toStringOrNull(safeDivide(totalDistributed, totalContributed)),
    rvpi: toStringOrNull(safeDivide(netAssetValue, totalContributed)),
    tvpi: toStringOrNull(safeDivide(totalDistributed.plus(netAssetValue), totalContributed)),
    netIrr: toStringOrNull(fundRate),
    positions,
    cashFlows: [
      ...input.transactions.map((transaction) => ({
        date: transaction.date,
        amount:
          transaction.type === 'contribution' || transaction.type === 'recall'
            ? d(transaction.amount).negated().toString()
            : d(transaction.amount).toString(),
        label: transaction.type,
      })),
      ...(netAssetValue.isZero()
        ? []
        : [
            {
              date: input.valuationDate,
              amount: netAssetValue.toString(),
              label: 'residual value',
            },
          ]),
    ],
  };
}

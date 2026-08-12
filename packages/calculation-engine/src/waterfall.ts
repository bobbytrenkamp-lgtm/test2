import type { EquityStructure, WaterfallDistribution } from '@cre/domain-models';
import { Decimal, ONE, TWELVE, ZERO, d, zeros } from './decimal.js';
import type { ForecastCalendar } from './calendar.js';
import { equityMultiple, irrMonthly, xirr } from './metrics.js';
import type { DatedCashFlow } from './metrics.js';
import { TraceRecorder, traceInputs } from './trace.js';

/**
 * Partnership distribution waterfall.
 *
 * Preferred-return and IRR-hurdle tiers are both implemented as accrual
 * accounts: capital carries an accruing balance at the hurdle rate, and the
 * tier is satisfied when that balance is paid to zero. For a compounding
 * accrual this produces the same outcome as an IRR lookback while remaining a
 * closed-form, order-independent calculation, which keeps the result
 * deterministic and auditable. The methodology is stated in
 * docs/calculation-specification.md.
 */

export interface WaterfallContext {
  calendar: ForecastCalendar;
  structure: EquityStructure;
  /** Equity cash flow per period. Negative is a capital call. */
  equityCashFlow: Decimal[];
  /** Capital invested at time zero, before the first forecast period. */
  initialEquity: Decimal;
  trace: TraceRecorder;
}

interface PartnerState {
  /**
   * Internal identity for this partner *object* — its array index, stable
   * for the life of this call. `DUPLICATE_PARTNER` refuses a model where two
   * partners share their own (user-facing) `id`, but that refusal does not
   * stop `calculate()` from still computing a result, and every Map here
   * used to be keyed on the user-facing id directly: two partner objects
   * sharing one id shared one entry, so each independently read back the
   * *combined* balance as if it were its own — an accrual paid out twice
   * over, or a residual/catch-up split credited in full to both instead of
   * divided between them, manufacturing cash beyond what the tier actually
   * allocated. Keying on `key` instead makes every accrual and profit-
   * tracking map exactly as many entries as there are partner objects,
   * regardless of what their `id` fields say.
   */
  key: string;
  id: string;
  name: string;
  role: string;
  share: Decimal;
  contributions: Decimal;
  distributions: Decimal;
  unreturnedCapital: Decimal;
  byTier: Map<string, Decimal>;
  flows: Decimal[];
  initialFlow: Decimal;
}

export function computeWaterfall(ctx: WaterfallContext): WaterfallDistribution[] {
  const { structure, calendar } = ctx;
  const n = calendar.periods.length;
  if (structure.partners.length === 0) return [];

  const partners: PartnerState[] = structure.partners.map((partner, index) => ({
    key: String(index),
    id: partner.id,
    name: partner.name,
    role: partner.role,
    share: d(partner.contributionShare),
    contributions: ZERO,
    distributions: ZERO,
    unreturnedCapital: ZERO,
    byTier: new Map(structure.tiers.map((tier) => [tier.id, ZERO])),
    flows: zeros(n),
    initialFlow: ZERO,
  }));

  const shareTotal = partners.reduce((acc, p) => acc.plus(p.share), ZERO);
  // Every partner at 0% is not a proportion problem to normalise, the way a
  // total of, say, 0.9 is — it states that nobody funds this deal, which no
  // capital call can honour. Dividing by a zero-sum normaliser would make
  // every allocation zero and the contribution would vanish from every
  // partner's ledger with nothing to say where it went. Splitting evenly
  // keeps the money accounted for while the error says plainly that the
  // shares, not the split this fell back to, need fixing.
  const sharesAreUseless = shareTotal.isZero() && partners.length > 0;
  if (sharesAreUseless) {
    ctx.trace.error(
      'PARTNER_SHARES_SUM_TO_ZERO',
      'Partner contribution shares sum to zero, so no partner is allocated any share of a capital call by the shares as stated. Contributions were split evenly across partners instead of being lost from the ledger; set contribution shares that reflect who actually funds this deal.',
      'equity',
      'partners',
    );
  } else if (shareTotal.minus(ONE).abs().greaterThan('0.0001')) {
    ctx.trace.warn(
      'PARTNER_SHARES_DO_NOT_SUM',
      `Partner contribution shares sum to ${shareTotal.toFixed(4)} rather than 1. Contributions were normalised proportionally.`,
      'equity',
      'partners',
    );
  }
  const normalise = sharesAreUseless ? d(partners.length) : shareTotal;

  /** Accrued but unpaid preferred, by tier and partner (keyed by `partner.key`). */
  const accrued = new Map<string, Map<string, Decimal>>();
  for (const tier of structure.tiers) {
    accrued.set(tier.id, new Map(partners.map((p) => [p.key, ZERO])));
  }
  /** Cumulative profit distributions, used by catch-up tiers (keyed by `partner.key`). */
  const profitDistributed = new Map<string, Decimal>(partners.map((p) => [p.key, ZERO]));

  const contribute = (amount: Decimal, periodIndex: number | null): void => {
    for (const partner of partners) {
      const effectiveShare = sharesAreUseless ? ONE : partner.share;
      const allocation = amount.times(effectiveShare).dividedBy(normalise);
      partner.contributions = partner.contributions.plus(allocation);
      partner.unreturnedCapital = partner.unreturnedCapital.plus(allocation);
      if (periodIndex === null) partner.initialFlow = partner.initialFlow.minus(allocation);
      else partner.flows[periodIndex] = (partner.flows[periodIndex] as Decimal).minus(allocation);
    }
  };

  if (ctx.initialEquity.greaterThan(0)) contribute(ctx.initialEquity, null);

  for (let i = 0; i < n; i += 1) {
    // Accrue the preferred on every accrual tier for this month.
    for (const tier of structure.tiers) {
      if (tier.type !== 'preferred_return' && tier.type !== 'irr_hurdle') continue;
      const rate = d(tier.hurdleRate ?? '0');
      if (rate.isZero()) continue;
      const monthlyRate = ONE.plus(rate).pow(new Decimal(1).dividedBy(TWELVE)).minus(ONE);
      const balances = accrued.get(tier.id) as Map<string, Decimal>;
      for (const partner of partners) {
        const unpaid = balances.get(partner.key) as Decimal;
        const base = tier.compounding
          ? partner.unreturnedCapital.plus(unpaid)
          : partner.unreturnedCapital;
        balances.set(partner.key, unpaid.plus(base.times(monthlyRate)));
      }
    }

    const flow = ctx.equityCashFlow[i] ?? ZERO;
    if (flow.lessThan(0)) {
      contribute(flow.negated(), i);
      continue;
    }
    if (flow.isZero()) continue;

    let remaining = flow;

    for (const tier of structure.tiers) {
      if (remaining.lessThanOrEqualTo(0)) break;
      const splits = new Map(tier.splits.map((split) => [split.partnerId, d(split.share)]));

      if (tier.type === 'preferred_return' || tier.type === 'irr_hurdle') {
        const balances = accrued.get(tier.id) as Map<string, Decimal>;
        const owed = partners.map((partner) => balances.get(partner.key) as Decimal);
        const owedTotal = owed.reduce((acc, v) => acc.plus(v), ZERO);
        if (owedTotal.lessThanOrEqualTo(0)) continue;
        const paid = Decimal.min(remaining, owedTotal);
        for (let p = 0; p < partners.length; p += 1) {
          const partner = partners[p] as PartnerState;
          const partnerOwed = owed[p] as Decimal;
          if (partnerOwed.lessThanOrEqualTo(0)) continue;
          const amount = paid.times(partnerOwed).dividedBy(owedTotal);
          balances.set(partner.key, partnerOwed.minus(amount));
          creditPartner(partner, tier.id, amount, i);
          profitDistributed.set(
            partner.key,
            (profitDistributed.get(partner.key) as Decimal).plus(amount),
          );
        }
        remaining = remaining.minus(paid);
        continue;
      }

      if (tier.type === 'return_of_capital') {
        const owedTotal = partners.reduce((acc, p) => acc.plus(p.unreturnedCapital), ZERO);
        if (owedTotal.lessThanOrEqualTo(0)) continue;
        const paid = Decimal.min(remaining, owedTotal);
        for (const partner of partners) {
          if (partner.unreturnedCapital.lessThanOrEqualTo(0)) continue;
          const amount = paid.times(partner.unreturnedCapital).dividedBy(owedTotal);
          partner.unreturnedCapital = partner.unreturnedCapital.minus(amount);
          creditPartner(partner, tier.id, amount, i);
        }
        remaining = remaining.minus(paid);
        continue;
      }

      if (tier.type === 'catch_up') {
        const target = d(tier.catchUpTargetShare ?? '0').clamp(0, new Decimal('0.999'));
        if (target.isZero()) continue;
        const recipients = tier.splits.filter((split) => d(split.share).greaterThan(0));
        // `profitDistributed` is keyed by `partner.key` (the partner object),
        // not the split's own `partnerId` (the user-facing id, which more
        // than one partner object can share) — every recipient id is
        // resolved to however many partner objects actually carry it.
        const sponsorProfit = recipients.reduce(
          (acc, split) =>
            partners
              .filter((p) => p.id === split.partnerId)
              .reduce((inner, p) => inner.plus(profitDistributed.get(p.key) as Decimal), acc),
          ZERO,
        );
        const otherProfit = partners
          .filter((p) => !recipients.some((r) => r.partnerId === p.id))
          .reduce((acc, p) => acc.plus(profitDistributed.get(p.key) as Decimal), ZERO);
        // Bring sponsor profit up to `target` of total profit distributed.
        const needed = otherProfit.times(target).dividedBy(ONE.minus(target)).minus(sponsorProfit);
        if (needed.lessThanOrEqualTo(0)) continue;
        const paid = Decimal.min(remaining, needed);
        distributeBySplits(partners, splits, paid, tier.id, i, profitDistributed);
        remaining = remaining.minus(paid);
        continue;
      }

      // residual_split consumes everything that is left.
      distributeBySplits(partners, splits, remaining, tier.id, i, profitDistributed);
      remaining = ZERO;
    }

    if (remaining.greaterThan(0)) {
      // Nothing left to allocate the residual to: fall back to ownership shares
      // so cash is never lost, and record it. Shares summing to zero get the
      // same even split `contribute` above already gives a capital call —
      // using `partner.share` directly here would multiply every partner's
      // allocation by zero and silently drop this remaining cash instead.
      for (const partner of partners) {
        const effectiveShare = sharesAreUseless ? ONE : partner.share;
        const amount = remaining.times(effectiveShare).dividedBy(normalise);
        creditPartner(partner, 'residual', amount, i);
      }
      ctx.trace.warn(
        'WATERFALL_RESIDUAL_UNALLOCATED',
        'The waterfall has no residual split tier. Cash remaining after the defined tiers was allocated on contribution shares.',
        'equity',
        'tiers',
      );
    }
  }

  /*
   * Dates for the day-count IRR: closing sits on the first period's start, and
   * every later flow on its period end. This is exactly how the property's own
   * `leveredXirr` is dated, which is what makes the two comparable.
   */
  const zeroDate = calendar.periods[0]?.start;
  const datesFor = (flows: Decimal[], initial: Decimal): DatedCashFlow[] | null => {
    if (!zeroDate) return null;
    const dated: DatedCashFlow[] = [{ date: zeroDate, amount: initial }];
    for (let i = 0; i < flows.length; i += 1) {
      const end = calendar.periods[i]?.end;
      if (!end) return null;
      dated.push({ date: end, amount: flows[i] as Decimal });
    }
    return dated;
  };

  return partners.map((partner) => {
    const flows = partner.flows;
    const irr = irrMonthly(flows, partner.initialFlow);
    const dated = datesFor(flows, partner.initialFlow);
    const annual = dated === null ? null : xirr(dated);
    const all = [partner.initialFlow, ...flows];
    return {
      partnerId: partner.id,
      partnerName: partner.name,
      contributions: partner.contributions.toString(),
      distributions: partner.distributions.toString(),
      profit: partner.distributions.minus(partner.contributions).toString(),
      irr: irr ? irr.toString() : null,
      xirr: annual ? annual.toString() : null,
      equityMultiple: equityMultiple(all)?.toString() ?? null,
      byTier: [...partner.byTier.entries()].map(([tierId, amount]) => ({
        tierId,
        tierName: ctx.structure.tiers.find((tier) => tier.id === tierId)?.name ?? tierId,
        amount: amount.toString(),
      })),
      initialFlow: partner.initialFlow.toString(),
      flows: flows.map((flow) => flow.toString()),
    };
  });
}

function creditPartner(
  partner: PartnerState,
  tierId: string,
  amount: Decimal,
  periodIndex: number,
): void {
  if (amount.lessThanOrEqualTo(0)) return;
  partner.distributions = partner.distributions.plus(amount);
  partner.flows[periodIndex] = (partner.flows[periodIndex] as Decimal).plus(amount);
  partner.byTier.set(tierId, (partner.byTier.get(tierId) ?? ZERO).plus(amount));
}

function distributeBySplits(
  partners: PartnerState[],
  splits: Map<string, Decimal>,
  amount: Decimal,
  tierId: string,
  periodIndex: number,
  profitDistributed: Map<string, Decimal>,
): void {
  if (amount.lessThanOrEqualTo(0)) return;
  const shareTotal = [...splits.values()].reduce((acc, v) => acc.plus(v), ZERO);
  if (shareTotal.isZero()) return;
  // Iterates the *splits* — one per distinct partner id named in the tier —
  // rather than the partner objects. A split's own allocation is fixed
  // regardless of how many partner objects happen to share the id it names;
  // dividing it across however many match (ordinarily exactly one) is what
  // stops a duplicate id from having that allocation credited in full to
  // each of them, which would pay out more than this tier actually has.
  for (const [partnerId, share] of splits) {
    if (share.isZero()) continue;
    const recipients = partners.filter((partner) => partner.id === partnerId);
    if (recipients.length === 0) continue;
    const allocation = amount.times(share).dividedBy(shareTotal);
    const perRecipient = allocation.dividedBy(recipients.length);
    for (const partner of recipients) {
      creditPartner(partner, tierId, perRecipient, periodIndex);
      profitDistributed.set(
        partner.key,
        (profitDistributed.get(partner.key) as Decimal).plus(perRecipient),
      );
    }
  }
}

export interface SponsorFeeContext {
  calendar: ForecastCalendar;
  structure: EquityStructure;
  effectiveGrossRevenue: Decimal[];
  acquisitionBasis: Decimal;
  grossSalePrice: Decimal;
  saleIndex: number | null;
  /**
   * Capital expenditure incurred in each period, as a positive amount.
   *
   * The basis for a development fee. Incurred rather than budgeted: a fee on a
   * budget is earned by writing the budget, and an underspend would pay the
   * sponsor for work nobody did. The incurred figure is also the one the
   * platform actually holds.
   *
   * Tenant improvements and leasing commissions are excluded. They are leasing
   * costs, and a leasing commission already compensates that work; charging a
   * development fee on top would pay for it twice.
   */
  capitalExpenditure: Decimal[];
  /** Debt proceeds drawn in each period, the basis for a refinance fee. */
  debtProceeds: Decimal[];
  trace: TraceRecorder;
}

/**
 * Sponsor fees paid out of property cash flow before partner distributions.
 * Fee bases: acquisition on the acquisition basis at time zero, asset
 * management on effective gross revenue monthly, disposition on the gross sale
 * price at the sale date.
 */
export function computeSponsorFees(ctx: SponsorFeeContext): {
  total: Decimal[];
  atClose: Decimal;
} {
  const n = ctx.calendar.periods.length;
  const total = zeros(n);
  let atClose = ZERO;

  for (const fee of ctx.structure.fees) {
    const percent = d(fee.percent);
    if (percent.isZero()) continue;
    switch (fee.type) {
      case 'acquisition':
        atClose = atClose.plus(ctx.acquisitionBasis.times(percent));
        break;
      case 'asset_management':
        for (let i = 0; i < n; i += 1) {
          total[i] = (total[i] as Decimal).plus(
            (ctx.effectiveGrossRevenue[i] ?? ZERO).times(percent),
          );
        }
        break;
      case 'disposition':
        if (ctx.saleIndex !== null && ctx.saleIndex < n) {
          total[ctx.saleIndex] = (total[ctx.saleIndex] as Decimal).plus(
            ctx.grossSalePrice.times(percent),
          );
        }
        break;
      case 'development':
        // Charged as cost is incurred, which is when the work it pays for is
        // done. A lump sum at the start would pay the sponsor before the
        // building exists, and one at the end would misstate the equity the
        // project needs while it is being built.
        for (let i = 0; i < n; i += 1) {
          total[i] = (total[i] as Decimal).plus((ctx.capitalExpenditure[i] ?? ZERO).times(percent));
        }
        break;
      case 'refinance':
        /*
         * On proceeds drawn *after* the first funding period.
         *
         * The initial funding is the acquisition loan. Charging a refinance fee
         * on it would pay the sponsor twice for one financing — the acquisition
         * fee already covers putting the deal together — and would quietly
         * inflate every levered return on a model that never refinanced at all.
         */
        for (let i = 1; i < n; i += 1) {
          total[i] = (total[i] as Decimal).plus((ctx.debtProceeds[i] ?? ZERO).times(percent));
        }
        break;
      default: {
        /*
         * Every fee type the schema allows now has a basis, so this is
         * unreachable and TypeScript narrows `fee.type` to `never` to say so.
         * The assignment below is what makes adding a type to the schema a
         * compile error here rather than a fee that silently is not charged —
         * which is how `development` and `refinance` sat unbilled until now.
         */
        const unhandled: never = fee.type;
        ctx.trace.diagnostic(
          'FEE_TYPE_NOT_MODELLED',
          'informational',
          `The fee "${fee.name}" has a type this engine does not charge (${String(unhandled)}).`,
          `fee:${fee.id}`,
          'type',
        );
      }
    }
  }

  if (ctx.structure.fees.length > 0) {
    ctx.trace.record({
      target: 'equity:sponsorFees',
      formula: 'equity.sponsorFees',
      description: 'Sponsor fees charged against property cash flow before partner distributions.',
      inputs: traceInputs({
        feeCount: ctx.structure.fees.length,
        acquisitionBasis: ctx.acquisitionBasis,
        grossSalePrice: ctx.grossSalePrice,
      }),
      result: total.reduce((acc, v) => acc.plus(v), atClose).toString(),
      sources: ['equity'],
    });
  }

  return { total, atClose };
}

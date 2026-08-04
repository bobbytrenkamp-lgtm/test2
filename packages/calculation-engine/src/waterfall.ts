import type { EquityStructure, WaterfallDistribution } from '@cre/domain-models';
import { Decimal, ONE, TWELVE, ZERO, d, zeros } from './decimal.js';
import type { ForecastCalendar } from './calendar.js';
import { equityMultiple, irrMonthly } from './metrics.js';
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

  const partners: PartnerState[] = structure.partners.map((partner) => ({
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
  if (!shareTotal.isZero() && shareTotal.minus(ONE).abs().greaterThan('0.0001')) {
    ctx.trace.warn(
      'PARTNER_SHARES_DO_NOT_SUM',
      `Partner contribution shares sum to ${shareTotal.toFixed(4)} rather than 1. Contributions were normalised proportionally.`,
      'equity',
      'partners',
    );
  }
  const normalise = shareTotal.isZero() ? ONE : shareTotal;

  /** Accrued but unpaid preferred, by tier and partner. */
  const accrued = new Map<string, Map<string, Decimal>>();
  for (const tier of structure.tiers) {
    accrued.set(tier.id, new Map(partners.map((p) => [p.id, ZERO])));
  }
  /** Cumulative profit distributions, used by catch-up tiers. */
  const profitDistributed = new Map<string, Decimal>(partners.map((p) => [p.id, ZERO]));

  const contribute = (amount: Decimal, periodIndex: number | null): void => {
    for (const partner of partners) {
      const allocation = amount.times(partner.share).dividedBy(normalise);
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
        const unpaid = balances.get(partner.id) as Decimal;
        const base = tier.compounding
          ? partner.unreturnedCapital.plus(unpaid)
          : partner.unreturnedCapital;
        balances.set(partner.id, unpaid.plus(base.times(monthlyRate)));
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
        const owed = partners.map((partner) => balances.get(partner.id) as Decimal);
        const owedTotal = owed.reduce((acc, v) => acc.plus(v), ZERO);
        if (owedTotal.lessThanOrEqualTo(0)) continue;
        const paid = Decimal.min(remaining, owedTotal);
        for (let p = 0; p < partners.length; p += 1) {
          const partner = partners[p] as PartnerState;
          const partnerOwed = owed[p] as Decimal;
          if (partnerOwed.lessThanOrEqualTo(0)) continue;
          const amount = paid.times(partnerOwed).dividedBy(owedTotal);
          balances.set(partner.id, partnerOwed.minus(amount));
          creditPartner(partner, tier.id, amount, i);
          profitDistributed.set(
            partner.id,
            (profitDistributed.get(partner.id) as Decimal).plus(amount),
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
        const sponsorProfit = recipients.reduce(
          (acc, split) => acc.plus(profitDistributed.get(split.partnerId) ?? ZERO),
          ZERO,
        );
        const otherProfit = partners
          .filter((p) => !recipients.some((r) => r.partnerId === p.id))
          .reduce((acc, p) => acc.plus(profitDistributed.get(p.id) as Decimal), ZERO);
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
      // so cash is never lost, and record it.
      for (const partner of partners) {
        const amount = remaining.times(partner.share).dividedBy(normalise);
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

  return partners.map((partner) => {
    const flows = partner.flows;
    const irr = irrMonthly(flows, partner.initialFlow);
    const all = [partner.initialFlow, ...flows];
    return {
      partnerId: partner.id,
      partnerName: partner.name,
      contributions: partner.contributions.toString(),
      distributions: partner.distributions.toString(),
      profit: partner.distributions.minus(partner.contributions).toString(),
      irr: irr ? irr.toString() : null,
      equityMultiple: equityMultiple(all)?.toString() ?? null,
      byTier: [...partner.byTier.entries()].map(([tierId, amount]) => ({
        tierId,
        tierName: ctx.structure.tiers.find((tier) => tier.id === tierId)?.name ?? tierId,
        amount: amount.toString(),
      })),
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
  for (const partner of partners) {
    const share = splits.get(partner.id);
    if (!share || share.isZero()) continue;
    const allocation = amount.times(share).dividedBy(shareTotal);
    creditPartner(partner, tierId, allocation, periodIndex);
    profitDistributed.set(
      partner.id,
      (profitDistributed.get(partner.id) as Decimal).plus(allocation),
    );
  }
}

export interface SponsorFeeContext {
  calendar: ForecastCalendar;
  structure: EquityStructure;
  effectiveGrossRevenue: Decimal[];
  acquisitionBasis: Decimal;
  grossSalePrice: Decimal;
  saleIndex: number | null;
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
      default:
        ctx.trace.diagnostic(
          'FEE_TYPE_NOT_MODELLED',
          'informational',
          `The ${fee.type.replace(/_/g, ' ')} fee "${fee.name}" has no cash-flow basis in this model and was not charged. Development and refinance fee bases are not yet implemented.`,
          `fee:${fee.id}`,
          'type',
        );
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

import type { ModelInput, ModelResult } from '@cre/domain-models';
import { Decimal, ZERO, d } from './decimal.js';
import { monthDifference, parseDate } from './calendar.js';

/**
 * Underwriting health.
 *
 * What an experienced reviewer looks for in ten minutes with somebody else's
 * model: where the risk is concentrated, where an assumption is doing more work
 * than it looks like, and whether the arithmetic hangs together.
 *
 * ## Every finding is a rule, not a score
 *
 * There is deliberately no overall number. A model reduced to "72 out of 100"
 * invites an argument about the 72 and hides the four things that actually
 * matter, and any weighting used to produce it would be an opinion presented as
 * a measurement.
 *
 * Each finding therefore states:
 *
 * - **what** the model does,
 * - **the threshold** it crossed, in the finding's own words, so a reader can
 *   disagree with the threshold rather than with the tool, and
 * - **where to go** to change it.
 *
 * Nothing here is a judgement about whether the deal is good. A model can be
 * entirely sound and still have 31% of its rent in one tenant; that is a fact
 * about the asset, and the reviewer decides what it means.
 *
 * ## Where the numbers come from
 *
 * Only from `ModelInput` and the `ModelResult` the engine already produced. No
 * rule recalculates anything: a health panel that derived its own NOI could
 * disagree with the cash-flow statement beside it, and the reader would have no
 * way to tell which was wrong.
 */

export type FindingSeverity = 'warning' | 'note' | 'pass';

export interface HealthFinding {
  /** Stable identifier, so a finding can be linked to and dismissed later. */
  id: string;
  severity: FindingSeverity;
  /** One line, stating the fact. */
  title: string;
  /** Why it is worth knowing, and what the threshold was. */
  detail: string;
  /** Where in the product to act on it. */
  link?: { tab: string; query?: Record<string, string> };
}

export interface HealthReport {
  findings: HealthFinding[];
  warnings: number;
  notes: number;
  passes: number;
}

/* -------------------------------------------------------------------------- */
/* Thresholds, gathered so they can be read and argued with in one place       */
/* -------------------------------------------------------------------------- */

export const HEALTH_THRESHOLDS = {
  /** Share of rentable area expiring inside any rolling 24 months. */
  rollingExpiryArea: 0.2,
  /** Share of base rent in a single tenant. */
  tenantConcentration: 0.25,
  /** Minimum DSCR below which a lender's covenant is usually in sight. */
  minimumDscr: 1.25,
  /** How far the exit cap may sit below the going-in cap before it is flagged. */
  capRateCompression: 0.0025,
  /** Share of terminal NOI growth attributable to rollover rather than contract. */
  rolloverDrivenGrowth: 0.4,
  /** How far a lease's rent may sit below market before it is worth saying. */
  belowMarket: 0.15,
  /** Tolerance when reconciling areas, as a share of rentable area. */
  areaTolerance: 0.005,
} as const;

/* -------------------------------------------------------------------------- */

export function assessHealth(input: ModelInput, result: ModelResult): HealthReport {
  const findings: HealthFinding[] = [
    ...expiryConcentration(input, result),
    ...tenantConcentration(input, result),
    ...capRateRelationship(input, result),
    ...debtCovenantHeadroom(result),
    ...rolloverDependence(result),
    ...belowMarketLeases(input),
    ...missingValuationInputs(input),
    ...areaReconciliation(input, result),
    ...debtRetired(input, result),
    ...engineDiagnostics(result),
  ];

  return {
    findings,
    warnings: findings.filter((finding) => finding.severity === 'warning').length,
    notes: findings.filter((finding) => finding.severity === 'note').length,
    passes: findings.filter((finding) => finding.severity === 'pass').length,
  };
}

/* -------------------------------------------------------------------------- */

const percent = (value: Decimal | number): string =>
  `${(typeof value === 'number' ? value * 100 : value.times(100).toNumber()).toFixed(1)}%`;

function sum(values: string[]): Decimal {
  return values.reduce<Decimal>((total, value) => total.plus(d(value)), ZERO);
}

/**
 * The worst rolling 24 months of expiry, by area.
 *
 * Rolling rather than by calendar year, because a lease roll is a cliff
 * wherever it lands: 19% expiring in December and 19% the following January is
 * 38% in two months, and a per-year view reports two unremarkable years.
 */
function expiryConcentration(input: ModelInput, result: ModelResult): HealthFinding[] {
  const rentable = d(input.property.rentableArea ?? '0');
  if (rentable.lessThanOrEqualTo(0) || input.leases.length === 0) return [];

  const start = parseDate(input.forecast.startDate);
  const horizon = input.forecast.months;
  const byMonth = new Array<Decimal>(horizon + 1).fill(ZERO);

  for (const lease of input.leases) {
    if (!lease.expirationDate) continue;
    const month = monthDifference(start, parseDate(lease.expirationDate));
    if (month < 0 || month > horizon) continue;
    byMonth[month] = (byMonth[month] as Decimal).plus(d(lease.area));
  }

  let worst = { share: ZERO, from: 0 };
  for (let from = 0; from <= horizon; from += 1) {
    let window = ZERO;
    for (let i = from; i < Math.min(from + 24, horizon + 1); i += 1) {
      window = window.plus(byMonth[i] as Decimal);
    }
    const share = window.dividedBy(rentable);
    if (share.greaterThan(worst.share)) worst = { share, from };
  }

  if (worst.share.lessThan(HEALTH_THRESHOLDS.rollingExpiryArea)) {
    return [
      {
        id: 'expiry.concentration',
        severity: 'pass',
        title: 'No heavy expiry cliff in the forecast',
        detail: `The worst rolling 24 months carry ${percent(worst.share)} of rentable area, below the ${percent(HEALTH_THRESHOLDS.rollingExpiryArea)} the panel flags.`,
      },
    ];
  }

  const period = result.periods[worst.from] ?? result.periods[0];
  return [
    {
      id: 'expiry.concentration',
      severity: 'warning',
      title: `${percent(worst.share)} of area expires within 24 months of ${period?.startDate.slice(0, 7) ?? 'the forecast start'}`,
      detail:
        `Measured on a rolling window rather than by calendar year, because a roll is a cliff ` +
        `wherever it lands. Above ${percent(HEALTH_THRESHOLDS.rollingExpiryArea)} the downtime, ` +
        `tenant improvements and leasing commissions on the market leasing assumptions are ` +
        `carrying a large share of the forecast.`,
      link: { tab: 'rent-roll' },
    },
  ];
}

/**
 * The largest tenant's share of contractual base rent.
 *
 * Measured over **signed leases only**. Speculative lease-up is space the
 * engine fills at market because nothing is contracted for it; counting it as
 * a tenant would report a fictional name as the largest credit exposure on any
 * model with meaningful vacancy — which is precisely a model where the real
 * concentration question matters. Concentration is a question about who owes
 * the rent, and nobody owes speculative rent yet.
 */
function tenantConcentration(input: ModelInput, result: ModelResult): HealthFinding[] {
  if (result.leaseCashFlows.length === 0) return [];
  const signed = new Set(input.leases.map((lease) => lease.id));
  if (signed.size === 0) return [];

  const byTenant = new Map<string, Decimal>();
  for (const row of result.leaseCashFlows) {
    // A rollover branch of a signed lease is still that tenant; a speculative
    // row has no signed lease behind it and is left out.
    const source = row.rolloverOf ?? row.leaseId;
    if (!signed.has(source) && !signed.has(row.leaseId)) continue;
    // The first twelve months, so a mid-forecast rollover does not make a
    // tenant look larger than they are on day one.
    const first = sum(row.baseRent.slice(0, 12));
    byTenant.set(row.tenantName, (byTenant.get(row.tenantName) ?? ZERO).plus(first));
  }
  if (byTenant.size === 0) return [];
  const total = [...byTenant.values()].reduce<Decimal>((a, b) => a.plus(b), ZERO);
  if (total.lessThanOrEqualTo(0)) return [];

  const [largestName, largestAmount] = [...byTenant.entries()].sort((a, b) =>
    b[1].minus(a[1]).toNumber(),
  )[0] as [string, Decimal];
  const share = largestAmount.dividedBy(total);

  if (share.lessThan(HEALTH_THRESHOLDS.tenantConcentration)) {
    return [
      {
        id: 'tenant.concentration',
        severity: 'pass',
        title: 'No single tenant dominates the rent roll',
        detail: `The largest, ${largestName}, is ${percent(share)} of year-one base rent, below the ${percent(HEALTH_THRESHOLDS.tenantConcentration)} the panel flags.`,
      },
    ];
  }
  return [
    {
      id: 'tenant.concentration',
      severity: 'warning',
      title: `${largestName} is ${percent(share)} of year-one base rent`,
      detail:
        `Measured over the first twelve months of signed leases only, so a mid-forecast ` +
        `rollover does not distort it and speculative lease-up is not counted as a tenant. ` +
        `Concentration is a fact about the asset rather than a fault in the model, but above ` +
        `${percent(HEALTH_THRESHOLDS.tenantConcentration)} the renewal assumption on this one ` +
        `lease moves the valuation more than most of the rest of the rent roll together.`,
      link: { tab: 'rent-roll', query: { lease: largestName } },
    },
  ];
}

/**
 * An exit cap below the going-in cap.
 *
 * The single most effective way to make a deal work on paper. It is not
 * automatically wrong — a property being stabilised out of vacancy may
 * genuinely re-rate — but it is an assumption that should be argued for rather
 * than arrived at, so the panel says when it has been made.
 */
function capRateRelationship(input: ModelInput, result: ModelResult): HealthFinding[] {
  const exit = input.valuation.terminalCapRate;
  const goingIn = result.returns.goingInCapRate;
  if (!exit || !goingIn) return [];

  const difference = d(goingIn).minus(d(exit));
  if (difference.lessThanOrEqualTo(HEALTH_THRESHOLDS.capRateCompression)) {
    return [
      {
        id: 'valuation.capSpread',
        severity: 'pass',
        title: 'Exit capitalisation rate is not below the going-in rate',
        detail: `Going in at ${percent(d(goingIn))}, out at ${percent(d(exit))}.`,
      },
    ];
  }
  return [
    {
      id: 'valuation.capSpread',
      severity: 'warning',
      title: `Exit cap rate is ${difference.times(10000).toFixed(0)} bps below the going-in rate`,
      detail:
        `Going in at ${percent(d(goingIn))}, out at ${percent(d(exit))}. Compressing the exit ` +
        `rate is the most effective way to make a deal work on paper. It can be right — a ` +
        `property being stabilised out of vacancy may genuinely re-rate — but it is an ` +
        `assumption to argue for rather than to arrive at.`,
      link: { tab: 'assumptions' },
    },
  ];
}

function debtCovenantHeadroom(result: ModelResult): HealthFinding[] {
  const minimum = result.returns.minimumDscr;
  if (!minimum) return [];
  const value = d(minimum);

  const breaches = result.debtSchedules.flatMap((schedule) =>
    schedule.covenantBreaches.map((breach) => ({ schedule, breach })),
  );
  if (breaches.length > 0) {
    const first = breaches[0];
    return [
      {
        id: 'debt.covenant',
        severity: 'warning',
        title: `${breaches.length} covenant breach${breaches.length === 1 ? '' : 'es'} in the forecast`,
        detail:
          `First on ${first?.schedule.facilityName} in month ${first?.breach.periodIndex}: ` +
          `${first?.breach.covenant} at ${Number(first?.breach.value).toFixed(3)} against a ` +
          `limit of ${Number(first?.breach.limit).toFixed(3)}. A breach the model reports but ` +
          `does not act on overstates the levered return in exactly the years a lender is most ` +
          `worried about; set a cash trap on the facility if one applies.`,
        link: { tab: 'assumptions' },
      },
    ];
  }

  if (value.lessThan(HEALTH_THRESHOLDS.minimumDscr)) {
    return [
      {
        id: 'debt.dscr',
        severity: 'warning',
        title: `Minimum debt service coverage is ${value.toFixed(2)}x`,
        detail:
          `Below ${HEALTH_THRESHOLDS.minimumDscr.toFixed(2)}x, which is where a lender's ` +
          `covenant usually sits. No covenant is set on any facility here, so the model does ` +
          `not test one — the ratio is stated so the absence is a choice rather than an ` +
          `oversight.`,
        link: { tab: 'assumptions' },
      },
    ];
  }
  return [
    {
      id: 'debt.dscr',
      severity: 'pass',
      title: `Minimum debt service coverage is ${value.toFixed(2)}x`,
      detail: `At or above the ${HEALTH_THRESHOLDS.minimumDscr.toFixed(2)}x the panel flags, and no covenant is breached.`,
    },
  ];
}

/**
 * How much of the NOI growth comes from rollover rather than from contract.
 *
 * Contractual escalation is signed; rollover growth is a forecast about a
 * market. A model whose growth is mostly the second is a market bet, and worth
 * knowing as one.
 */
function rolloverDependence(result: ModelResult): HealthFinding[] {
  if (result.annual.length < 2) return [];
  const first = result.annual[0];
  const last = result.annual[result.annual.length - 1];
  if (!first || !last) return [];

  const growth = d(last.lines.netOperatingIncome).minus(d(first.lines.netOperatingIncome));
  if (growth.lessThanOrEqualTo(0)) return [];

  /*
   * Rollover contribution, measured as the share of the final year's base rent
   * produced by rows the engine generated rather than by contract leases. It
   * is an attribution, not a decomposition of the growth itself — saying so
   * matters, because the two are not the same number.
   */
  const finalPeriod = result.periods.length - 1;
  let contract = ZERO;
  let generated = ZERO;
  for (const row of result.leaseCashFlows) {
    const value = d(row.baseRent[finalPeriod] ?? '0');
    if (row.scenario && row.scenario !== 'contract') generated = generated.plus(value);
    else contract = contract.plus(value);
  }
  const total = contract.plus(generated);
  if (total.lessThanOrEqualTo(0)) return [];
  const share = generated.dividedBy(total);

  if (share.lessThan(HEALTH_THRESHOLDS.rolloverDrivenGrowth)) {
    return [
      {
        id: 'growth.rollover',
        severity: 'pass',
        title: 'Most of the terminal rent is contractual',
        detail: `${percent(share)} of final-year base rent comes from modelled rollover rather than from signed leases.`,
      },
    ];
  }
  return [
    {
      id: 'growth.rollover',
      severity: 'note',
      title: `${percent(share)} of final-year base rent comes from modelled rollover`,
      detail:
        `Contractual escalation is signed; rollover rent is a forecast about a market. Above ` +
        `${percent(HEALTH_THRESHOLDS.rolloverDrivenGrowth)} the terminal value rests mostly on ` +
        `the market leasing assumptions rather than on leases anybody has agreed to. That is a ` +
        `market bet, which may be the right one — it is flagged so it is a deliberate one.`,
      link: { tab: 'assumptions' },
    },
  ];
}

/** Leases sitting materially below the market rent the model itself uses. */
function belowMarketLeases(input: ModelInput): HealthFinding[] {
  const profiles = new Map(input.marketLeasingProfiles.map((profile) => [profile.id, profile]));
  const fallback = input.defaultMarketLeasingProfileId
    ? profiles.get(input.defaultMarketLeasingProfileId)
    : undefined;

  // `id` on a model input *is* the lease code — the engine's identifiers are
  // the codes an analyst sees, which is what makes a trace readable.
  const below: Array<{ code: string; gap: Decimal }> = [];
  for (const lease of input.leases) {
    const profile = lease.marketLeasingProfileId
      ? (profiles.get(lease.marketLeasingProfileId) ?? fallback)
      : fallback;
    if (!profile) continue;
    const market = d(profile.marketRent);
    if (market.lessThanOrEqualTo(0)) continue;
    // Comparable only on the same basis; converting here would be a second
    // implementation of the engine's own basis arithmetic.
    if (lease.baseRentBasis !== profile.marketRentBasis) continue;

    const gap = market.minus(d(lease.baseRent)).dividedBy(market);
    if (gap.greaterThan(HEALTH_THRESHOLDS.belowMarket)) below.push({ code: lease.id, gap });
  }

  if (below.length === 0) return [];
  below.sort((a, b) => b.gap.minus(a.gap).toNumber());
  const worst = below[0] as { code: string; gap: Decimal };
  return [
    {
      id: 'leases.belowMarket',
      severity: 'note',
      title: `${below.length} lease${below.length === 1 ? ' sits' : 's sit'} more than ${percent(HEALTH_THRESHOLDS.belowMarket)} below market`,
      detail:
        `The largest gap is ${worst.code}, ${percent(worst.gap)} below the market rent on its ` +
        `own profile. Below-market rent is upside on rollover and downside on renewal ` +
        `probability at once, so it is worth knowing which leases carry it. Only leases quoted ` +
        `on the same basis as their profile are compared.`,
      link: { tab: 'rent-roll', query: { lease: worst.code } },
    },
  ];
}

function missingValuationInputs(input: ModelInput): HealthFinding[] {
  const missing: string[] = [];
  if (!input.valuation.discountRate) missing.push('a discount rate');
  if (!input.valuation.terminalCapRate && !input.valuation.grossSalePriceOverride) {
    missing.push('an exit capitalisation rate or a sale price');
  }
  if (!input.valuation.acquisitionPrice) missing.push('a purchase price');

  if (missing.length === 0) {
    return [
      {
        id: 'valuation.inputs',
        severity: 'pass',
        title: 'Every required valuation input is set',
        detail: 'Discount rate, exit assumption and purchase price are all present.',
      },
    ];
  }
  return [
    {
      id: 'valuation.inputs',
      severity: 'warning',
      title: `The model is missing ${missing.join(', ')}`,
      detail:
        'The engine reports an unavailable figure rather than a zero for anything it cannot ' +
        'compute, so a missing input shows as "Not available" on the Returns tab rather than ' +
        'as a 0% return.',
      link: { tab: 'assumptions' },
    },
  ];
}

/** Leased area against the building, which is the recovery denominator. */
function areaReconciliation(input: ModelInput, result: ModelResult): HealthFinding[] {
  const rentable = d(input.property.rentableArea ?? '0');
  if (rentable.lessThanOrEqualTo(0)) return [];
  const spaces = input.spaces.reduce<Decimal>((total, space) => total.plus(d(space.area)), ZERO);
  if (spaces.lessThanOrEqualTo(0)) return [];

  const gap = spaces.minus(rentable).abs().dividedBy(rentable);
  if (gap.lessThanOrEqualTo(HEALTH_THRESHOLDS.areaTolerance)) {
    return [
      {
        id: 'area.reconciles',
        severity: 'pass',
        title: 'Space area reconciles to the building',
        detail: `${spaces.toFixed(0)} across ${input.spaces.length} space(s) against ${rentable.toFixed(0)} rentable.`,
      },
    ];
  }
  return [
    {
      id: 'area.reconciles',
      severity: 'warning',
      title: `Space area is ${percent(gap)} away from the building's rentable area`,
      detail:
        `${spaces.toFixed(0)} across ${input.spaces.length} space(s) against ${rentable.toFixed(0)} ` +
        `rentable. The space list is the denominator for every pro-rata recovery share, so a gap ` +
        `here misstates what every tenant reimburses — and occupancy with it. ` +
        `Result reports ${result.occupancy.length} occupancy period(s) against that denominator.`,
      link: { tab: 'rent-roll' },
    },
  ];
}

function debtRetired(input: ModelInput, result: ModelResult): HealthFinding[] {
  if (input.debt.length === 0) return [];
  if (result.debtSchedules.length < input.debt.length) {
    // At least one facility was refused by `computeDebt` outright (a
    // non-positive term, a funding date before the forecast start) and has
    // no schedule at all — `engineDiagnostics` already surfaces why, as a
    // critical error. Summing `debtSchedules` here would read the *absence*
    // of a schedule as a zero balance and report "fully repaid" — a false
    // all-clear on a facility whose real balance is unknown, not zero, and
    // whose debt service never reached the levered return this same panel
    // reports elsewhere. Say nothing rather than say something false; the
    // engine-error finding already tells the analyst where to look.
    return [];
  }
  const last = result.debtSchedules
    .map((schedule) => d(schedule.rows[schedule.rows.length - 1]?.endingBalance ?? '0'))
    .reduce<Decimal>((a, b) => a.plus(b), ZERO);

  if (last.abs().lessThan(1)) {
    return [
      {
        id: 'debt.retired',
        severity: 'pass',
        title: 'Debt is fully repaid by the end of the forecast',
        detail: 'No facility carries a balance past the modelled disposition.',
      },
    ];
  }
  return [
    {
      id: 'debt.retired',
      severity: 'warning',
      title: `${last.toFixed(0)} of debt is still outstanding at the end of the forecast`,
      detail:
        'A facility that outlives the forecast is either a maturity the model does not resolve ' +
        'or a payoff the disposition does not carry. Either way the levered return is being ' +
        'reported on an equity position that was never actually returned.',
      link: { tab: 'returns' },
    },
  ];
}

/** The engine's own diagnostics, which are already deterministic findings. */
function engineDiagnostics(result: ModelResult): HealthFinding[] {
  const errors = result.diagnostics.filter((entry) => entry.severity === 'error');
  const warnings = result.diagnostics.filter((entry) => entry.severity === 'warning');

  const findings: HealthFinding[] = [];
  if (errors.length > 0) {
    findings.push({
      id: 'engine.errors',
      severity: 'warning',
      title: `The engine reported ${errors.length} critical error${errors.length === 1 ? '' : 's'}`,
      detail: errors
        .slice(0, 3)
        .map((entry) => entry.message)
        .join(' '),
      link: { tab: 'validation' },
    });
  } else {
    findings.push({
      id: 'engine.errors',
      severity: 'pass',
      title: 'The engine reported no critical errors',
      detail: `${warnings.length} warning(s) and ${result.diagnostics.length - warnings.length - errors.length} informational finding(s).`,
    });
  }
  return findings;
}

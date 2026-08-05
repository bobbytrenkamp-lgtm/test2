import type {
  Lease,
  MarketLeasingProfile,
  RecoveryConfig,
  RentBasis,
  Space,
} from '@cre/domain-models';
import { Decimal, ONE, ZERO, d, zeros } from './decimal.js';
import {
  type CalendarDate,
  type ForecastCalendar,
  addDays,
  addMonths,
  compareDates,
  formatDate,
  monthDifference,
  parseDate,
  periodCoverage,
} from './calendar.js';
import type { CurveSet } from './curves.js';
import {
  type RentScheduleSpec,
  freeRentRange,
  monthlyRentFromBasis,
  rentForPeriod,
} from './rent-schedule.js';
import { TraceRecorder, traceInputs } from './trace.js';
import { expandOptions } from './lease-options.js';

/**
 * A single occupancy of space by a tenant over a date range, at a probability
 * weight. Contract leases are weight 1. Rollover produces a renewal branch at
 * the renewal probability and a new-lease branch at its complement, which is
 * the probability-weighted approach institutional models use rather than
 * committing the forecast to a single guessed outcome.
 */
export interface LeaseOccurrence {
  id: string;
  sourceLeaseId: string;
  tenantId: string;
  tenantName: string;
  scenario: 'contract' | 'renewal' | 'new_lease';
  weight: Decimal;
  generation: number;
  spaceIds: string[];
  area: Decimal;
  unitCount: number;
  commencement: CalendarDate;
  rentStart: CalendarDate;
  expiration: CalendarDate;
  schedule: RentScheduleSpec;
  freeRent: Array<{ from: CalendarDate; to: CalendarDate; share: Decimal; appliesTo: string[] }>;
  percentageRent: Lease['percentageRent'] | null;
  recovery: RecoveryConfig;
  otherRevenue: Array<{
    id: string;
    name: string;
    monthlyAmount: Decimal;
    growthCurveId?: string | null;
  }>;
  /** Tenant improvement cost, already weighted, with its payment date. */
  tiCost: Decimal;
  lcCost: Decimal;
  costDate: CalendarDate;
  marketLeasingProfileId: string | null;
}

export interface NormalizedSpace {
  id: string;
  code: string;
  area: Decimal;
  unitCount: number;
  isNonRevenue: boolean;
  marketLeasingProfileId: string | null;
  synthesized: boolean;
}

/** Weight below which a rollover branch stops being carried forward. */
const WEIGHT_PRUNE_THRESHOLD = new Decimal('0.0001');
/** Hard ceiling on rollover chaining depth, independent of forecast length. */
const MAX_GENERATIONS = 40;

export function normalizeSpaces(
  spaces: Space[],
  leases: Lease[],
  trace: TraceRecorder,
): NormalizedSpace[] {
  const normalized: NormalizedSpace[] = spaces.map((space) => ({
    id: space.id,
    code: space.code,
    area: d(space.area),
    unitCount: space.unitCount,
    isNonRevenue: space.isNonRevenue,
    marketLeasingProfileId: space.marketLeasingProfileId ?? null,
    synthesized: false,
  }));
  const known = new Set(normalized.map((space) => space.id));

  for (const space of normalized) {
    if (space.area.isNegative()) {
      trace.error(
        'NEGATIVE_AREA',
        `Space ${space.code} has a negative area, which is not a valid rentable area.`,
        `space:${space.id}`,
        'area',
      );
    }
  }

  const duplicates = new Set<string>();
  const seen = new Set<string>();
  for (const space of normalized) {
    if (seen.has(space.id)) duplicates.add(space.id);
    seen.add(space.id);
  }
  for (const id of duplicates) {
    trace.error('DUPLICATE_SPACE', `Space id ${id} appears more than once.`, `space:${id}`);
  }

  for (const lease of leases) {
    if (lease.spaceIds.length === 0) {
      const id = `auto:${lease.id}`;
      if (!known.has(id)) {
        known.add(id);
        normalized.push({
          id,
          code: `Lease ${lease.id}`,
          area: d(lease.area),
          unitCount: lease.unitCount,
          isNonRevenue: false,
          marketLeasingProfileId: lease.marketLeasingProfileId ?? null,
          synthesized: true,
        });
        trace.diagnostic(
          'SPACE_SYNTHESIZED',
          'informational',
          `Lease ${lease.id} is not attached to a space. A space was inferred from the lease area so that occupancy and recovery denominators reconcile.`,
          `lease:${lease.id}`,
          'spaceIds',
        );
      }
    } else {
      for (const spaceId of lease.spaceIds) {
        if (!known.has(spaceId)) {
          trace.error(
            'UNKNOWN_SPACE',
            `Lease ${lease.id} references space ${spaceId}, which does not exist.`,
            `lease:${lease.id}`,
            'spaceIds',
          );
        }
      }
    }
  }

  return normalized;
}

export interface RolloverContext {
  calendar: ForecastCalendar;
  curves: CurveSet;
  profiles: Map<string, MarketLeasingProfile>;
  defaultProfileId: string | null;
  spaces: Map<string, NormalizedSpace>;
  trace: TraceRecorder;
  forecastStart: CalendarDate;
  forecastEnd: CalendarDate;
}

/** Market rent for a profile at a given date, grown from the forecast start. */
export function marketRentAt(
  profile: MarketLeasingProfile,
  date: CalendarDate,
  ctx: RolloverContext,
): { amount: Decimal; basis: RentBasis } {
  const offset = Math.max(monthDifference(ctx.forecastStart, date), 0);
  const factor = ctx.curves.factorAtMonthOffset(profile.marketRentGrowthCurveId, offset);
  return { amount: d(profile.marketRent).times(factor), basis: profile.marketRentBasis };
}

/**
 * Resolves which market leasing profile governs a lease or space.
 * Precedence: lease assignment, then space assignment, then the model default.
 * The winner is recorded in the trace so the source of every rollover
 * assumption is visible in the calculation inspector.
 */
export function resolveProfile(
  ctx: RolloverContext,
  leaseProfileId: string | null | undefined,
  spaceIds: string[],
  subject: string,
): MarketLeasingProfile | null {
  const candidates: Array<{ id: string; source: string; precedence: number }> = [];
  if (leaseProfileId && ctx.profiles.has(leaseProfileId)) {
    const profile = ctx.profiles.get(leaseProfileId) as MarketLeasingProfile;
    candidates.push({ id: leaseProfileId, source: 'lease', precedence: profile.precedence + 1000 });
  }
  for (const spaceId of spaceIds) {
    const space = ctx.spaces.get(spaceId);
    if (space?.marketLeasingProfileId && ctx.profiles.has(space.marketLeasingProfileId)) {
      const profile = ctx.profiles.get(space.marketLeasingProfileId) as MarketLeasingProfile;
      candidates.push({
        id: space.marketLeasingProfileId,
        source: `space:${spaceId}`,
        precedence: profile.precedence + 500,
      });
    }
  }
  if (ctx.defaultProfileId && ctx.profiles.has(ctx.defaultProfileId)) {
    const profile = ctx.profiles.get(ctx.defaultProfileId) as MarketLeasingProfile;
    candidates.push({
      id: ctx.defaultProfileId,
      source: 'model_default',
      precedence: profile.precedence,
    });
  }
  if (candidates.length === 0) {
    ctx.trace.warn(
      'NO_MARKET_LEASING_PROFILE',
      `No market leasing assumption applies to ${subject}. Rollover revenue and vacant-space market rent are treated as zero.`,
      subject,
      'marketLeasingProfileId',
    );
    return null;
  }
  candidates.sort((a, b) => b.precedence - a.precedence);
  const winner = candidates[0] as { id: string; source: string; precedence: number };
  ctx.trace.record({
    target: `${subject}:marketLeasingProfile`,
    formula: 'marketLeasing.resolveProfile',
    description: `Market leasing assumption "${ctx.profiles.get(winner.id)?.name ?? winner.id}" applied, selected from ${winner.source}.`,
    inputs: traceInputs({
      candidates: candidates.map((c) => `${c.id}(${c.source})`).join(', '),
      selectedFrom: winner.source,
    }),
    result: winner.id,
    sources: [subject, `profile:${winner.id}`],
  });
  return ctx.profiles.get(winner.id) as MarketLeasingProfile;
}

function occurrenceFromContractLease(lease: Lease, ctx: RolloverContext): LeaseOccurrence {
  const commencement = parseDate(lease.commencementDate);
  const rentStart = lease.rentStartDate ? parseDate(lease.rentStartDate) : commencement;
  const expiration = parseDate(lease.expirationDate);
  const area = d(lease.area);

  if (compareDates(expiration, commencement) < 0) {
    ctx.trace.error(
      'LEASE_DATES_OUT_OF_ORDER',
      `Lease ${lease.id} expires (${lease.expirationDate}) before it commences (${lease.commencementDate}).`,
      `lease:${lease.id}`,
      'expirationDate',
    );
  }
  if (area.isNegative()) {
    ctx.trace.error(
      'NEGATIVE_AREA',
      `Lease ${lease.id} has a negative area.`,
      `lease:${lease.id}`,
      'area',
    );
  }
  for (const step of lease.rentSteps) {
    const stepDate = parseDate(step.startDate);
    if (compareDates(stepDate, commencement) < 0 || compareDates(stepDate, expiration) > 0) {
      ctx.trace.warn(
        'RENT_STEP_OUTSIDE_TERM',
        `Lease ${lease.id} has a rent step dated ${step.startDate}, outside its ${lease.commencementDate}-${lease.expirationDate} term. The step is ignored outside the term.`,
        `lease:${lease.id}`,
        'rentSteps',
      );
    }
  }

  const spaceIds = lease.spaceIds.length > 0 ? lease.spaceIds : [`auto:${lease.id}`];
  const profile = resolveProfile(ctx, lease.marketLeasingProfileId, spaceIds, `lease:${lease.id}`);

  const tiCost = d(lease.leasingCosts.tiTotal).plus(d(lease.leasingCosts.tiPerArea).times(area));
  const lcBase = d(lease.leasingCosts.lcTotal).plus(d(lease.leasingCosts.lcPerArea).times(area));

  return {
    id: lease.id,
    sourceLeaseId: lease.id,
    tenantId: lease.tenantId,
    tenantName: lease.tenantId,
    scenario: 'contract',
    weight: ONE,
    generation: 0,
    spaceIds,
    area,
    unitCount: lease.unitCount,
    commencement,
    rentStart,
    expiration,
    schedule: {
      area,
      unitCount: lease.unitCount,
      rentStart,
      leaseEnd: expiration,
      baseRent: d(lease.baseRent),
      baseRentBasis: lease.baseRentBasis,
      steps: lease.rentSteps
        .map((step) => ({
          startDate: parseDate(step.startDate),
          amount: d(step.amount),
          basis: step.basis,
        }))
        .filter(
          (step) =>
            compareDates(step.startDate, commencement) >= 0 &&
            compareDates(step.startDate, expiration) <= 0,
        )
        .sort((a, b) => compareDates(a.startDate, b.startDate)),
      escalation: lease.escalation,
      marketRentAt: profile ? (date) => marketRentAt(profile, date, ctx) : undefined,
    },
    freeRent: lease.freeRent.map((entry) => {
      const range = freeRentRange(parseDate(entry.startDate), entry.months);
      return { ...range, share: d(entry.abatementShare), appliesTo: entry.appliesTo };
    }),
    percentageRent: lease.percentageRent.enabled ? lease.percentageRent : null,
    recovery: lease.recovery,
    otherRevenue: lease.otherRevenue.map((entry) => ({
      id: entry.id,
      name: entry.name,
      monthlyAmount: d(entry.monthlyAmount),
      growthCurveId: entry.growthCurveId,
    })),
    tiCost,
    lcCost: lcBase,
    costDate: addMonths(commencement, lease.leasingCosts.paymentOffsetMonths),
    marketLeasingProfileId: profile?.id ?? null,
  };
}

/**
 * Builds the renewal and new-lease branches that follow an expiring occurrence,
 * chaining forward until the forecast end.
 */
function rolloverBranches(
  parent: LeaseOccurrence,
  profile: MarketLeasingProfile,
  ctx: RolloverContext,
): LeaseOccurrence[] {
  const renewalProbability = d(profile.renewalProbability).clamp(0, 1);
  const branches: LeaseOccurrence[] = [];
  const dayAfterExpiry = addDays(parent.expiration, 1);

  const specs: Array<{
    scenario: 'renewal' | 'new_lease';
    weight: Decimal;
    start: CalendarDate;
    termMonths: number;
    freeRentMonths: number;
    tiPerArea: Decimal;
    lcPercent: Decimal;
    escalation: MarketLeasingProfile['renewalEscalation'];
  }> = [
    {
      scenario: 'renewal',
      weight: parent.weight.times(renewalProbability),
      start: dayAfterExpiry,
      termMonths: profile.renewalTermMonths,
      freeRentMonths: profile.renewalFreeRentMonths,
      tiPerArea: d(profile.renewalTiPerArea),
      lcPercent: d(profile.renewalLcPercent),
      escalation: profile.renewalEscalation,
    },
    {
      scenario: 'new_lease',
      weight: parent.weight.times(ONE.minus(renewalProbability)),
      start: addMonths(dayAfterExpiry, Math.round(profile.downtimeMonths)),
      termMonths: profile.newLeaseTermMonths,
      freeRentMonths: profile.newFreeRentMonths,
      tiPerArea: d(profile.newTiPerArea),
      lcPercent: d(profile.newLcPercent),
      escalation: profile.newEscalation,
    },
  ];

  for (const spec of specs) {
    if (spec.weight.lessThan(WEIGHT_PRUNE_THRESHOLD)) continue;
    if (compareDates(spec.start, ctx.forecastEnd) > 0) continue;

    const expiration = addDays(addMonths(spec.start, spec.termMonths), -1);
    const market = marketRentAt(profile, spec.start, ctx);
    const id = `${parent.id}>${spec.scenario}@${formatDate(spec.start)}`;

    const monthlyRent = monthlyRentFromBasis(
      market.amount,
      market.basis,
      parent.area,
      parent.unitCount,
    );
    const lcCost = spec.lcPercent.times(monthlyRent).times(spec.termMonths);

    branches.push({
      id,
      sourceLeaseId: parent.sourceLeaseId,
      tenantId: spec.scenario === 'renewal' ? parent.tenantId : `market:${profile.id}`,
      tenantName:
        spec.scenario === 'renewal' ? parent.tenantName : `Market tenant (${profile.name})`,
      scenario: spec.scenario,
      weight: spec.weight,
      generation: parent.generation + 1,
      spaceIds: parent.spaceIds,
      area: parent.area,
      unitCount: parent.unitCount,
      commencement: spec.start,
      rentStart: spec.start,
      expiration,
      schedule: {
        area: parent.area,
        unitCount: parent.unitCount,
        rentStart: spec.start,
        leaseEnd: expiration,
        baseRent: market.amount,
        baseRentBasis: market.basis,
        steps: [],
        escalation: spec.escalation,
        marketRentAt: (date) => marketRentAt(profile, date, ctx),
      },
      freeRent:
        spec.freeRentMonths > 0
          ? [
              {
                ...freeRentRange(spec.start, spec.freeRentMonths),
                share: ONE,
                appliesTo: ['base_rent'],
              },
            ]
          : [],
      percentageRent: null,
      recovery: profile.recovery,
      otherRevenue: [],
      tiCost: spec.tiPerArea.times(parent.area),
      lcCost,
      costDate: spec.start,
      marketLeasingProfileId: profile.id,
    });

    ctx.trace.record({
      target: `occurrence:${id}`,
      formula: 'marketLeasing.rollover',
      description: `${spec.scenario === 'renewal' ? 'Renewal' : 'New lease'} branch generated on expiry of ${parent.id}, weighted at ${spec.weight.toFixed(4)} of the space.`,
      inputs: traceInputs({
        renewalProbability,
        weight: spec.weight,
        downtimeMonths: spec.scenario === 'new_lease' ? profile.downtimeMonths : 0,
        marketRent: market.amount,
        termMonths: spec.termMonths,
        startDate: formatDate(spec.start),
      }),
      result: monthlyRent.toString(),
      sources: [`lease:${parent.sourceLeaseId}`, `profile:${profile.id}`],
    });
  }

  return branches;
}

/**
 * Chains rollover forward from a set of seed occurrences until the forecast
 * ends, returning the seeds together with every branch they generate.
 */
export function expandRollover(seeds: LeaseOccurrence[], ctx: RolloverContext): LeaseOccurrence[] {
  const all = [...seeds];
  const queue = [...seeds];

  while (queue.length > 0) {
    const parent = queue.shift() as LeaseOccurrence;
    if (parent.generation >= MAX_GENERATIONS) continue;
    if (compareDates(parent.expiration, ctx.forecastEnd) >= 0) continue;
    const profile = ctx.profiles.get(parent.marketLeasingProfileId ?? '');
    if (!profile) continue;
    for (const branch of rolloverBranches(parent, profile, ctx)) {
      all.push(branch);
      queue.push(branch);
    }
  }

  return all;
}

/**
 * Expands contract leases into the full set of weighted lease occurrences.
 *
 * A lease first expands into probability-weighted paths according to its
 * options (see `lease-options.ts`). Within a path the occurrences run one after
 * another — a contract term followed by an exercised renewal, say — so only the
 * **last** one is a rollover seed. Rolling over from an earlier occurrence too
 * would let the same space out twice over the same months.
 */
export function buildOccurrences(leases: Lease[], ctx: RolloverContext): LeaseOccurrence[] {
  const seeds: LeaseOccurrence[] = [];
  const fixed: LeaseOccurrence[] = [];

  for (const lease of leases) {
    if (lease.status === 'vacant' || lease.status === 'terminated') continue;
    const base = occurrenceFromContractLease(lease, ctx);

    for (const path of expandOptions(base, lease, ctx)) {
      const tail = path.occurrences[path.occurrences.length - 1];
      if (!tail) continue;
      fixed.push(...path.occurrences.slice(0, -1));
      if (lease.excludeFromRollover) fixed.push(tail);
      else seeds.push(tail);
    }
  }

  return [...fixed, ...expandRollover(seeds, ctx)];
}

/**
 * Speculative lease-up of space that is empty at the start of the forecast.
 *
 * A suite with no lease against it would otherwise sit empty for the whole
 * forecast, which understates value and makes occupancy a flat line. The
 * market leasing profile already states what the space would let for and how
 * long it would take, so that is what governs: the space absorbs after the
 * profile's downtime on the profile's new-lease terms, and then rolls over
 * like any other lease.
 *
 * Space that carries a future or pending lease is left alone. That space is
 * pre-let, and layering a speculative lease on top would double-count it.
 */
export function buildSpeculativeOccurrences(
  spaces: NormalizedSpace[],
  spaceOccupancy: Map<string, Decimal[]>,
  ctx: RolloverContext,
): LeaseOccurrence[] {
  const seeds: LeaseOccurrence[] = [];

  for (const space of spaces) {
    if (space.isNonRevenue || space.area.lessThanOrEqualTo(0)) continue;
    const occupancy = spaceOccupancy.get(space.id);
    if (!occupancy) continue;
    // Only space that is empty for the entire forecast is absorbed here.
    const everOccupied = occupancy.some((value) => value.greaterThan('0.0001'));
    if (everOccupied) continue;

    const profile = resolveProfile(ctx, null, [space.id], `space:${space.id}`);
    if (!profile) continue;

    const start = addMonths(ctx.forecastStart, Math.round(profile.downtimeMonths));
    if (compareDates(start, ctx.forecastEnd) > 0) continue;
    const expiration = addDays(addMonths(start, profile.newLeaseTermMonths), -1);
    const market = marketRentAt(profile, start, ctx);
    const monthlyRent = monthlyRentFromBasis(
      market.amount,
      market.basis,
      space.area,
      space.unitCount,
    );

    const id = `speculative:${space.id}`;
    seeds.push({
      id,
      sourceLeaseId: id,
      tenantId: `market:${profile.id}`,
      tenantName: `Speculative lease-up (${profile.name})`,
      scenario: 'new_lease',
      weight: ONE,
      generation: 0,
      spaceIds: [space.id],
      area: space.area,
      unitCount: space.unitCount,
      commencement: start,
      rentStart: start,
      expiration,
      schedule: {
        area: space.area,
        unitCount: space.unitCount,
        rentStart: start,
        leaseEnd: expiration,
        baseRent: market.amount,
        baseRentBasis: market.basis,
        steps: [],
        escalation: profile.newEscalation,
        marketRentAt: (date) => marketRentAt(profile, date, ctx),
      },
      freeRent:
        profile.newFreeRentMonths > 0
          ? [
              {
                ...freeRentRange(start, profile.newFreeRentMonths),
                share: ONE,
                appliesTo: ['base_rent'],
              },
            ]
          : [],
      percentageRent: null,
      recovery: profile.recovery,
      otherRevenue: [],
      tiCost: d(profile.newTiPerArea).times(space.area),
      lcCost: d(profile.newLcPercent).times(monthlyRent).times(profile.newLeaseTermMonths),
      costDate: start,
      marketLeasingProfileId: profile.id,
    });

    ctx.trace.record({
      target: `occurrence:${id}`,
      formula: 'marketLeasing.speculativeLeaseUp',
      description: `Space ${space.code} is vacant for the whole forecast, so it is absorbed after ${profile.downtimeMonths} months of downtime on the new-lease terms of "${profile.name}".`,
      inputs: traceInputs({
        area: space.area,
        downtimeMonths: profile.downtimeMonths,
        marketRent: market.amount,
        termMonths: profile.newLeaseTermMonths,
        freeRentMonths: profile.newFreeRentMonths,
        startDate: formatDate(start),
      }),
      result: monthlyRent.toString(),
      sources: [`space:${space.id}`, `profile:${profile.id}`],
    });
  }

  return expandRollover(seeds, ctx);
}

export interface OccurrenceSeries {
  occurrence: LeaseOccurrence;
  /** Weighted contractual base rent, before abatement. */
  baseRent: Decimal[];
  /** Weighted abatement, expressed as a positive amount to be deducted. */
  freeRent: Decimal[];
  otherRevenue: Decimal[];
  tenantImprovements: Decimal[];
  leasingCommissions: Decimal[];
  /** Weighted occupied area in each period. */
  occupiedArea: Decimal[];
  /**
   * How much of the *space* this occurrence fills for this period, 0..1:
   * time present x probability weight x share of the space's area.
   *
   * This is the physical-occupancy series. It is not the right multiplier for
   * spreading an annual entitlement, because an entitlement already carries the
   * tenant's area through its pro-rata share — see `timeFraction`.
   */
  occupancyFraction: Decimal[];
  /**
   * How much of the *period* this occurrence was present for, 0..1: time
   * present x probability weight, with no area term.
   *
   * Used to spread an annual figure — a recovery entitlement, an annual revenue
   * item — across the months the tenant was actually there. A tenant present
   * for half of March owes half of March; that it holds 40% of its suite has
   * already been accounted for in the entitlement itself, and applying it again
   * here would bill the tenant 40% of what it owes.
   */
  timeFraction: Decimal[];
}

/** Computes every periodic series a single lease occurrence contributes. */
export function computeOccurrenceSeries(
  occurrence: LeaseOccurrence,
  ctx: RolloverContext,
  recordTrace: boolean,
): OccurrenceSeries {
  const { calendar, curves, forecastStart } = ctx;
  const n = calendar.periods.length;
  const baseRent = zeros(n);
  const freeRent = zeros(n);
  const otherRevenue = zeros(n);
  const tenantImprovements = zeros(n);
  const leasingCommissions = zeros(n);
  const occupiedArea = zeros(n);
  const occupancyFraction = zeros(n);
  const timeFraction = zeros(n);

  // How much of the space it sits on this occurrence actually fills. A lease
  // normally takes its whole suite, so this is 1 and nothing changes. It is not
  // 1 when a tenant has handed part of the premises back under a contraction
  // option: the lease still names the same suite, but only holds part of it,
  // and treating that as a fully occupied suite would report the surrendered
  // area as occupied by a tenant who has given it up.
  const spanArea = occurrence.spaceIds.reduce(
    (total, spaceId) => total.plus(ctx.spaces.get(spaceId)?.area ?? ZERO),
    ZERO,
  );
  const areaShare = spanArea.isZero() ? ONE : occurrence.area.dividedBy(spanArea);

  for (let i = 0; i < n; i += 1) {
    const period = calendar.periods[i];
    if (!period) continue;

    const rent = rentForPeriod(occurrence.schedule, period, calendar, curves, forecastStart);
    baseRent[i] = rent.amount.times(occurrence.weight);

    const occupancy = periodCoverage(
      period,
      occurrence.commencement,
      occurrence.expiration,
      calendar.proration,
    );
    timeFraction[i] = occupancy.times(occurrence.weight);
    occupancyFraction[i] = (timeFraction[i] as Decimal).times(areaShare);
    occupiedArea[i] = occurrence.area.times(occupancy).times(occurrence.weight);

    if (recordTrace && !rent.amount.isZero()) {
      ctx.trace.record({
        target: `occurrence:${occurrence.id}:baseRent:${period.index}`,
        formula: 'lease.baseRent',
        description: `Contractual base rent for ${period.startDate}, billed across ${rent.segments.length} rate segment(s) and weighted at ${occurrence.weight.toFixed(4)}.`,
        inputs: traceInputs({
          area: occurrence.area,
          weight: occurrence.weight,
          coverage: rent.coverage,
          segments: rent.segments
            .map(
              (s) =>
                `${s.from}..${s.to} @ ${s.monthlyAmount}/mo x ${s.coverage} (${s.anchorSource}, ${s.escalationCount} escalations)`,
            )
            .join(' | '),
        }),
        result: (baseRent[i] as Decimal).toString(),
        sources: [`lease:${occurrence.sourceLeaseId}`],
        periodIndex: period.index,
        rounding: 'none (rounded at presentation)',
      });
    }

    // Free rent: abatement is a share of the rent that would otherwise be billed
    // in the overlapping portion of the period.
    let abatement = ZERO;
    for (const entry of occurrence.freeRent) {
      if (!entry.appliesTo.includes('base_rent')) continue;
      const coverage = periodCoverage(period, entry.from, entry.to, calendar.proration);
      if (coverage.isZero()) continue;
      const share = rent.coverage.isZero() ? ZERO : coverage.dividedBy(rent.coverage).clamp(0, 1);
      abatement = abatement.plus((baseRent[i] as Decimal).times(share).times(entry.share));
    }
    freeRent[i] = abatement;

    for (const entry of occurrence.otherRevenue) {
      const factor = curves.factors(entry.growthCurveId)[i] ?? ONE;
      otherRevenue[i] = (otherRevenue[i] as Decimal).plus(
        entry.monthlyAmount.times(factor).times(occupancy).times(occurrence.weight),
      );
    }
  }

  // Leasing costs land in a single period, at the configured payment date.
  const costIndex = monthDifference(forecastStart, occurrence.costDate);
  if (costIndex >= 0 && costIndex < n) {
    tenantImprovements[costIndex] = occurrence.tiCost.times(occurrence.weight);
    leasingCommissions[costIndex] = occurrence.lcCost.times(occurrence.weight);
    if (recordTrace && (!occurrence.tiCost.isZero() || !occurrence.lcCost.isZero())) {
      ctx.trace.record({
        target: `occurrence:${occurrence.id}:leasingCosts:${costIndex + 1}`,
        formula: 'lease.leasingCosts',
        description: `Tenant improvements and leasing commissions for ${occurrence.id}, paid ${formatDate(occurrence.costDate)}.`,
        inputs: traceInputs({
          tiCost: occurrence.tiCost,
          lcCost: occurrence.lcCost,
          weight: occurrence.weight,
        }),
        result: occurrence.tiCost.plus(occurrence.lcCost).times(occurrence.weight).toString(),
        sources: [`lease:${occurrence.sourceLeaseId}`],
        periodIndex: costIndex + 1,
      });
    }
  }

  return {
    occurrence,
    baseRent,
    freeRent,
    otherRevenue,
    tenantImprovements,
    leasingCommissions,
    occupiedArea,
    occupancyFraction,
    timeFraction,
  };
}

import type { Lease, LeaseOption, RentBasis } from '@cre/domain-models';
import { Decimal, ONE, d } from './decimal.js';
import {
  type CalendarDate,
  addDays,
  addMonths,
  compareDates,
  formatDate,
  parseDate,
} from './calendar.js';
import { monthlyRentFromBasis } from './rent-schedule.js';
import { traceInputs } from './trace.js';
import {
  type LeaseOccurrence,
  type RolloverContext,
  marketRentAt,
  resolveProfile,
} from './leases.js';

/**
 * Lease options.
 *
 * An option is a right the tenant holds and may or may not use, so the honest
 * forecast is not a guess at which way it goes — it is both outcomes, each
 * carrying its probability. That is the same treatment rollover already gets,
 * and for the same reason: committing the forecast to one branch produces a
 * number nobody can defend when the other branch happens.
 *
 * A lease therefore expands into a set of **paths**. Each path is a sequence of
 * occurrences sharing one weight, and its last occurrence is what rollover
 * chains forward from. Options are applied in exercise-date order, each one
 * splitting every path it can still reach into an exercised and a
 * not-exercised branch. Applying them in date order is what makes mutually
 * exclusive options behave: once a termination has ended a lease in March, a
 * renewal option dated the following year is simply unreachable on that path
 * and is skipped there while remaining live on the others.
 *
 * ## What is modelled, and what is not
 *
 * | Type | Treatment |
 * | --- | --- |
 * | `renewal` | Extends the term. Modelled. |
 * | `termination` | Ends the term early. Modelled. |
 * | `contraction` | Reduces the area held. Modelled; the released area becomes vacant. |
 * | `expansion` | **Not modelled** — see below. |
 * | `purchase`, `rofr`, `rofo` | **Not modelled** — these bear on disposition, not on operating cash flow. |
 *
 * Expansion is refused rather than approximated. Expanding into space means
 * taking space that belongs to some other suite, and `LeaseOption` records an
 * area but not *which* space the area comes from. Inventing that would either
 * double-count the area against whatever else occupies it, or silently create
 * rentable area the property does not have. Both produce a plausible-looking
 * cash flow that is wrong, which is worse than a diagnostic saying so. The
 * schema needs a space reference before this can be done properly.
 */

/** A weighted sequence of occurrences. Rollover continues from the last one. */
export interface LeasePath {
  weight: Decimal;
  occurrences: LeaseOccurrence[];
}

/** Weight below which a path stops being carried. Matches rollover's threshold. */
const WEIGHT_PRUNE_THRESHOLD = new Decimal('0.0001');

/** Option types that change the shape of the cash flow. */
const MODELLED = new Set(['renewal', 'termination', 'contraction']);

/** Option types recorded on the lease that deliberately do not reach the engine. */
const NOT_MODELLED: Record<string, string> = {
  expansion:
    'An expansion option states how much area is taken but not which space it comes from, ' +
    'so honouring it would either double-count area against the space that already holds it ' +
    'or create rentable area the property does not have.',
  purchase:
    'A purchase option bears on whether and when the asset is sold, not on operating cash flow. ' +
    'Model the disposition directly through the sale assumptions.',
  rofr: 'A right of first refusal bears on disposition, not on operating cash flow.',
  rofo: 'A right of first offer bears on disposition, not on operating cash flow.',
};

/** The tail of a path — the occurrence an option would act on. */
function tailOf(path: LeasePath): LeaseOccurrence {
  return path.occurrences[path.occurrences.length - 1] as LeaseOccurrence;
}

/**
 * Rent for an exercised option, in the option's own terms.
 *
 * `market` and `percent_of_market` read the market leasing profile at the date
 * the new term starts, so an option priced at market moves with the market
 * rather than freezing at today's figure.
 */
function optionRent(
  option: LeaseOption,
  startsOn: CalendarDate,
  tail: LeaseOccurrence,
  ctx: RolloverContext,
): { amount: Decimal; basis: RentBasis } {
  const profile = resolveProfile(
    ctx,
    tail.marketLeasingProfileId,
    tail.spaceIds,
    `option:${option.id}`,
  );
  const market = profile ? marketRentAt(profile, startsOn, ctx) : null;

  switch (option.rentMethod) {
    case 'fixed':
      return {
        amount: d(option.rentAmount ?? '0'),
        basis: option.rentBasis ?? tail.schedule.baseRentBasis,
      };
    case 'percent_of_market': {
      // The stated amount is a fraction of market, e.g. "0.95" for 95%.
      const share = d(option.rentAmount ?? '1');
      if (!market) return { amount: d('0'), basis: tail.schedule.baseRentBasis };
      return { amount: market.amount.times(share), basis: market.basis };
    }
    case 'prior_rent':
      return { amount: tail.schedule.baseRent, basis: tail.schedule.baseRentBasis };
    case 'market':
    default:
      if (!market) return { amount: d('0'), basis: tail.schedule.baseRentBasis };
      return { amount: market.amount, basis: market.basis };
  }
}

/** Truncates an occurrence so it ends on `endsOn` rather than its own expiry. */
function truncated(occurrence: LeaseOccurrence, endsOn: CalendarDate): LeaseOccurrence {
  return {
    ...occurrence,
    expiration: endsOn,
    schedule: {
      ...occurrence.schedule,
      leaseEnd: endsOn,
      // A step that now falls outside the shortened term must not apply.
      steps: occurrence.schedule.steps.filter((step) => compareDates(step.startDate, endsOn) <= 0),
    },
  };
}

/**
 * Applies one option to one path, returning the branches that replace it.
 *
 * Returns the path unchanged, as a single branch, when the option cannot be
 * reached on this path — it was dated after the lease ends there, or a previous
 * option has already ended it.
 */
function branchOnOption(
  path: LeasePath,
  option: LeaseOption,
  lease: Lease,
  ctx: RolloverContext,
): LeasePath[] {
  const tail = tailOf(path);
  const exerciseDate = parseDate(option.exerciseDate);
  const probability = d(option.probability).clamp(0, 1);

  // Unreachable on this path: the term already ended before the option date,
  // because an earlier option ended it or the lease simply expires first. This
  // is what makes mutually exclusive options behave without special-casing.
  if (compareDates(exerciseDate, tail.expiration) > 0) return [path];
  if (probability.isZero()) return [path];

  const exercisedWeight = path.weight.times(probability);
  const lapsedWeight = path.weight.times(ONE.minus(probability));
  const branches: LeasePath[] = [];

  // -- The option lapses. The lease continues exactly as it was. --------------
  if (lapsedWeight.greaterThanOrEqualTo(WEIGHT_PRUNE_THRESHOLD)) {
    branches.push({ weight: lapsedWeight, occurrences: path.occurrences });
  }

  if (exercisedWeight.lessThan(WEIGHT_PRUNE_THRESHOLD)) return branches;

  const head = path.occurrences.slice(0, -1);
  const id = `${tail.id}>${option.type}@${formatDate(exerciseDate)}`;

  if (option.type === 'renewal') {
    // The extension begins the day after the current term ends. `exerciseDate`
    // is the decision point, not the start of the new term; a renewal option
    // that has been exercised still runs the lease to its contractual expiry
    // first.
    const start = addDays(tail.expiration, 1);
    if (compareDates(start, ctx.forecastEnd) > 0) {
      // The current term already runs through (or past) the forecast horizon,
      // so the extension itself is entirely invisible — but the decision to
      // renew is not: this weight is still "the tenant occupies the visible
      // term," exactly as the lapsed branch is, and dropping it here (as
      // opposed to just skipping the extension) would silently understate the
      // lease's own already-elapsed term, or at probability 1 erase the lease
      // from the forecast entirely.
      branches.push({ weight: exercisedWeight, occurrences: path.occurrences });
      return branches;
    }

    const end = addDays(addMonths(start, option.termMonths), -1);
    const rent = optionRent(option, start, tail, ctx);

    const extension: LeaseOccurrence = {
      ...tail,
      id,
      scenario: 'renewal',
      generation: tail.generation + 1,
      commencement: start,
      rentStart: start,
      expiration: end,
      schedule: {
        ...tail.schedule,
        rentStart: start,
        leaseEnd: end,
        baseRent: rent.amount,
        baseRentBasis: rent.basis,
        // The option states the rent outright, so contractual steps and
        // escalations from the original term do not carry into it.
        steps: [],
      },
      freeRent: [],
      // The exercise cost is a landlord cost, paid when the new term starts.
      tiCost: d(option.cost),
      lcCost: d('0'),
      costDate: start,
    };

    recordOption(option, lease, exercisedWeight, ctx, {
      outcome: 'renewal exercised',
      startDate: formatDate(start),
      endDate: formatDate(end),
      rent: rent.amount,
      result: monthlyRentFromBasis(rent.amount, rent.basis, tail.area, tail.unitCount),
    });

    branches.push({
      weight: exercisedWeight,
      occurrences: [...head, tail, extension],
    });
    return branches;
  }

  if (option.type === 'termination') {
    // The lease ends on the exercise date. Rollover then picks the space up
    // from there, so the space is not simply lost from the forecast.
    const ended = { ...truncated(tail, exerciseDate), id };
    recordOption(option, lease, exercisedWeight, ctx, {
      outcome: 'termination exercised',
      endsOn: formatDate(exerciseDate),
      contractualExpiry: formatDate(tail.expiration),
      // A fee received from the tenant is entered as a negative cost.
      exerciseCost: d(option.cost),
      result: d(option.cost),
    });
    const occurrences = [...head];
    // The termination fee is its own cost, independent of whatever `ended`
    // already carries at its own (inherited, pre-termination) cost date —
    // overwriting `ended`'s tiCost would lose that pre-existing cost, and
    // adding to it would misdate the fee onto a month that is not when it is
    // actually paid. It gets its own zero-footprint occurrence instead: an
    // empty date range (`expiration` one day before `commencement`) reads as
    // zero coverage for every period, exactly as `periodCoverage` treats any
    // empty interval, so it contributes no rent, area or occupancy of its
    // own — only the fee, landed on the exercise date.
    //
    // It goes into `occurrences` **before** `ended`, not after.
    // `buildOccurrences` always treats a path's *last* occurrence as the seed
    // rollover chains forward from, and `rolloverBranches` inherits that
    // seed's `area` verbatim — a zero-area fee marker landing last would
    // become the seed instead of `ended`, and every renewal or new lease
    // generated from it would inherit `area: 0` and stay zero for the rest of
    // the forecast, silently zeroing rent, occupancy and value for the whole
    // space from the termination date onward. `ended` carries the space's
    // real, pre-termination area and must be what rollover actually sees.
    if (!d(option.cost).isZero()) {
      occurrences.push({
        ...tail,
        id: `${id}:fee`,
        generation: tail.generation + 1,
        commencement: exerciseDate,
        expiration: addDays(exerciseDate, -1),
        rentStart: exerciseDate,
        area: d('0'),
        schedule: {
          ...tail.schedule,
          rentStart: exerciseDate,
          leaseEnd: addDays(exerciseDate, -1),
          baseRent: d('0'),
          steps: [],
        },
        freeRent: [],
        otherRevenue: [],
        tiCost: d(option.cost),
        lcCost: d('0'),
        costDate: exerciseDate,
      });
    }
    occurrences.push(ended);
    branches.push({ weight: exercisedWeight, occurrences });
    return branches;
  }

  // -- Contraction ----------------------------------------------------------
  // The tenant gives back part of the premises and keeps the rest to the
  // original expiry on the original terms. The area handed back becomes vacant:
  // re-letting it would be a guess this option does not carry the assumptions
  // for, and leaving it vacant is the conservative reading.
  const surrendered = d(option.areaChange).abs();
  const remaining = tail.area.minus(surrendered);
  if (remaining.lessThanOrEqualTo(0)) {
    ctx.trace.warn(
      'CONTRACTION_EXCEEDS_AREA',
      `Contraction option ${option.id} on lease ${lease.id} gives back ${surrendered.toString()}, which is not less than the ${tail.area.toString()} the lease holds. Treated as a termination on the exercise date.`,
      `lease:${lease.id}`,
      'options',
    );
    branches.push({
      weight: exercisedWeight,
      occurrences: [...head, { ...truncated(tail, exerciseDate), id }],
    });
    return branches;
  }

  const before = truncated(tail, addDays(exerciseDate, -1));
  const after: LeaseOccurrence = {
    ...tail,
    id,
    generation: tail.generation + 1,
    commencement: exerciseDate,
    rentStart: exerciseDate,
    area: remaining,
    schedule: {
      ...tail.schedule,
      area: remaining,
      rentStart: exerciseDate,
    },
    tiCost: d(option.cost),
    lcCost: d('0'),
    costDate: exerciseDate,
  };

  recordOption(option, lease, exercisedWeight, ctx, {
    outcome: 'contraction exercised',
    effectiveFrom: formatDate(exerciseDate),
    areaBefore: tail.area,
    areaSurrendered: surrendered,
    result: remaining,
  });

  branches.push({ weight: exercisedWeight, occurrences: [...head, before, after] });
  return branches;
}

function recordOption(
  option: LeaseOption,
  lease: Lease,
  weight: Decimal,
  ctx: RolloverContext,
  detail: Record<string, unknown> & { outcome: string; result: Decimal },
): void {
  const { outcome, result, ...inputs } = detail;
  ctx.trace.record({
    target: `option:${option.id}`,
    formula: 'leaseOption.exercise',
    description: `${outcome} on lease ${lease.id}, carried at ${weight.toFixed(4)} of the space. The complementary weight continues on the unexercised branch.`,
    inputs: traceInputs({
      optionType: option.type,
      probability: option.probability,
      exerciseDate: option.exerciseDate,
      noticeDate: option.noticeDate ?? '',
      rentMethod: option.rentMethod,
      weight,
      ...inputs,
    }),
    result: result.toString(),
    sources: [`lease:${lease.id}`, `option:${option.id}`],
  });
}

/**
 * Expands one contract lease into weighted paths according to its options.
 *
 * A lease with no modelled option returns a single path at weight 1, which is
 * exactly what the engine did before options existed.
 */
export function expandOptions(
  base: LeaseOccurrence,
  lease: Lease,
  ctx: RolloverContext,
): LeasePath[] {
  let paths: LeasePath[] = [{ weight: ONE, occurrences: [base] }];
  if (lease.options.length === 0) return paths;

  for (const option of lease.options) {
    if (MODELLED.has(option.type)) continue;
    const reason = NOT_MODELLED[option.type];
    if (!reason) continue;
    if (d(option.probability).isZero()) continue;
    ctx.trace.warn(
      'LEASE_OPTION_NOT_MODELLED',
      `Lease ${lease.id} carries a ${option.type} option at ${d(option.probability).times(100).toFixed(0)}% probability which does not affect the cash flow. ${reason}`,
      `lease:${lease.id}`,
      'options',
    );
  }

  const modelled = lease.options
    .filter((option) => MODELLED.has(option.type))
    .sort((a, b) => compareDates(parseDate(a.exerciseDate), parseDate(b.exerciseDate)));

  for (const option of modelled) {
    const next: LeasePath[] = [];
    for (const path of paths) next.push(...branchOnOption(path, option, lease, ctx));
    paths = next;
  }

  // Each occurrence carries its path's weight; the engine sums weighted areas
  // and revenue, so the weight must be on the occurrence itself.
  return paths.map((path) => ({
    weight: path.weight,
    occurrences: path.occurrences.map((occurrence) => ({
      ...occurrence,
      weight: occurrence.weight.times(path.weight),
    })),
  }));
}

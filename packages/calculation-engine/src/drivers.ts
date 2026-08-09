import type { ModelInput, ModelResult } from '@cre/domain-models';
import { Decimal, ZERO, d } from './decimal.js';
import { calculate } from './engine.js';

/**
 * Which assumptions actually move the answer.
 *
 * An analyst asked to sensitise a model picks the variables they already
 * suspect, which means the one that matters most is the one nobody thought to
 * test. This ranks them by measurement instead: perturb each candidate up and
 * down by a stated amount, re-run the **real engine**, and report the effect.
 *
 * ## Why it re-runs the engine rather than approximating
 *
 * A closed-form sensitivity would be a second model. The relationships here are
 * not linear and several are not even monotonic — raising renewal probability
 * cuts downtime and leasing costs but also stops a below-market lease rolling
 * to market, and which effect wins depends on the rent roll. Anything short of
 * running the model would have to guess, and a sensitivity that guesses is
 * worse than none, because it will be believed.
 *
 * The cost is real: two engine runs per driver. It is therefore an explicit
 * action rather than something the page does on load, and the number of drivers
 * is bounded.
 *
 * ## What the ranking does and does not say
 *
 * It says: over the range tested, this assumption moved the metric this much.
 *
 * It does not say the assumption is *wrong*, or that the range tested is the
 * plausible one. A driver is ranked on sensitivity, not on uncertainty — an
 * exit cap rate usually tops the list because the metric is arithmetically very
 * sensitive to it, not because anybody is unsure what it should be. The two are
 * different questions, and the report says which one it answered.
 */

export type DriverMetric =
  'leveredIrr' | 'unleveredIrr' | 'equityMultiple' | 'netPresentValue' | 'year1Noi' | 'minimumDscr';

export interface DriverResult {
  /** Stable key, e.g. `valuation.terminalCapRate`. */
  key: string;
  label: string;
  /** How the variable was moved, in the reader's terms. */
  change: string;
  /** The metric with the variable moved down, then up. `null` when unavailable. */
  low: string | null;
  high: string | null;
  base: string | null;
  /**
   * The larger of the two absolute movements from the base, as a number.
   *
   * Used only to order the list. Both directions are reported, because a
   * variable can move a metric much further one way than the other and an
   * average would hide exactly that.
   */
  swing: number;
  /** True when a direction could not be evaluated at all. */
  partial: boolean;
}

export interface DriverReport {
  metric: DriverMetric;
  base: string | null;
  drivers: DriverResult[];
  /** Engine runs performed, so the cost is visible rather than hidden. */
  runs: number;
}

/* -------------------------------------------------------------------------- */

interface Candidate {
  key: string;
  label: string;
  /** Describes the perturbation for the reader. */
  change: string;
  /** Returns a modified input, or null when the model has nothing to move. */
  apply: (input: ModelInput, direction: -1 | 1) => ModelInput | null;
}

/** A deep-ish clone that is safe for the shallow edits below. */
function clone(input: ModelInput): ModelInput {
  return structuredClone(input);
}

const shift = (value: string | null | undefined, delta: Decimal): string =>
  d(value ?? '0')
    .plus(delta)
    .toString();

const scale = (value: string | null | undefined, factor: Decimal): string =>
  d(value ?? '0')
    .times(factor)
    .toString();

/**
 * The candidates, and the range each is moved over.
 *
 * The ranges are deliberately conventional rather than clever: 50 basis points
 * on a cap rate, 100 on a debt rate, a tenth on a growth rate. A reader who
 * disagrees with a range can see it stated on the row rather than having to
 * infer it from the answer.
 */
const CANDIDATES: Candidate[] = [
  {
    key: 'valuation.terminalCapRate',
    label: 'Exit capitalisation rate',
    change: '± 50 bps',
    apply: (input, direction) => {
      if (!input.valuation.terminalCapRate) return null;
      const next = clone(input);
      next.valuation.terminalCapRate = shift(
        input.valuation.terminalCapRate,
        new Decimal('0.005').times(direction),
      );
      return Number(next.valuation.terminalCapRate) > 0 ? next : null;
    },
  },
  {
    key: 'valuation.discountRate',
    label: 'Discount rate',
    change: '± 50 bps',
    apply: (input, direction) => {
      if (!input.valuation.discountRate) return null;
      const next = clone(input);
      next.valuation.discountRate = shift(
        input.valuation.discountRate,
        new Decimal('0.005').times(direction),
      );
      return next;
    },
  },
  {
    key: 'marketRent',
    label: 'Market rent',
    change: '± 10%',
    apply: (input, direction) => {
      if (input.marketLeasingProfiles.length === 0) return null;
      const next = clone(input);
      const factor = new Decimal(1).plus(new Decimal('0.1').times(direction));
      for (const profile of next.marketLeasingProfiles) {
        profile.marketRent = scale(profile.marketRent, factor);
      }
      return next;
    },
  },
  {
    key: 'renewalProbability',
    label: 'Renewal probability',
    change: '± 15 points',
    apply: (input, direction) => {
      if (input.marketLeasingProfiles.length === 0) return null;
      const next = clone(input);
      for (const profile of next.marketLeasingProfiles) {
        // Clamped: a probability is a fraction, and pushing one past 1 would
        // make the engine reject the input rather than answer the question.
        const moved = d(profile.renewalProbability).plus(new Decimal('0.15').times(direction));
        profile.renewalProbability = Decimal.min(
          Decimal.max(moved, ZERO),
          new Decimal(1),
        ).toString();
      }
      return next;
    },
  },
  {
    key: 'downtimeMonths',
    label: 'Downtime between leases',
    change: '± 3 months',
    apply: (input, direction) => {
      if (input.marketLeasingProfiles.length === 0) return null;
      const next = clone(input);
      for (const profile of next.marketLeasingProfiles) {
        // A month count is a number on the schema, not a decimal string —
        // unlike every rate and amount around it. Floored at zero: negative
        // downtime would be a tenant arriving before the last one left.
        profile.downtimeMonths = Math.max(profile.downtimeMonths + 3 * direction, 0);
      }
      return next;
    },
  },
  {
    key: 'tenantImprovements',
    label: 'Tenant improvement allowance',
    change: '± 25%',
    apply: (input, direction) => {
      if (input.marketLeasingProfiles.length === 0) return null;
      const next = clone(input);
      const factor = new Decimal(1).plus(new Decimal('0.25').times(direction));
      for (const profile of next.marketLeasingProfiles) {
        profile.newTiPerArea = scale(profile.newTiPerArea, factor);
        profile.renewalTiPerArea = scale(profile.renewalTiPerArea, factor);
      }
      return next;
    },
  },
  {
    key: 'operatingExpenses',
    label: 'Operating expenses',
    change: '± 10%',
    apply: (input, direction) => {
      if (input.expenses.length === 0) return null;
      const next = clone(input);
      const factor = new Decimal(1).plus(new Decimal('0.1').times(direction));
      for (const expense of next.expenses) {
        expense.amount = scale(expense.amount, factor);
      }
      return next;
    },
  },
  {
    key: 'debtRate',
    label: 'Debt interest rate',
    change: '± 100 bps',
    apply: (input, direction) => {
      if (input.debt.length === 0) return null;
      const next = clone(input);
      const delta = new Decimal('0.01').times(direction);
      for (const facility of next.debt) {
        if (facility.rateType === 'floating') facility.spread = shift(facility.spread, delta);
        else facility.fixedRate = shift(facility.fixedRate, delta);
      }
      return next;
    },
  },
  {
    key: 'generalVacancy',
    label: 'General vacancy allowance',
    change: '± 2 points',
    apply: (input, direction) => {
      const next = clone(input);
      const moved = d(next.vacancy.generalVacancyRate).plus(new Decimal('0.02').times(direction));
      next.vacancy.generalVacancyRate = Decimal.max(moved, ZERO).toString();
      return next;
    },
  },
];

/* -------------------------------------------------------------------------- */

function readMetric(result: ModelResult, metric: DriverMetric): string | null {
  switch (metric) {
    case 'leveredIrr':
      return result.returns.leveredIrr;
    case 'unleveredIrr':
      return result.returns.unleveredIrr;
    case 'equityMultiple':
      return result.returns.equityMultiple;
    case 'netPresentValue':
      return result.returns.netPresentValue;
    case 'minimumDscr':
      return result.returns.minimumDscr;
    case 'year1Noi': {
      const first = result.annual[0];
      return first ? first.lines.netOperatingIncome : null;
    }
    default:
      return null;
  }
}

export interface DriverOptions {
  /** Restricts the candidates, for a caller that wants a cheaper answer. */
  only?: string[];
  /** Injected so tests can count runs and callers can cache. Defaults to the engine. */
  run?: (input: ModelInput) => ModelResult;
}

/**
 * Ranks the assumptions by how far they move `metric`.
 *
 * The base result is passed in rather than recomputed, because the caller
 * already has one and running it again would be a wasted engine pass and a
 * chance for the two to disagree.
 */
export function rankDrivers(
  input: ModelInput,
  base: ModelResult,
  metric: DriverMetric,
  options: DriverOptions = {},
): DriverReport {
  const run = options.run ?? ((candidate: ModelInput) => calculate(candidate));
  const baseValue = readMetric(base, metric);
  const candidates = options.only
    ? CANDIDATES.filter((candidate) => options.only?.includes(candidate.key))
    : CANDIDATES;

  let runs = 0;
  const drivers: DriverResult[] = [];

  for (const candidate of candidates) {
    const outcomes: Record<'low' | 'high', string | null> = { low: null, high: null };
    let attempted = 0;

    for (const [name, direction] of [
      ['low', -1],
      ['high', 1],
    ] as Array<['low' | 'high', -1 | 1]>) {
      const modified = candidate.apply(input, direction);
      if (!modified) continue;
      attempted += 1;
      runs += 1;
      try {
        outcomes[name] = readMetric(run(modified), metric);
      } catch {
        /*
         * A perturbation the engine refuses is reported as unavailable rather
         * than as zero. Pushing a rate somewhere the model cannot resolve is a
         * fact about the range, not a measurement of nil sensitivity, and a
         * zero here would sort the driver to the bottom and hide it.
         */
        outcomes[name] = null;
      }
    }

    // Nothing in the model to move: not a driver with no effect, a driver that
    // does not apply. Left out rather than listed at zero.
    if (attempted === 0) continue;

    const swing = Math.max(distance(baseValue, outcomes.low), distance(baseValue, outcomes.high));

    drivers.push({
      key: candidate.key,
      label: candidate.label,
      change: candidate.change,
      base: baseValue,
      low: outcomes.low,
      high: outcomes.high,
      swing,
      partial: outcomes.low === null || outcomes.high === null,
    });
  }

  drivers.sort((a, b) => b.swing - a.swing);
  return { metric, base: baseValue, drivers, runs };
}

function distance(base: string | null, other: string | null): number {
  if (base === null || other === null) return 0;
  const a = Number(base);
  const b = Number(other);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return 0;
  return Math.abs(b - a);
}

/** The keys a caller may ask for, so an API can validate a request. */
export const DRIVER_KEYS: readonly string[] = CANDIDATES.map((candidate) => candidate.key);

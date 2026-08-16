import {
  researchComparisonSchema,
  type ResearchComparison,
  type ResearchGeography,
  type ResearchObservation,
} from './cre-property-research.js';

/**
 * The comparable-selection and percentile engine, `docs/property-research.md`
 * named as "the natural next increment": a pure function over a
 * caller-supplied observation array, exactly like
 * `assumption-import-analyze.ts` is a pure function over a parsed document.
 * It does not require test1 or test3 to exist to build or test, and nothing
 * here calls either — it only turns a candidate set of `ResearchObservation`s
 * into the `ResearchComparison` shape that schema was designed to hold, with
 * the exact same statistical rigor a research analyst would apply by hand:
 * a matched unit type, a recency window, and robust statistics that flag an
 * outlier rather than silently deleting it from the record.
 *
 * "Flagging rather than deletion" means what it says two different ways at
 * once: the outlier observation is untouched in the research document's own
 * `observations` array — nothing here mutates or removes it — and its
 * exclusion from *this comparison's* statistics is written into
 * `coverage.exclusions` with a stated reason and count, never a silent drop.
 *
 * Distance filtering is deliberately not attempted: `ResearchObservation`
 * carries a free-text `geography` string, not a coordinate, so there is
 * nothing numeric here to compute a radius from. Geographic relevance is the
 * caller's job — narrowing the candidate set before calling this function —
 * and that boundary is stated as a `coverage.limitations` entry on every
 * comparison this produces, rather than implied by silence.
 */

export interface BuildComparisonInput {
  /** Which observations to draw from — usually addresses several metrics at once; only the matching ones are used. */
  metric: string;
  /** Restricts the sample to observations of the same unit type as the subject, e.g. "2bed_2bath". */
  unitType?: string | null;
  /** The subject's own value for this metric, for `subjectPercentile` and `premiumToMedian`. */
  subjectValue?: string | null;
  observations: ResearchObservation[];
  geography: ResearchGeography;
  /** Observations older than this are excluded from the statistics and recorded, not silently dropped. */
  maxAgeDays?: number | null;
  sourceIds?: string[];
  notes?: string | null;
  id?: string | null;
  /** Injectable for deterministic tests; defaults to the real current time. */
  now?: string;
}

/** Sorted ascending; NaN and non-finite values must already be filtered out. */
function percentile(sorted: number[], p: number): number {
  if (sorted.length === 1) return sorted[0] as number;
  const rank = (p / 100) * (sorted.length - 1);
  const lower = Math.floor(rank);
  const upper = Math.ceil(rank);
  const weight = rank - lower;
  const lowerValue = sorted[lower] as number;
  const upperValue = sorted[upper] as number;
  return lowerValue + (upperValue - lowerValue) * weight;
}

/** The share of the sample at or below `value`, ties counted at half weight. */
function percentileRank(sorted: number[], value: number): number {
  let below = 0;
  let equal = 0;
  for (const entry of sorted) {
    if (entry < value) below += 1;
    else if (entry === value) equal += 1;
  }
  return ((below + equal / 2) / sorted.length) * 100;
}

/** Rounds away float noise from percentile interpolation without padding trailing zeros. */
function formatNumber(value: number): string {
  return Number(value.toFixed(6)).toString();
}

/**
 * Standard 1.5×IQR fencing. Fewer than four points cannot support a
 * quartile split that means anything, so nothing is excluded on that basis
 * alone — a comparable set that small should be read skeptically as a whole,
 * not have one of its four points thrown out by a formula.
 */
function iqrFence(sorted: number[]): { lower: number; upper: number } {
  if (sorted.length < 4) return { lower: -Infinity, upper: Infinity };
  const q1 = percentile(sorted, 25);
  const q3 = percentile(sorted, 75);
  const iqr = q3 - q1;
  return { lower: q1 - 1.5 * iqr, upper: q3 + 1.5 * iqr };
}

export function buildComparison(input: BuildComparisonInput): ResearchComparison {
  const now = input.now ? new Date(input.now) : new Date();
  const exclusions: Array<{ count: number; reason: string }> = [];

  const byMetric = input.observations.filter((observation) => observation.metric === input.metric);
  if (input.observations.length > byMetric.length) {
    exclusions.push({
      count: input.observations.length - byMetric.length,
      reason: `Addressed a different metric than "${input.metric}".`,
    });
  }

  let candidates = byMetric;
  if (input.unitType) {
    const before = candidates.length;
    candidates = candidates.filter((observation) => observation.unitType === input.unitType);
    if (before > candidates.length) {
      exclusions.push({
        count: before - candidates.length,
        reason: `Unit type did not match "${input.unitType}".`,
      });
    }
  }

  const withNumericValue = candidates
    .map((observation) => ({
      observation,
      // `Number('')` is 0 and `Number(true/false)` is 1/0 — neither is a
      // usable numeric observation, so both must be excluded explicitly
      // rather than silently coerced into a real data point.
      value:
        typeof observation.value === 'string' || typeof observation.value === 'number'
          ? Number(observation.value)
          : NaN,
    }))
    .filter((entry) => Number.isFinite(entry.value) && entry.observation.value !== '');
  if (candidates.length > withNumericValue.length) {
    exclusions.push({
      count: candidates.length - withNumericValue.length,
      reason: 'Value was missing or not a number.',
    });
  }

  let recent = withNumericValue;
  if (input.maxAgeDays != null) {
    const before = recent.length;
    recent = recent.filter((entry) => {
      // An observation with no recorded date cannot be judged stale, and
      // silently excluding it would understate the sample for a reason the
      // exclusion record could not honestly state.
      if (!entry.observation.observedAt) return true;
      const ageDays =
        (now.getTime() - new Date(entry.observation.observedAt).getTime()) / 86_400_000;
      return ageDays <= (input.maxAgeDays as number);
    });
    if (before > recent.length) {
      exclusions.push({
        count: before - recent.length,
        reason: `Observed more than ${input.maxAgeDays} day${input.maxAgeDays === 1 ? '' : 's'} ago.`,
      });
    }
  }

  const sortedForFence = recent.map((entry) => entry.value).sort((a, b) => a - b);
  const fence = iqrFence(sortedForFence);
  const clean = recent.filter((entry) => entry.value >= fence.lower && entry.value <= fence.upper);
  if (recent.length > clean.length) {
    exclusions.push({
      count: recent.length - clean.length,
      reason:
        `Outside 1.5× the interquartile range of the remaining sample (below ` +
        `${formatNumber(fence.lower)} or above ${formatNumber(fence.upper)}) — flagged as a ` +
        'statistical outlier and excluded from these statistics, not deleted from the record.',
    });
  }

  const values = clean.map((entry) => entry.value).sort((a, b) => a - b);
  const stats =
    values.length === 0
      ? { count: 0, min: null, p25: null, median: null, p75: null, max: null }
      : {
          count: values.length,
          min: formatNumber(values[0] as number),
          p25: formatNumber(percentile(values, 25)),
          median: formatNumber(percentile(values, 50)),
          p75: formatNumber(percentile(values, 75)),
          max: formatNumber(values[values.length - 1] as number),
        };

  const subjectNumber =
    input.subjectValue != null && input.subjectValue !== '' ? Number(input.subjectValue) : null;
  const subjectIsNumeric = subjectNumber != null && Number.isFinite(subjectNumber);
  const subjectPercentile =
    subjectIsNumeric && values.length > 0
      ? Math.round(percentileRank(values, subjectNumber as number) * 100) / 100
      : null;
  const medianNumber = stats.median != null ? Number(stats.median) : null;
  const premiumToMedian =
    subjectIsNumeric && medianNumber != null && medianNumber !== 0
      ? formatNumber(((subjectNumber as number) - medianNumber) / medianNumber)
      : null;

  const observedDates = clean
    .map((entry) => entry.observation.observedAt)
    .filter((date): date is string => Boolean(date))
    .sort();
  const ages = clean
    .map((entry) =>
      entry.observation.observedAt
        ? (now.getTime() - new Date(entry.observation.observedAt).getTime()) / 86_400_000
        : null,
    )
    .filter((age): age is number => age !== null)
    .sort((a, b) => a - b);

  const comparison = {
    id: input.id ?? undefined,
    metric: input.metric,
    unitType: input.unitType ?? undefined,
    subjectValue: input.subjectValue ?? undefined,
    stats,
    subjectPercentile,
    premiumToMedian,
    geography: input.geography,
    coverage: {
      sampleCount: values.length,
      propertyCount: undefined,
      dateRangeStart: observedDates[0] ?? undefined,
      dateRangeEnd: observedDates[observedDates.length - 1] ?? undefined,
      medianObservationAgeDays:
        ages.length > 0 ? Math.round(percentile(ages, 50) * 100) / 100 : undefined,
      exclusions,
      limitations: [
        'Geographic proximity is not independently verified by this engine — the caller is ' +
          'responsible for supplying an already geographically relevant candidate set.',
      ],
    },
    sourceIds: input.sourceIds ?? [],
    notes: input.notes ?? undefined,
  };

  // Validated before returning: a comparison this function produced must
  // always satisfy the schema it exists to fill in, or the bug is here
  // rather than in whatever reads the result.
  return researchComparisonSchema.parse(comparison);
}

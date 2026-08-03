import type { Escalation, RentBasis } from '@cre/domain-models';
import { Decimal, ONE, ZERO, TWELVE, d, maxOf, minOf } from './decimal.js';
import {
  type CalendarDate,
  type ForecastCalendar,
  type ForecastPeriod,
  addDays,
  addMonths,
  compareDates,
  daysInMonth,
  formatDate,
  monthDifference,
  parseDate,
  periodCoverage,
} from './calendar.js';
import type { CurveSet } from './curves.js';

/**
 * Converts a rent quoted in any supported basis into a full-month amount.
 *
 * Annual figures are divided by twelve rather than by days in year: property
 * leases bill a twelfth of annual rent each month regardless of month length,
 * and proration for partial months is applied separately by the caller.
 */
export function monthlyRentFromBasis(
  amount: Decimal,
  basis: RentBasis,
  area: Decimal,
  unitCount: number,
): Decimal {
  switch (basis) {
    case 'per_area_per_year':
      return amount.times(area).dividedBy(TWELVE);
    case 'per_area_per_month':
      return amount.times(area);
    case 'annual_amount':
      return amount.dividedBy(TWELVE);
    case 'monthly_amount':
      return amount;
    case 'per_unit_per_month':
      return amount.times(unitCount);
    default:
      return ZERO;
  }
}

export interface RentAnchor {
  amount: Decimal;
  basis: RentBasis;
  /** Date this rate became the contractual rate. */
  effective: CalendarDate;
  /** "base" or the index of the rent step that set it. */
  source: string;
}

export interface RentScheduleSpec {
  area: Decimal;
  unitCount: number;
  rentStart: CalendarDate;
  leaseEnd: CalendarDate;
  baseRent: Decimal;
  baseRentBasis: RentBasis;
  steps: Array<{ startDate: CalendarDate; amount: Decimal; basis: RentBasis }>;
  escalation: Escalation;
  /** Market rent resolver used by `market_reset` escalations. */
  marketRentAt?: (date: CalendarDate) => { amount: Decimal; basis: RentBasis } | null;
}

/**
 * Rate in effect on a given date, before proration.
 *
 * Precedence rule: an explicit rent step states the contractual rate outright,
 * so it resets the escalation clock. Escalation then compounds from the step
 * that is in force. This keeps a stepped-and-escalating lease from applying
 * both mechanisms to the same period twice.
 */
export function rentAnchorAt(spec: RentScheduleSpec, date: CalendarDate): RentAnchor {
  let anchor: RentAnchor = {
    amount: spec.baseRent,
    basis: spec.baseRentBasis,
    effective: spec.rentStart,
    source: 'base',
  };
  spec.steps.forEach((step, index) => {
    if (compareDates(step.startDate, date) <= 0 && compareDates(step.startDate, anchor.effective) >= 0) {
      anchor = {
        amount: step.amount,
        basis: step.basis,
        effective: step.startDate,
        source: `step:${index}`,
      };
    }
  });
  return anchor;
}

/** Escalation event dates in [after, through], in chronological order. */
export function escalationDatesBetween(
  spec: RentScheduleSpec,
  after: CalendarDate,
  through: CalendarDate,
): CalendarDate[] {
  const esc = spec.escalation;
  if (esc.type === 'none') return [];
  const first = esc.firstEscalationDate
    ? parseDate(esc.firstEscalationDate)
    : addMonths(spec.rentStart, esc.frequencyMonths);
  const dates: CalendarDate[] = [];
  // A 600-month forecast cannot contain more escalation events than months.
  for (let k = 0; k < 1200; k += 1) {
    const date = addMonths(first, k * esc.frequencyMonths);
    if (compareDates(date, through) > 0) break;
    if (compareDates(date, after) > 0) dates.push(date);
  }
  return dates;
}

function clampRate(rate: Decimal, esc: Escalation): Decimal {
  let result = rate;
  if (esc.floorRate !== null && esc.floorRate !== undefined) result = maxOf(result, d(esc.floorRate));
  if (esc.capRate !== null && esc.capRate !== undefined) result = minOf(result, d(esc.capRate));
  return result;
}

export interface RateAtResult {
  /** Full-month rent amount at this date. */
  monthlyAmount: Decimal;
  /** Rate expressed in the anchor's basis after escalation. */
  escalatedRate: Decimal;
  anchor: RentAnchor;
  escalationCount: number;
  basis: RentBasis;
}

/** Full-month contractual rent in effect on `date`. */
export function rateAt(
  spec: RentScheduleSpec,
  date: CalendarDate,
  curves: CurveSet,
  forecastStart: CalendarDate,
): RateAtResult {
  const anchor = rentAnchorAt(spec, date);
  const esc = spec.escalation;
  const events = escalationDatesBetween(spec, anchor.effective, date);

  let rate = anchor.amount;
  let basis = anchor.basis;

  if (esc.type === 'fixed_percent') {
    const stepRate = clampRate(d(esc.rate), esc);
    rate = esc.compounding
      ? rate.times(ONE.plus(stepRate).pow(events.length))
      : rate.times(ONE.plus(stepRate.times(events.length)));
  } else if (esc.type === 'fixed_amount') {
    rate = rate.plus(d(esc.amount).times(events.length));
  } else if (esc.type === 'index') {
    for (const event of events) {
      const forecastYear = Math.floor(monthDifference(forecastStart, event) / 12) + 1;
      const indexRate = clampRate(curves.rateForYear(esc.indexCurveId, forecastYear), esc);
      rate = esc.compounding ? rate.times(ONE.plus(indexRate)) : rate.plus(anchor.amount.times(indexRate));
    }
  } else if (esc.type === 'market_reset' && spec.marketRentAt) {
    const lastEvent = events[events.length - 1];
    if (lastEvent) {
      const market = spec.marketRentAt(lastEvent);
      if (market) {
        rate = market.amount;
        basis = market.basis;
      }
    }
  }

  return {
    monthlyAmount: monthlyRentFromBasis(rate, basis, spec.area, spec.unitCount),
    escalatedRate: rate,
    anchor,
    escalationCount: events.length,
    basis,
  };
}

/**
 * Dates inside a period at which the contractual rate can change. The period is
 * split at these boundaries so a step or escalation landing mid-month is billed
 * correctly rather than being rounded to a month boundary.
 */
function rateChangeDatesInPeriod(spec: RentScheduleSpec, period: ForecastPeriod): CalendarDate[] {
  const dates: CalendarDate[] = [];
  for (const step of spec.steps) {
    if (compareDates(step.startDate, period.start) > 0 && compareDates(step.startDate, period.end) <= 0) {
      dates.push(step.startDate);
    }
  }
  for (const event of escalationDatesBetween(spec, period.start, period.end)) {
    dates.push(event);
  }
  dates.sort(compareDates);
  return dates;
}

export interface PeriodRent {
  amount: Decimal;
  /** Fraction of the month the lease was in effect, 0..1. */
  coverage: Decimal;
  segments: Array<{
    from: string;
    to: string;
    monthlyAmount: string;
    coverage: string;
    amount: string;
    anchorSource: string;
    escalationCount: number;
  }>;
}

/** Contractual rent billed in a single forecast period. */
export function rentForPeriod(
  spec: RentScheduleSpec,
  period: ForecastPeriod,
  calendar: ForecastCalendar,
  curves: CurveSet,
  forecastStart: CalendarDate,
): PeriodRent {
  const leaseFrom = spec.rentStart;
  const leaseTo = spec.leaseEnd;
  if (compareDates(leaseFrom, period.end) > 0 || compareDates(leaseTo, period.start) < 0) {
    return { amount: ZERO, coverage: ZERO, segments: [] };
  }

  const segmentStarts: CalendarDate[] = [
    compareDates(leaseFrom, period.start) > 0 ? leaseFrom : period.start,
    ...rateChangeDatesInPeriod(spec, period),
  ];
  const uniqueStarts = segmentStarts.filter(
    (date, index, all) => index === 0 || compareDates(date, all[index - 1] as CalendarDate) !== 0,
  );

  const periodEndForLease = compareDates(leaseTo, period.end) < 0 ? leaseTo : period.end;

  let total = ZERO;
  let coverageTotal = ZERO;
  const segments: PeriodRent['segments'] = [];

  for (let i = 0; i < uniqueStarts.length; i += 1) {
    const from = uniqueStarts[i] as CalendarDate;
    if (compareDates(from, periodEndForLease) > 0) continue;
    const nextStart = uniqueStarts[i + 1];
    const to = nextStart
      ? minDate(addDays(nextStart, -1), periodEndForLease)
      : periodEndForLease;
    if (compareDates(from, to) > 0) continue;

    const coverage = periodCoverage(period, from, to, calendar.proration);
    if (coverage.isZero()) continue;
    const rate = rateAt(spec, from, curves, forecastStart);
    const amount = rate.monthlyAmount.times(coverage);
    total = total.plus(amount);
    coverageTotal = coverageTotal.plus(coverage);
    segments.push({
      from: formatDate(from),
      to: formatDate(to),
      monthlyAmount: rate.monthlyAmount.toString(),
      coverage: coverage.toString(),
      amount: amount.toString(),
      anchorSource: rate.anchor.source,
      escalationCount: rate.escalationCount,
    });
  }

  return { amount: total, coverage: coverageTotal, segments };
}

function minDate(a: CalendarDate, b: CalendarDate): CalendarDate {
  return compareDates(a, b) <= 0 ? a : b;
}

/**
 * Resolves a free-rent record expressed in months into an inclusive date range.
 * Fractional months are converted to whole days of the month they land in.
 */
export function freeRentRange(start: CalendarDate, months: number): { from: CalendarDate; to: CalendarDate } {
  const wholeMonths = Math.floor(months);
  const fraction = months - wholeMonths;
  let endExclusive = addMonths(start, wholeMonths);
  if (fraction > 0) {
    const daysInTarget = daysInMonth(endExclusive.year, endExclusive.month);
    const extraDays = Math.round(daysInTarget * fraction);
    endExclusive = addDays(endExclusive, extraDays);
  }
  return { from: start, to: addDays(endExclusive, -1) };
}

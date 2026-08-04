import type { Forecast } from '@cre/domain-models';
import type { PeriodMeta } from '@cre/domain-models';
import { Decimal, ONE, ZERO, d } from './decimal.js';

/**
 * Date handling deliberately avoids the Date object's timezone behaviour.
 * A calendar date is a {year, month, day} triple and every operation on it is
 * pure integer arithmetic, so a forecast produces identical periods regardless
 * of the server's timezone.
 */

export interface CalendarDate {
  year: number;
  month: number; // 1-12
  day: number; // 1-31
}

export function parseDate(iso: string): CalendarDate {
  const parts = iso.split('-');
  const year = Number(parts[0]);
  const month = Number(parts[1]);
  const day = Number(parts[2]);
  if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) {
    throw new Error(`Invalid date: ${iso}`);
  }
  return { year, month, day };
}

export function formatDate(date: CalendarDate): string {
  const m = String(date.month).padStart(2, '0');
  const day = String(date.day).padStart(2, '0');
  return `${date.year}-${m}-${day}`;
}

export function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

const MONTH_LENGTHS = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

export function daysInMonth(year: number, month: number): number {
  if (month === 2 && isLeapYear(year)) return 29;
  return MONTH_LENGTHS[month - 1] as number;
}

/** Total ordering helper. Returns <0, 0 or >0. */
export function compareDates(a: CalendarDate, b: CalendarDate): number {
  if (a.year !== b.year) return a.year - b.year;
  if (a.month !== b.month) return a.month - b.month;
  return a.day - b.day;
}

export function addMonths(date: CalendarDate, months: number): CalendarDate {
  const zeroBased = date.year * 12 + (date.month - 1) + months;
  const year = Math.floor(zeroBased / 12);
  const month = (zeroBased % 12) + 1;
  const day = Math.min(date.day, daysInMonth(year, month));
  return { year, month, day };
}

export function addDays(date: CalendarDate, days: number): CalendarDate {
  let { year, month, day } = date;
  day += days;
  while (day > daysInMonth(year, month)) {
    day -= daysInMonth(year, month);
    month += 1;
    if (month > 12) {
      month = 1;
      year += 1;
    }
  }
  while (day < 1) {
    month -= 1;
    if (month < 1) {
      month = 12;
      year -= 1;
    }
    day += daysInMonth(year, month);
  }
  return { year, month, day };
}

/** Whole months between two dates, ignoring day-of-month. */
export function monthDifference(from: CalendarDate, to: CalendarDate): number {
  return (to.year - from.year) * 12 + (to.month - from.month);
}

export function firstOfMonth(date: CalendarDate): CalendarDate {
  return { year: date.year, month: date.month, day: 1 };
}

export function lastOfMonth(date: CalendarDate): CalendarDate {
  return { year: date.year, month: date.month, day: daysInMonth(date.year, date.month) };
}

/**
 * Days between two dates, inclusive of `from` and exclusive of `to`.
 * Used for actual/actual proration.
 */
export function dayCount(from: CalendarDate, to: CalendarDate): number {
  return toEpochDay(to) - toEpochDay(from);
}

/** Days since 1970-01-01 using the proleptic Gregorian calendar. */
export function toEpochDay(date: CalendarDate): number {
  const y = date.year;
  const m = date.month;
  const day = date.day;
  // Howard Hinnant's civil-from-days algorithm, inverted.
  const shiftedYear = m <= 2 ? y - 1 : y;
  const era = Math.floor(shiftedYear / 400);
  const yoe = shiftedYear - era * 400;
  const doy = Math.floor((153 * (m + (m > 2 ? -3 : 9)) + 2) / 5) + day - 1;
  const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy;
  return era * 146097 + doe - 719468;
}

export interface ForecastPeriod extends PeriodMeta {
  start: CalendarDate;
  end: CalendarDate;
}

export interface ForecastCalendar {
  periods: ForecastPeriod[];
  months: number;
  fiscalYearStartMonth: number;
  proration: Forecast['proration'];
  /** Distinct fiscal years covered, in order. */
  fiscalYears: number[];
  /** Period indices (0-based) grouped by fiscal year. */
  periodsByFiscalYear: Map<number, number[]>;
}

export function buildCalendar(forecast: Forecast): ForecastCalendar {
  const start = firstOfMonth(parseDate(forecast.startDate));
  const periods: ForecastPeriod[] = [];
  const periodsByFiscalYear = new Map<number, number[]>();

  for (let i = 0; i < forecast.months; i += 1) {
    const periodStart = addMonths(start, i);
    const periodEnd = lastOfMonth(periodStart);
    const { fiscalYear, fiscalPeriod } = fiscalPosition(periodStart, forecast.fiscalYearStartMonth);
    periods.push({
      index: i + 1,
      startDate: formatDate(periodStart),
      endDate: formatDate(periodEnd),
      year: periodStart.year,
      month: periodStart.month,
      fiscalYear,
      fiscalPeriod,
      daysInMonth: daysInMonth(periodStart.year, periodStart.month),
      start: periodStart,
      end: periodEnd,
    });
    const bucket = periodsByFiscalYear.get(fiscalYear);
    if (bucket) bucket.push(i);
    else periodsByFiscalYear.set(fiscalYear, [i]);
  }

  return {
    periods,
    months: forecast.months,
    fiscalYearStartMonth: forecast.fiscalYearStartMonth,
    proration: forecast.proration,
    fiscalYears: [...periodsByFiscalYear.keys()],
    periodsByFiscalYear,
  };
}

/**
 * A fiscal year is labelled by the calendar year in which it *ends* when it
 * does not start in January, which matches how property accounting teams
 * normally refer to a fiscal year (FY2027 = Jul 2026 - Jun 2027).
 */
export function fiscalPosition(
  date: CalendarDate,
  fiscalYearStartMonth: number,
): { fiscalYear: number; fiscalPeriod: number } {
  const offset = (date.month - fiscalYearStartMonth + 12) % 12;
  const fiscalYear =
    fiscalYearStartMonth === 1
      ? date.year
      : date.month >= fiscalYearStartMonth
        ? date.year + 1
        : date.year;
  return { fiscalYear, fiscalPeriod: offset + 1 };
}

/**
 * Fraction of a forecast month covered by the interval [from, to] inclusive of
 * both endpoints. Returns 0 when the interval misses the period entirely and 1
 * when it spans the whole month.
 */
export function periodCoverage(
  period: ForecastPeriod,
  from: CalendarDate | null,
  to: CalendarDate | null,
  proration: Forecast['proration'],
): Decimal {
  const effectiveFrom = from && compareDates(from, period.start) > 0 ? from : period.start;
  const effectiveTo = to && compareDates(to, period.end) < 0 ? to : period.end;
  if (compareDates(effectiveFrom, effectiveTo) > 0) return ZERO;

  const spansWholeMonth =
    compareDates(effectiveFrom, period.start) === 0 && compareDates(effectiveTo, period.end) === 0;
  if (spansWholeMonth) return ONE;

  switch (proration) {
    case 'full_month':
      return ONE;
    case 'thirty_360': {
      const startDay = Math.min(effectiveFrom.day, 30);
      const endDay = Math.min(effectiveTo.day, 30);
      const days = endDay - startDay + 1;
      return d(Math.max(days, 0)).dividedBy(30);
    }
    case 'actual_days':
    default: {
      const days = dayCount(effectiveFrom, addDays(effectiveTo, 1));
      return d(Math.max(days, 0)).dividedBy(period.daysInMonth);
    }
  }
}

/** True when the period overlaps the closed interval [from, to]. */
export function periodOverlaps(
  period: ForecastPeriod,
  from: CalendarDate | null,
  to: CalendarDate | null,
): boolean {
  if (from && compareDates(from, period.end) > 0) return false;
  if (to && compareDates(to, period.start) < 0) return false;
  return true;
}

/** 0-based index of the forecast period containing `date`, or -1. */
export function periodIndexFor(calendar: ForecastCalendar, date: CalendarDate): number {
  const first = calendar.periods[0];
  if (!first) return -1;
  const diff = monthDifference(first.start, date);
  if (diff < 0 || diff >= calendar.periods.length) return -1;
  return diff;
}

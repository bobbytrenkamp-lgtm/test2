import { describe, expect, it } from 'vitest';
import {
  addDays,
  addMonths,
  buildCalendar,
  compareDates,
  dayCount,
  daysInMonth,
  fiscalPosition,
  isLeapYear,
  parseDate,
  periodCoverage,
  toEpochDay,
} from './calendar.js';

describe('calendar dates', () => {
  it('identifies leap years by the Gregorian rule', () => {
    expect(isLeapYear(2024)).toBe(true);
    expect(isLeapYear(2025)).toBe(false);
    expect(isLeapYear(1900)).toBe(false);
    expect(isLeapYear(2000)).toBe(true);
    expect(daysInMonth(2024, 2)).toBe(29);
    expect(daysInMonth(2026, 2)).toBe(28);
  });

  it('converts to epoch days against known reference dates', () => {
    // 1970-01-01 is day zero; 2000-01-01 is 10,957 days later.
    expect(toEpochDay(parseDate('1970-01-01'))).toBe(0);
    expect(toEpochDay(parseDate('2000-01-01'))).toBe(10957);
    // 2024 is a leap year, so 2024-03-01 is 60 days after 2024-01-01.
    expect(dayCount(parseDate('2024-01-01'), parseDate('2024-03-01'))).toBe(60);
    // 2026 is not, so the same span is 59 days.
    expect(dayCount(parseDate('2026-01-01'), parseDate('2026-03-01'))).toBe(59);
  });

  it('clamps the day of month when adding months', () => {
    expect(addMonths(parseDate('2026-01-31'), 1)).toEqual({ year: 2026, month: 2, day: 28 });
    expect(addMonths(parseDate('2024-01-31'), 1)).toEqual({ year: 2024, month: 2, day: 29 });
    expect(addMonths(parseDate('2026-12-15'), 3)).toEqual({ year: 2027, month: 3, day: 15 });
    expect(addMonths(parseDate('2026-06-15'), -8)).toEqual({ year: 2025, month: 10, day: 15 });
  });

  it('adds days across month and year boundaries', () => {
    expect(addDays(parseDate('2026-12-31'), 1)).toEqual({ year: 2027, month: 1, day: 1 });
    expect(addDays(parseDate('2027-01-01'), -1)).toEqual({ year: 2026, month: 12, day: 31 });
    expect(addDays(parseDate('2024-02-28'), 1)).toEqual({ year: 2024, month: 2, day: 29 });
  });

  it('orders dates', () => {
    expect(compareDates(parseDate('2026-01-01'), parseDate('2026-01-02'))).toBeLessThan(0);
    expect(compareDates(parseDate('2026-02-01'), parseDate('2026-01-31'))).toBeGreaterThan(0);
    expect(compareDates(parseDate('2026-05-05'), parseDate('2026-05-05'))).toBe(0);
  });
});

describe('forecast calendar', () => {
  it('builds consecutive monthly periods from the first of the start month', () => {
    const calendar = buildCalendar({
      startDate: '2026-03-15',
      months: 14,
      fiscalYearStartMonth: 1,
      proration: 'actual_days',
    });
    expect(calendar.periods).toHaveLength(14);
    expect(calendar.periods[0]?.startDate).toBe('2026-03-01');
    expect(calendar.periods[0]?.endDate).toBe('2026-03-31');
    expect(calendar.periods[13]?.startDate).toBe('2027-04-01');
    expect(calendar.periods[13]?.endDate).toBe('2027-04-30');
    // Calendar fiscal year: 10 months in 2026, 4 in 2027.
    expect(calendar.periodsByFiscalYear.get(2026)).toHaveLength(10);
    expect(calendar.periodsByFiscalYear.get(2027)).toHaveLength(4);
  });

  it('labels a July fiscal year by the year it ends in', () => {
    expect(fiscalPosition(parseDate('2026-07-01'), 7)).toEqual({
      fiscalYear: 2027,
      fiscalPeriod: 1,
    });
    expect(fiscalPosition(parseDate('2027-06-30'), 7)).toEqual({
      fiscalYear: 2027,
      fiscalPeriod: 12,
    });
    expect(fiscalPosition(parseDate('2026-06-01'), 7)).toEqual({
      fiscalYear: 2026,
      fiscalPeriod: 12,
    });
  });
});

describe('period coverage', () => {
  const calendar = buildCalendar({
    startDate: '2026-01-01',
    months: 3,
    fiscalYearStartMonth: 1,
    proration: 'actual_days',
  });
  const january = calendar.periods[0]!;
  const february = calendar.periods[1]!;

  it('returns 1 for a period fully inside the interval', () => {
    expect(
      periodCoverage(
        january,
        parseDate('2025-01-01'),
        parseDate('2027-01-01'),
        'actual_days',
      ).toString(),
    ).toBe('1');
  });

  it('prorates a partial month by actual days', () => {
    // 16 January to 31 January is 16 of January's 31 days.
    const coverage = periodCoverage(january, parseDate('2026-01-16'), null, 'actual_days');
    expect(coverage.toFixed(10)).toBe((16 / 31).toFixed(10));
  });

  it('prorates on a 30/360 basis when configured', () => {
    // 16 January to month end counts as 15 of 30 days under 30/360.
    const coverage = periodCoverage(january, parseDate('2026-01-16'), null, 'thirty_360');
    expect(coverage.toString()).toBe('0.5');
  });

  it('bills a whole month under the full-month convention', () => {
    const coverage = periodCoverage(january, parseDate('2026-01-25'), null, 'full_month');
    expect(coverage.toString()).toBe('1');
  });

  it('returns 0 when the interval misses the period', () => {
    expect(periodCoverage(february, null, parseDate('2026-01-31'), 'actual_days').toString()).toBe(
      '0',
    );
  });

  it('handles a leap-February correctly', () => {
    const leap = buildCalendar({
      startDate: '2024-02-01',
      months: 1,
      fiscalYearStartMonth: 1,
      proration: 'actual_days',
    });
    const coverage = periodCoverage(leap.periods[0]!, parseDate('2024-02-15'), null, 'actual_days');
    // 15 February to 29 February inclusive is 15 of 29 days.
    expect(coverage.toFixed(10)).toBe((15 / 29).toFixed(10));
  });
});

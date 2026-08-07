import type { PeriodMeta } from '@cre/domain-models';
import type { CellSpec, NumberFormatName, RefResolver, SheetModel } from './model.js';

/**
 * Column geometry shared by every period schedule.
 *
 * Each schedule reads left to right: what the line is, what it totals to, then
 * one column per forecast month. Keeping the geometry in one place is what lets
 * a sheet be re-ordered without touching a formula.
 */
export const LABEL_COL = 1;
export const TOTAL_COL = 2;
export const FIRST_PERIOD_COL = 3;

/** Column for a 0-based period index. */
export function periodColumn(period: number): number {
  return FIRST_PERIOD_COL + period;
}

/**
 * The time axis.
 *
 * The engine calculates monthly and rolls up to fiscal years, so the workbook
 * is monthly too. An annual workbook would be narrower and would quietly be a
 * different model: expenses step on forecast-year boundaries, debt amortises
 * monthly, and a sale lands in a month rather than a year.
 */
export interface TimeAxis {
  periods: PeriodMeta[];
  count: number;
  /** Fiscal years present, in order. */
  fiscalYears: number[];
  /** 0-based period indices belonging to a fiscal year. */
  periodsInYear(fiscalYear: number): number[];
}

export function timeAxis(periods: PeriodMeta[]): TimeAxis {
  const fiscalYears = [...new Set(periods.map((period) => period.fiscalYear))].sort(
    (a, b) => a - b,
  );
  return {
    periods,
    count: periods.length,
    fiscalYears,
    periodsInYear: (fiscalYear) =>
      periods
        .map((period, index) => ({ period, index }))
        .filter((entry) => entry.period.fiscalYear === fiscalYear)
        .map((entry) => entry.index),
  };
}

export interface SeriesRowOptions {
  label: string;
  /** Registry key; period cells are registered as `key#period`. */
  key: string;
  format?: NumberFormatName;
  indent?: number;
  bold?: boolean;
  /** Adds a row total in column B. Off for rates and balances, where a sum is meaningless. */
  total?: boolean;
  note?: string;
}

/**
 * Writes one line across every period.
 *
 * `cell` returns the spec for a period, so a caller decides per period whether
 * something is a formula or a value — the first period of a debt schedule draws
 * its opening balance from an assumption while every later one references the
 * period before it.
 */
export function seriesRow(
  sheet: SheetModel,
  axis: TimeAxis,
  options: SeriesRowOptions,
  cell: (period: number) => CellSpec,
): number {
  const row = sheet.claimRow();
  sheet.label(row, LABEL_COL, options.label, {
    ...(options.bold === undefined ? {} : { bold: options.bold }),
    ...(options.indent === undefined ? {} : { indent: options.indent }),
  });

  for (let period = 0; period < axis.count; period += 1) {
    const spec = cell(period);
    sheet.at(
      row,
      periodColumn(period),
      {
        ...spec,
        format: spec.format ?? options.format ?? 'currency',
        ...(options.bold === undefined ? {} : { bold: options.bold }),
        ...(period === 0 && options.note !== undefined ? { note: options.note } : {}),
      },
      `${options.key}#${period}`,
    );
  }

  if (options.total !== false) {
    sheet.at(
      row,
      TOTAL_COL,
      {
        kind: 'formula',
        formula: (refs) => `SUM(${refs.range(options.key, 0, axis.count - 1)})`,
        format: options.format ?? 'currency',
        ...(options.bold === undefined ? {} : { bold: options.bold }),
      },
      `${options.key}.total`,
    );
  }

  return row;
}

/** The period header block: month number, month end date, fiscal year. */
export function periodHeader(sheet: SheetModel, axis: TimeAxis): void {
  const monthRow = sheet.claimRow();
  sheet.at(monthRow, LABEL_COL, { kind: 'header', value: 'Period', format: 'text' });
  sheet.at(monthRow, TOTAL_COL, { kind: 'header', value: 'Total', format: 'text' });

  const dateRow = sheet.claimRow();
  sheet.at(dateRow, LABEL_COL, { kind: 'header', value: 'Month ending', format: 'text' });

  const yearRow = sheet.claimRow();
  sheet.at(yearRow, LABEL_COL, { kind: 'header', value: 'Fiscal year', format: 'text' });

  for (let period = 0; period < axis.count; period += 1) {
    const meta = axis.periods[period];
    if (!meta) continue;
    const column = periodColumn(period);
    sheet.at(monthRow, column, { kind: 'header', value: meta.index, format: 'integer' });
    sheet.at(
      dateRow,
      column,
      { kind: 'metadata', value: meta.endDate, format: 'text' },
      `period.endDate#${period}`,
    );
    sheet.at(yearRow, column, { kind: 'metadata', value: meta.fiscalYear, format: 'integer' });
  }
}

/** Standard widths: a wide label column, then uniform period columns. */
export function scheduleColumnWidths(axis: TimeAxis): Array<{ column: number; width: number }> {
  const widths = [
    { column: LABEL_COL, width: 42 },
    { column: TOTAL_COL, width: 16 },
  ];
  for (let period = 0; period < axis.count; period += 1) {
    widths.push({ column: periodColumn(period), width: 14 });
  }
  return widths;
}

/** `SUM` over a whole line, used by the checks sheet and by totals. */
export function sumOfSeries(refs: RefResolver, key: string, axis: TimeAxis): string {
  return `SUM(${refs.range(key, 0, axis.count - 1)})`;
}

import { describe, expect, it } from 'vitest';
import type { AnnualSummaryRow, ModelResult } from '@cre/domain-models';
import { calculate } from './engine.js';
import { baseModel, extendModel } from './__fixtures__/builders.js';

/**
 * `computeCapital`'s five methods, and the date-window and out-of-order
 * checks around them.
 *
 * Existing coverage only ever proves that whatever `computeCapital` produces
 * reconciles into unlevered cash flow (`regression.test.ts` fixture 20,
 * `properties.test.ts`'s invariant sweep) — never that each method's own
 * arithmetic, or the date gating, is correct. `fixed_annual` had never been
 * used for a capital item in any fixture at all.
 */

function year(result: ModelResult, fiscalYear: number): AnnualSummaryRow {
  const row = result.annual.find((entry) => entry.fiscalYear === fiscalYear);
  if (!row) throw new Error(`Fiscal year ${fiscalYear} is not in the result`);
  return row;
}

const FORECAST = {
  startDate: '2026-01-01',
  months: 12,
  fiscalYearStartMonth: 1,
  proration: 'actual_days' as const,
};

describe('capital: the four recurring methods, combined', () => {
  const model = extendModel(baseModel(), {
    forecast: FORECAST,
    property: {
      id: 'P1',
      name: 'Fixture Property',
      propertyType: 'office',
      rentableArea: '100000',
      unitCount: 50,
      ownershipPercent: '1',
    },
    // per_area_per_year is computed against the space list's own total, not
    // the property's stated rentableArea — the two are reconciled elsewhere
    // (an AREA_MISMATCH diagnostic when they disagree) but computeCapital
    // itself reads only the space list. Without one here, "$1.20/sf" prices
    // zero square feet.
    spaces: [{ id: 'S1', code: 'Building', area: '100000', spaceType: 'office' }],
    capital: [
      {
        id: 'CAP-FIXED',
        name: 'Fixed annual reserve',
        category: 'other',
        method: 'fixed_annual',
        amount: '120000',
      },
      {
        id: 'CAP-AREA',
        name: 'Per-area reserve',
        category: 'other',
        method: 'per_area_per_year',
        amount: '1.20',
      },
      {
        id: 'CAP-UNIT',
        name: 'Per-unit reserve',
        category: 'other',
        method: 'per_unit_per_year',
        amount: '200',
      },
      {
        id: 'CAP-SCHEDULE',
        name: 'Scheduled draws',
        category: 'other',
        method: 'custom_monthly_schedule',
        monthlySchedule: Array.from({ length: 12 }, (_, i) => String((i + 1) * 1000)),
      },
    ],
  });

  const result = calculate(model);

  it('sums all four methods to their hand-derived annual total', () => {
    // fixed_annual: $120,000/yr flat = $120,000.
    // per_area_per_year: $1.20/sf x 100,000 sf = $120,000/yr.
    // per_unit_per_year: $200/unit x 50 units = $10,000/yr.
    // custom_monthly_schedule: 1,000 + 2,000 + ... + 12,000 = $78,000.
    const expectedTotal = 120_000 + 120_000 + 10_000 + 78_000;
    expect(expectedTotal).toBe(328_000);
    expect(-Number(year(result, 2026).lines.capitalExpenditures)).toBeCloseTo(expectedTotal, 2);
  });

  it('bills the scheduled draws in the exact month the schedule names, not spread or shifted', () => {
    // Isolated by subtracting the other three methods' own flat monthly
    // contribution: fixed_annual and per_area_per_year are each exactly
    // $10,000.00/month, per_unit_per_year is $833.33.../month, every month
    // alike, so whatever moves month to month is the schedule alone.
    const flatMonthly = 10_000 + 10_000 + 10_000 / 12;
    const january = -Number(result.monthly.capitalExpenditures[0]) - flatMonthly;
    const december = -Number(result.monthly.capitalExpenditures[11]) - flatMonthly;
    expect(january).toBeCloseTo(1_000, 2);
    expect(december).toBeCloseTo(12_000, 2);
  });
});

describe('capital: one-time cost and a date-windowed recurring cost', () => {
  const model = extendModel(baseModel(), {
    forecast: FORECAST,
    capital: [
      {
        id: 'CAP-ONETIME',
        name: 'Roof replacement',
        category: 'major_project',
        method: 'one_time',
        amount: '50000',
        startDate: '2026-06-15',
      },
      {
        id: 'CAP-WINDOW',
        name: 'Elevator modernization',
        category: 'major_project',
        method: 'fixed_annual',
        amount: '60000',
        startDate: '2026-04-01',
        endDate: '2026-06-30',
      },
    ],
  });

  const result = calculate(model);

  it('charges the one-time cost only in the period containing its date', () => {
    const byMonth = result.monthly.capitalExpenditures.map((v) => -Number(v));
    // Only May (index 4, the window's own $5,000) precedes the one-time
    // cost; June (index 5) carries both the window's $5,000 and the full
    // $50,000 one-time charge, landing in one period, not spread across it.
    expect(byMonth[4]).toBeCloseTo(5_000, 2);
    expect(byMonth[5]).toBeCloseTo(55_000, 2);
    expect(byMonth[6]).toBeCloseTo(0, 2);
  });

  it('charges the windowed recurring cost only inside its start and end dates', () => {
    const byMonth = result.monthly.capitalExpenditures.map((v) => -Number(v));
    // $60,000/yr = $5,000/month, but only April (3), May (4) and June (5,
    // net of the one-time charge checked above) fall inside the window.
    expect(byMonth[2]).toBeCloseTo(0, 2); // March: before the window
    expect(byMonth[3]).toBeCloseTo(5_000, 2); // April: window opens
    expect(byMonth[4]).toBeCloseTo(5_000, 2); // May: window still open
    expect(byMonth[6]).toBeCloseTo(0, 2); // July: after the window
  });
});

describe('capital: an item whose end date precedes its start date', () => {
  it('is refused with a diagnostic rather than silently computed', () => {
    const model = extendModel(baseModel(), {
      forecast: FORECAST,
      capital: [
        {
          id: 'CAP-BACKWARDS',
          name: 'Malformed capital item',
          category: 'other',
          method: 'fixed_annual',
          amount: '12000',
          startDate: '2026-06-01',
          endDate: '2026-01-01',
        },
      ],
    });

    const result = calculate(model);
    const diagnostic = result.diagnostics.find(
      (entry) => entry.code === 'CAPITAL_DATES_OUT_OF_ORDER',
    );
    expect(diagnostic).toBeDefined();
    expect(diagnostic?.severity).toBe('error');
  });
});

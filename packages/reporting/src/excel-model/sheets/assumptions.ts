import type { ModelInput, ModelResult } from '@cre/domain-models';
import type { WorkbookModel } from '../model.js';
import {
  FIRST_PERIOD_COL,
  LABEL_COL,
  TOTAL_COL,
  periodColumn,
  periodHeader,
  scheduleColumnWidths,
  seriesRow,
} from '../layout.js';
import type { TimeAxis } from '../layout.js';

/**
 * Every assumption the reader is meant to change, in one place.
 *
 * Nothing downstream restates a number that lives here. A rate typed twice is a
 * rate that will eventually disagree with itself, so the Debt sheet references
 * `InterestRate` rather than carrying its own copy.
 *
 * ## Growth factors are calculated here, not imported
 *
 * The engine turns an annual rate into a per-period multiplier: the first
 * twelve forecast months carry a factor of 1.0, and growth compounds on each
 * forecast-year boundary afterwards (see `CurveSet.factors`). That is a
 * closed-form rule, so the workbook reproduces it exactly rather than pasting
 * the engine's factors — which is what makes changing a growth rate actually
 * move the model.
 *
 * The per-year rate is editable for each forecast year, so a curve with
 * different rates by year exports faithfully instead of being flattened to an
 * average.
 */
export function buildAssumptions(
  workbook: WorkbookModel,
  input: ModelInput,
  result: ModelResult,
  axis: TimeAxis,
): void {
  const sheet = workbook.sheet('Assumptions', {
    freezeRows: 3,
    freezeColumns: 2,
    columnWidths: scheduleColumnWidths(axis),
    description: 'Editable model assumptions. Blue cells are inputs.',
  });

  const forecastYears = Math.max(1, Math.ceil(axis.count / 12));

  sheet.at(sheet.claimRow(), LABEL_COL, {
    kind: 'header',
    value: `${input.modelName} — assumptions`,
    format: 'text',
  });
  sheet.skipRows(1);

  /* ---------------------------------------------------------------- */
  sheet.section('Property');
  scalarText(sheet, 'Property name', input.property.name);
  scalarText(sheet, 'Property type', input.property.propertyType);
  scalarText(sheet, 'Market', input.property.market ?? '—');
  scalarInput(
    sheet,
    workbook,
    'Rentable area',
    Number(input.property.rentableArea ?? '0'),
    'area',
    'RentableArea',
    'assumptions.rentableArea',
  );
  scalarInput(
    sheet,
    workbook,
    'Unit count',
    input.property.unitCount,
    'integer',
    'UnitCount',
    'assumptions.unitCount',
  );

  /* ---------------------------------------------------------------- */
  sheet.section('Acquisition');
  scalarText(sheet, 'Forecast start', input.forecast.startDate);
  scalarText(
    sheet,
    'Acquisition date',
    input.valuation.acquisitionDate ?? input.forecast.startDate,
  );
  scalarInput(
    sheet,
    workbook,
    'Purchase price',
    Number(input.valuation.acquisitionPrice ?? '0'),
    'currency0',
    'PurchasePrice',
    'assumptions.purchasePrice',
  );
  scalarInput(
    sheet,
    workbook,
    'Acquisition costs',
    Number(input.valuation.acquisitionCosts),
    'currency0',
    'AcquisitionCosts',
    'assumptions.acquisitionCosts',
  );

  /* ---------------------------------------------------------------- */
  sheet.section('Hold and exit');
  const saleMonth = input.valuation.saleMonth ?? axis.count;
  scalarInput(
    sheet,
    workbook,
    'Sale month (1-based)',
    saleMonth,
    'integer',
    'SaleMonth',
    'assumptions.saleMonth',
    'Changing this moves which period the sale lands in on the Cash Flow sheet.',
  );
  scalarInput(
    sheet,
    workbook,
    'Exit cap rate',
    Number(input.valuation.terminalCapRate ?? '0'),
    'percent2',
    'ExitCapRate',
    'assumptions.exitCapRate',
  );
  scalarInput(
    sheet,
    workbook,
    'Selling costs (% of price)',
    Number(input.valuation.saleCostPercent),
    'percent2',
    'SellingCosts',
    'assumptions.sellingCosts',
  );
  scalarInput(
    sheet,
    workbook,
    'Discount rate',
    Number(input.valuation.discountRate),
    'percent2',
    'DiscountRate',
    'assumptions.discountRate',
  );
  scalarText(sheet, 'Terminal NOI basis', input.valuation.terminalNoiBasis);

  /* ---------------------------------------------------------------- */
  sheet.section('Vacancy and credit loss');
  scalarInput(
    sheet,
    workbook,
    'General vacancy rate',
    Number(input.vacancy.generalVacancyRate),
    'percent2',
    'GeneralVacancy',
    'assumptions.generalVacancy',
  );
  scalarInput(
    sheet,
    workbook,
    'Credit loss rate',
    Number(input.vacancy.creditLossRate),
    'percent2',
    'CreditLoss',
    'assumptions.creditLoss',
  );

  /* ---------------------------------------------------------------- */
  /* Operating expense assumptions                                     */
  /* ---------------------------------------------------------------- */
  if (input.expenses.length > 0) {
    sheet.section('Operating expenses');
    for (const expense of input.expenses) {
      const row = sheet.claimRow();
      sheet.label(row, LABEL_COL, `${expense.name} (${expense.method})`, { indent: 1 });
      sheet.at(
        row,
        TOTAL_COL,
        { kind: 'input', value: Number(expense.amount), format: amountFormat(expense.method) },
        `expense.${expense.id}.amount`,
      );
      // Placed to the right of the amount rather than on their own rows: they
      // are modifiers of it, and a reader scanning the column wants the rate
      // next to the number it scales.
      sheet.at(
        row,
        FIRST_PERIOD_COL,
        { kind: 'input', value: Number(expense.variableShare), format: 'percent2' },
        `expense.${expense.id}.variableShare`,
      );
      sheet.at(row, FIRST_PERIOD_COL + 1, {
        kind: 'metadata',
        value: 'variable share',
        format: 'text',
      });
    }
  }

  /* ---------------------------------------------------------------- */
  /* Debt                                                              */
  /* ---------------------------------------------------------------- */
  if (input.debt.length > 0) {
    sheet.section('Debt');
    for (const [index, facility] of input.debt.entries()) {
      const row = sheet.claimRow();
      sheet.label(row, LABEL_COL, `${facility.name} — commitment`, { indent: 1 });
      sheet.at(
        row,
        TOTAL_COL,
        { kind: 'input', value: Number(facility.commitment), format: 'currency0' },
        `debt.${facility.id}.commitment`,
      );

      const rateRow = sheet.claimRow();
      sheet.label(rateRow, LABEL_COL, `${facility.name} — ${facility.rateType} rate`, {
        indent: 1,
      });
      sheet.at(
        rateRow,
        TOTAL_COL,
        {
          kind: 'input',
          value: Number(facility.fixedRate),
          format: 'percent2',
          // The first facility takes the plain name, so a single-loan model —
          // which is most of them — reads `InterestRate` in its formulas.
          definedName: index === 0 ? 'InterestRate' : `InterestRate_${index + 1}`,
          ...(facility.rateType === 'floating'
            ? {
                note:
                  'This facility floats. The rate actually applied each period is on the Debt ' +
                  'sheet, where it is editable; this cell is the fixed component only.',
              }
            : {}),
        },
        `debt.${facility.id}.fixedRate`,
      );

      const feeRow = sheet.claimRow();
      sheet.label(feeRow, LABEL_COL, `${facility.name} — origination / exit fee`, { indent: 1 });
      sheet.at(
        feeRow,
        TOTAL_COL,
        { kind: 'input', value: Number(facility.originationFeePercent), format: 'percent2' },
        `debt.${facility.id}.originationFee`,
      );
      sheet.at(
        feeRow,
        FIRST_PERIOD_COL,
        { kind: 'input', value: Number(facility.exitFeePercent), format: 'percent2' },
        `debt.${facility.id}.exitFee`,
      );

      // Structural terms. They shape the schedule rather than scale it, and the
      // Debt sheet resolves them at build time, so they are shown but not
      // wired: editing them here would not move the amortisation.
      const termRow = sheet.claimRow();
      sheet.label(termRow, LABEL_COL, `${facility.name} — IO / amortisation / term months`, {
        indent: 1,
      });
      sheet.at(termRow, TOTAL_COL, {
        kind: 'metadata',
        value: `${facility.interestOnlyMonths} / ${facility.amortizationMonths} / ${facility.termMonths}`,
        format: 'text',
        note: 'Structural. The schedule shape is fixed at export; changing these needs a re-export.',
      });
    }
  }

  /* ---------------------------------------------------------------- */
  /* Growth curves                                                     */
  /* ---------------------------------------------------------------- */
  if (input.growthCurves.length > 0) {
    sheet.skipRows(1);
    sheet.section('Growth curves');
    periodHeader(sheet, axis);

    for (const curve of input.growthCurves) {
      const rateRow = sheet.claimRow();
      sheet.label(rateRow, LABEL_COL, `${curve.name} — annual rate by forecast year`, {
        indent: 1,
      });
      /*
       * One editable rate per forecast year, placed in the first month of that
       * year. Forecast year 1 never has growth applied, matching the engine,
       * so its rate cell is written but never referenced by a factor.
       */
      for (let year = 1; year <= forecastYears; year += 1) {
        const firstPeriodOfYear = (year - 1) * 12;
        if (firstPeriodOfYear >= axis.count) break;
        const override = curve.byYear.find((entry) => entry.year === year);
        sheet.at(
          rateRow,
          periodColumn(firstPeriodOfYear),
          {
            kind: 'input',
            value: Number(override ? override.rate : curve.defaultRate),
            format: 'percent2',
          },
          `curve.${curve.id}.rate#${year}`,
        );
      }

      seriesRow(
        sheet,
        axis,
        {
          label: `${curve.name} — cumulative factor`,
          key: `curve.${curve.id}.factor`,
          format: 'ratio',
          indent: 2,
          total: false,
        },
        (period) => {
          if (period === 0) return { kind: 'formula', formula: () => '1' };
          const year = Math.floor(period / 12) + 1;
          // A forecast-year boundary steps the factor; every other month holds.
          if (period % 12 === 0) {
            return {
              kind: 'formula',
              formula: (refs) =>
                `${refs.ref(`curve.${curve.id}.factor`, period - 1)}*` +
                `(1+${refs.ref(`curve.${curve.id}.rate`, year)})`,
            };
          }
          return {
            kind: 'formula',
            formula: (refs) => refs.ref(`curve.${curve.id}.factor`, period - 1),
          };
        },
      );
    }
  }

  /* ---------------------------------------------------------------- */
  /* Occupancy, which several expense lines scale with                 */
  /* ---------------------------------------------------------------- */
  sheet.skipRows(1);
  sheet.section('Occupancy');
  seriesRow(
    sheet,
    axis,
    {
      label: 'Physical occupancy',
      key: 'assumptions.occupancy',
      format: 'percent',
      indent: 1,
      total: false,
      note:
        'From the leasing engine: absorption, downtime and rollover are modelled lease by ' +
        'lease and cannot be reduced to a closed form here. Occupancy-sensitive expenses ' +
        'reference this row.',
    },
    (period) => ({
      kind: 'staticDerived',
      value: Number(result.occupancy[period]?.physicalOccupancyPercent ?? '1'),
      format: 'percent',
    }),
  );

  sheet.at(sheet.nextRow, LABEL_COL, { kind: 'label', value: '' });
}

/* -------------------------------------------------------------------------- */
/* Small helpers. Assumption rows are label-in-A, value-in-B.                  */
/* -------------------------------------------------------------------------- */

function scalarText(sheet: ReturnType<WorkbookModel['sheet']>, label: string, value: string): void {
  const row = sheet.claimRow();
  sheet.label(row, LABEL_COL, label, { indent: 1 });
  sheet.at(row, TOTAL_COL, { kind: 'metadata', value, format: 'text' });
}

function scalarInput(
  sheet: ReturnType<WorkbookModel['sheet']>,
  _workbook: WorkbookModel,
  label: string,
  value: number,
  format: 'currency' | 'currency0' | 'percent2' | 'integer' | 'area',
  definedName: string,
  key: string,
  note?: string,
): void {
  const row = sheet.claimRow();
  sheet.label(row, LABEL_COL, label, { indent: 1 });
  sheet.at(
    row,
    TOTAL_COL,
    {
      kind: 'input',
      value,
      format,
      definedName,
      ...(note === undefined ? {} : { note }),
    },
    key,
  );
}

/**
 * A percentage method holds a rate; every other method holds an amount.
 * Formatting a 3% management fee as currency would read as three dollars.
 */
function amountFormat(method: string): 'currency' | 'percent2' {
  return method.startsWith('percent_of_') ? 'percent2' : 'currency';
}

/** Column the assumption values live in, for callers that need the geometry. */
export const ASSUMPTION_VALUE_COL = TOTAL_COL;
export const ASSUMPTION_FIRST_PERIOD_COL = FIRST_PERIOD_COL;

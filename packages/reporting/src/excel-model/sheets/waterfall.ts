import type { ModelInput, ModelResult } from '@cre/domain-models';
import type { WorkbookModel } from '../model.js';
import { LABEL_COL, TOTAL_COL } from '../layout.js';
import type { TimeAxis } from '../layout.js';

/**
 * The partnership waterfall: who put in what, who took out what, when, and
 * through which tier.
 *
 * Four identities hold across every fixture that has a waterfall and are
 * exported as formulas:
 *
 *   distributions   = sum of the tier amounts
 *   profit          = distributions - contributions
 *   equity multiple = distributions / contributions
 *   IRR             = XIRR over the partner's own dated cash-flow row
 *
 * So the sheet is auditable: a partner's multiple traces to the tiers that
 * produced it, their IRR traces to the dated flows below it, and both add up in
 * front of the reader rather than in the engine.
 *
 * ## The cash-flow rows, and why the IRR sits on top of them
 *
 * `XIRR` needs a dated series, so each partner gets one row: their share of the
 * equity funded at closing in the first column, then one column per forecast
 * month. Negative is a capital call, positive a distribution — the engine never
 * puts both in one month, because a period that needs cash is funded before any
 * tier is paid.
 *
 * The row total is `SUM` over that row and must equal the partner's profit,
 * which is itself a formula over the tiers. That is the tie-out: the imported
 * flows and the formula-driven totals are computed by different routes, so a
 * dropped period or a flipped sign shows up as a `CHECK` on the Summary sheet
 * instead of as a quietly wrong IRR.
 *
 * ## What is imported, and why
 *
 * **The tier amounts, and the flows themselves.** Splitting a distribution
 * across a preferred return, return of capital, a catch-up and a residual
 * promote is a sequential draw-down against running accrual balances, period by
 * period — not a closed form. Reproducing it would be the second engine this
 * design exists to prevent, so both are carried across as values and counted
 * against formula coverage rather than disguised.
 *
 * It would be easy to make these rows *look* live — scale each partner's flow
 * by the period's equity cash flow and hold their share of it fixed. That is
 * rejected deliberately: the tiers are non-linear, so a changed assumption
 * changes the split as well as the amount, and a row that moves in the right
 * direction by the wrong amount is worse than one that is plainly labelled.
 * Editing a flow cell does move the IRR, which is the connectivity that is real
 * here.
 */
export function buildWaterfall(
  workbook: WorkbookModel,
  input: ModelInput,
  result: ModelResult,
  axis: TimeAxis,
): void {
  const partners = result.waterfall;
  if (partners.length === 0) return;

  /*
   * The label and total columns are wide; every column right of them carries
   * either a tier amount or one month of a partner's cash flow, so they are
   * sized uniformly. The tier table is narrower than the cash-flow rows below
   * it, and the wider of the two wins.
   */
  const columnWidths = [
    { column: LABEL_COL, width: 30 },
    { column: TOTAL_COL, width: 18 },
  ];
  for (let offset = 0; offset <= axis.count; offset += 1) {
    columnWidths.push({ column: TOTAL_COL + 1 + offset, width: 16 });
  }

  const sheet = workbook.sheet('Waterfall', {
    freezeRows: 2,
    freezeColumns: 1,
    columnWidths,
  });

  sheet.at(sheet.claimRow(), LABEL_COL, {
    kind: 'header',
    value: 'Partnership waterfall',
    format: 'text',
  });

  /*
   * Tier names come from the first partner, and every partner is checked
   * against them. A model where partners saw different tiers would produce a
   * table whose columns meant different things per row, so it is rejected
   * rather than rendered misleadingly.
   */
  const tierNames = partners[0]?.byTier.map((tier) => tier.tierName) ?? [];
  for (const partner of partners) {
    const names = partner.byTier.map((tier) => tier.tierName);
    if (names.length !== tierNames.length || names.some((n, i) => n !== tierNames[i])) {
      throw new Error(
        `Partner "${partner.partnerName}" has different waterfall tiers from the first ` +
          'partner, so a single table cannot describe them all.',
      );
    }
  }

  const headerRow = sheet.claimRow();
  const columns = [
    'Partner',
    'Contributions',
    ...tierNames,
    'Distributions',
    'Profit',
    'Multiple',
    'IRR',
  ];
  columns.forEach((heading, offset) => {
    sheet.at(headerRow, LABEL_COL + offset, { kind: 'header', value: heading, format: 'text' });
  });

  const tierStart = 2;
  const distributionsCol = tierStart + tierNames.length;

  for (const [index, partner] of partners.entries()) {
    const row = sheet.claimRow();
    const key = `waterfall.${index}`;
    const put = (offset: number, spec: Parameters<typeof sheet.at>[2], suffix: string): void => {
      sheet.at(row, LABEL_COL + offset, spec, `${key}.${suffix}`);
    };

    sheet.at(row, LABEL_COL, {
      kind: 'metadata',
      value: partner.partnerName,
      format: 'text',
    });

    put(
      1,
      { kind: 'input', value: Number(partner.contributions), format: 'currency0' },
      'contributions',
    );

    partner.byTier.forEach((tier, tierIndex) => {
      put(
        tierStart + tierIndex,
        {
          kind: 'staticDerived',
          value: Number(tier.amount),
          format: 'currency0',
          ...(tierIndex === 0
            ? {
                note:
                  'Tier amounts are imported: the split is a sequential draw-down against a ' +
                  'running balance period by period, not a closed form.',
              }
            : {}),
        },
        `tier.${tierIndex}`,
      );
    });

    put(
      distributionsCol,
      {
        kind: 'formula',
        formula: (refs) =>
          tierNames.length === 0
            ? '0'
            : tierNames.map((_, t) => refs.ref(`${key}.tier.${t}`)).join('+'),
        format: 'currency0',
        cachedValue: Number(partner.distributions),
        bold: true,
      },
      'distributions',
    );

    put(
      distributionsCol + 1,
      {
        kind: 'formula',
        formula: (refs) =>
          `${refs.ref(`${key}.distributions`)}-${refs.ref(`${key}.contributions`)}`,
        format: 'currency0',
        cachedValue: Number(partner.profit),
      },
      'profit',
    );

    put(
      distributionsCol + 2,
      {
        kind: 'formula',
        // Guarded: a partner who contributed nothing has no multiple, and
        // #DIV/0! across a summary table is worse than a blank.
        formula: (refs) =>
          `IF(${refs.ref(`${key}.contributions`)}=0,0,` +
          `${refs.ref(`${key}.distributions`)}/${refs.ref(`${key}.contributions`)})`,
        format: 'multiple',
        cachedValue: partner.equityMultiple === null ? null : Number(partner.equityMultiple),
      },
      'multiple',
    );

    put(
      distributionsCol + 3,
      {
        kind: 'formula',
        // Over the partner's own row below, exactly as the Returns sheet does
        // for the property. IFERROR because a partner whose flows never change
        // sign has no rate of return, and #NUM! across a summary table is worse
        // than a blank.
        formula: (refs) =>
          `IFERROR(XIRR(${refs.range(`${key}.flow`, 0, axis.count)},` +
          `${refs.range('waterfall.date', 0, axis.count)}),"n/a")`,
        format: 'percent2',
        // The engine's day-count IRR, not its uniform-month one: XIRR uses
        // actual days, so this is the figure Excel will land on when it
        // recalculates. The two differ by well under a basis point, but a
        // cached value that does not match the formula is exactly the kind of
        // quiet disagreement this exporter exists to avoid.
        cachedValue: partner.xirr === null ? null : Number(partner.xirr),
        ...(index === 0
          ? {
              note:
                'Calculated by Excel from the partner cash-flow row below, not imported. ' +
                'Annual effective, on actual day counts — the same basis as the levered ' +
                'XIRR on the Returns sheet.',
            }
          : {}),
      },
      'irr',
    );
  }

  /* Totals, which are what the checks compare against. */
  const totalRow = sheet.claimRow();
  sheet.label(totalRow, LABEL_COL, 'All partners', { bold: true });

  const total = (offset: number, suffix: string): void => {
    sheet.at(
      totalRow,
      LABEL_COL + offset,
      {
        kind: 'formula',
        formula: (refs) =>
          partners.map((_, index) => refs.ref(`waterfall.${index}.${suffix}`)).join('+'),
        format: 'currency0',
        bold: true,
      },
      `waterfall.total.${suffix}`,
    );
  };

  total(1, 'contributions');
  total(distributionsCol, 'distributions');
  total(distributionsCol + 1, 'profit');

  buildPartnerCashFlows(sheet, input, result, axis);
}

/* -------------------------------------------------------------------------- */

/**
 * One dated cash-flow row per partner, laid out so `XIRR` above has something
 * to work from.
 *
 * The geometry matches the Returns sheet: column B is the row total, column C
 * is closing — before the first forecast month — and each month follows. Using
 * the same shape twice means a reader who has understood the property returns
 * has already understood these.
 */
function buildPartnerCashFlows(
  sheet: ReturnType<WorkbookModel['sheet']>,
  input: ModelInput,
  result: ModelResult,
  axis: TimeAxis,
): void {
  const partners = result.waterfall;
  const firstFlowCol = TOTAL_COL + 1;

  sheet.skipRows(1);
  sheet.section('Partner cash flows');

  const dateRow = sheet.claimRow();
  sheet.label(dateRow, LABEL_COL, 'Date', { indent: 1 });
  sheet.at(
    dateRow,
    firstFlowCol,
    {
      kind: 'metadata',
      // The first period's start, which is where the engine dates the closing
      // flow. Using the acquisition date instead would put the workbook on a
      // different day count from the IRR it is meant to reproduce whenever a
      // model closes on a date other than the forecast start.
      value: axis.periods[0]?.startDate ?? input.forecast.startDate,
      format: 'text',
    },
    'waterfall.date#0',
  );
  for (let period = 0; period < axis.count; period += 1) {
    sheet.at(
      dateRow,
      firstFlowCol + 1 + period,
      { kind: 'metadata', value: axis.periods[period]?.endDate ?? '', format: 'text' },
      `waterfall.date#${period + 1}`,
    );
  }

  const importNote =
    'Imported from the engine. The tier draw-down is sequential against running accrual ' +
    'balances, so a period split is not a closed form; the row total below ties to the ' +
    "partner's profit, which is.";

  for (const [index, partner] of partners.entries()) {
    const key = `waterfall.${index}`;
    const row = sheet.claimRow();
    sheet.label(row, LABEL_COL, partner.partnerName, { indent: 1 });

    sheet.at(
      row,
      TOTAL_COL,
      {
        kind: 'formula',
        // Ties to profit: every dollar in and out of the partnership passes
        // through this row exactly once.
        formula: (refs) => `SUM(${refs.range(`${key}.flow`, 0, axis.count)})`,
        format: 'currency0',
        cachedValue: Number(partner.profit),
      },
      `${key}.flowTotal`,
    );

    sheet.at(
      row,
      firstFlowCol,
      {
        kind: 'staticDerived',
        value: Number(partner.initialFlow),
        format: 'currency0',
        ...(index === 0 ? { note: importNote } : {}),
      },
      `${key}.flow#0`,
    );

    for (let period = 0; period < axis.count; period += 1) {
      sheet.at(
        row,
        firstFlowCol + 1 + period,
        {
          kind: 'staticDerived',
          value: Number(partner.flows[period] ?? '0'),
          format: 'currency0',
        },
        `${key}.flow#${period + 1}`,
      );
    }
  }

  /* The partnership as a whole, which is what the Summary check compares. */
  const totalRow = sheet.claimRow();
  sheet.label(totalRow, LABEL_COL, 'All partners', { bold: true });
  sheet.at(
    totalRow,
    TOTAL_COL,
    {
      kind: 'formula',
      formula: (refs) =>
        partners.map((_, index) => refs.ref(`waterfall.${index}.flowTotal`)).join('+'),
      format: 'currency0',
      bold: true,
    },
    'waterfall.total.flowTotal',
  );
}

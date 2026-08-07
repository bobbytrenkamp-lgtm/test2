import type { ModelResult } from '@cre/domain-models';
import type { WorkbookModel } from '../model.js';
import { LABEL_COL, TOTAL_COL } from '../layout.js';

/**
 * The partnership waterfall: who put in what, who took out what, and through
 * which tier.
 *
 * Three identities hold across every fixture that has a waterfall and are
 * exported as formulas:
 *
 *   distributions   = sum of the tier amounts
 *   profit          = distributions - contributions
 *   equity multiple = distributions / contributions
 *
 * So the sheet is auditable: a partner's multiple traces to the tiers that
 * produced it, and the tiers add up in front of the reader rather than in the
 * engine.
 *
 * ## What is imported, and why
 *
 * **The tier amounts themselves.** Splitting a distribution across a
 * preferred return, return of capital, a catch-up and a residual promote is a
 * sequential draw-down against a running balance, period by period — not a
 * closed form. Reproducing it would be the second engine this design exists
 * to prevent.
 *
 * **Each partner's IRR.** `ModelResult` reports the partnership at the level
 * of totals, not as a dated series per partner, so there is no cash-flow row
 * for Excel's `XIRR` to work from. The property-level returns on the Returns
 * sheet *are* computed by Excel from the workbook's own cash flows; these are
 * not, and the note on the cell says so rather than letting a reader assume
 * otherwise.
 *
 * Exporting a partner IRR as a formula would need the engine to expose
 * per-period partner cash flows. That is the next thing to ask for, and it is
 * recorded in `docs/excel-live-model.md` rather than worked around here.
 */
export function buildWaterfall(workbook: WorkbookModel, result: ModelResult): void {
  const partners = result.waterfall;
  if (partners.length === 0) return;

  const sheet = workbook.sheet('Waterfall', {
    freezeRows: 2,
    freezeColumns: 1,
    columnWidths: [
      { column: LABEL_COL, width: 30 },
      { column: TOTAL_COL, width: 18 },
    ],
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
        kind: 'staticDerived',
        value: partner.irr === null ? 0 : Number(partner.irr),
        format: 'percent2',
        ...(index === 0
          ? {
              note:
                'Imported, unlike the property returns. A partner IRR needs a dated cash-flow ' +
                'series per partner, which the engine reports only as totals.',
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
}

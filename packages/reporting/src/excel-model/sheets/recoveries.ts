import type { ModelResult } from '@cre/domain-models';
import type { WorkbookModel } from '../model.js';
import { LABEL_COL, TOTAL_COL, scheduleColumnWidths, seriesRow } from '../layout.js';
import type { TimeAxis } from '../layout.js';

/**
 * Expense recoveries: the annual settlement, and the monthly billing.
 *
 * Recoveries are the most intricate part of a CRE model and the part an analyst
 * most often wants to audit, so they get their own sheet rather than arriving
 * as one number inside Revenue.
 *
 * ## Which parts are formulas, and how that was decided
 *
 * Four candidate identities were tested against **all 102 detail rows** the
 * regression library produces. Two hold exactly and are exported as formulas:
 *
 *   share  = tenant area / denominator area          (exact, 102 rows)
 *   true-up = final recovery - estimated recovery    (exact, 102 rows)
 *
 * Two do **not** hold and are therefore not exported as formulas:
 *
 *   recovery before caps = grossed-up pool x share - base year - stop
 *   final recovery       = before caps + cap adjustment + admin fee
 *
 * Both are exact for base-year and expense-stop leases and wrong for
 * triple-net ones — out by up to $10,742 on the grocery-anchored fixture,
 * where the recovery is 1.15x what pool x share predicts. Whatever the engine
 * does for a triple-net recovery, it is not that product, so those two lines
 * are imported and counted as coverage gaps.
 *
 * This was caught by widening the check from five fixtures to all twenty. On
 * the five, both identities looked exact. A formula that is right for two
 * recovery structures and silently wrong for the third is worse than an
 * honest imported number.
 *
 * ## What stays as engine values, and why
 *
 * **The expense pool.** Linking it to the Expenses sheet would make the
 * workbook circular: a management fee on effective gross revenue depends on
 * revenue, revenue includes recoveries, and recoveries would then depend on the
 * fee. The engine resolves that with a damped fixed-point iteration; Excel
 * would need iterative calculation switched on, which is a setting a reader has
 * to know about and a workbook that silently misreports if it is off. The pool
 * is therefore imported, which keeps the dependency graph acyclic.
 *
 * **The cap adjustment**, which depends on a running history of prior years'
 * recoveries under a cap, and **the monthly split** between the estimate and
 * the true-up, which depends on per-occurrence occupancy fractions the result
 * does not expose.
 *
 * All of those are counted as coverage gaps rather than disguised.
 */
export function buildRecoveries(
  workbook: WorkbookModel,
  result: ModelResult,
  axis: TimeAxis,
): void {
  const sheet = workbook.sheet('Recoveries', {
    freezeRows: 4,
    freezeColumns: 2,
    columnWidths: scheduleColumnWidths(axis),
  });

  sheet.at(sheet.claimRow(), LABEL_COL, {
    kind: 'header',
    value: 'Expense recoveries',
    format: 'text',
  });

  /* ------------------------------------------------------------------ */
  /* Monthly billing, which is what Revenue reads                        */
  /* ------------------------------------------------------------------ */
  sheet.section('Monthly recoveries by lease');

  const leases = result.leaseCashFlows;
  for (const [index, lease] of leases.entries()) {
    seriesRow(
      sheet,
      axis,
      {
        label: lease.tenantName || lease.leaseId,
        key: `recoveries.lease.${index}`,
        indent: 1,
      },
      (period) => ({
        kind: 'staticDerived',
        value: Number(lease.recoveries[period] ?? '0'),
      }),
    );
  }

  seriesRow(
    sheet,
    axis,
    { label: 'Total expense recoveries', key: 'recoveries.total', bold: true },
    (period) => ({
      kind: 'formula',
      formula: (refs) =>
        leases.length === 0
          ? '0'
          : leases.map((_, index) => refs.ref(`recoveries.lease.${index}`, period)).join('+'),
      cachedValue: Number(result.monthly.expenseRecoveries[period] ?? '0'),
    }),
  );

  /* ------------------------------------------------------------------ */
  /* Annual settlement, where the business logic lives                   */
  /* ------------------------------------------------------------------ */
  if (result.recoveryDetail.length === 0) return;

  sheet.skipRows(1);
  sheet.section('Annual settlement');

  // A header row, since this block is a table rather than a time series.
  const headerRow = sheet.claimRow();
  const headings = [
    'Lease / pool / year',
    'Tenant area',
    'Denominator area',
    'Share',
    'Gross pool',
    'Grossed-up pool',
    'Base year',
    'Expense stop',
    'Before caps',
    'Cap adjustment',
    'Admin fee',
    'Final recovery',
    'Estimated',
    'True-up',
  ];
  headings.forEach((heading, offset) => {
    sheet.at(headerRow, LABEL_COL + offset, {
      kind: 'header',
      value: heading,
      format: 'text',
    });
  });

  for (const [index, detail] of result.recoveryDetail.entries()) {
    const row = sheet.claimRow();
    const key = `recovery.${index}`;

    sheet.label(
      row,
      LABEL_COL,
      `${detail.leaseId} · ${detail.poolName} · FY${detail.fiscalYear} (${detail.method})`,
      { indent: 1 },
    );

    const put = (offset: number, spec: Parameters<typeof sheet.at>[2], suffix: string): void => {
      sheet.at(row, LABEL_COL + offset, spec, `${key}.${suffix}`);
    };

    put(1, { kind: 'input', value: Number(detail.tenantArea), format: 'area' }, 'tenantArea');
    put(
      2,
      { kind: 'input', value: Number(detail.denominatorArea), format: 'area' },
      'denominatorArea',
    );
    put(
      3,
      {
        kind: 'formula',
        // Guarded: a pool with no denominator would show #DIV/0! rather than
        // the zero share the engine assigns it.
        formula: (refs) =>
          `IF(${refs.ref(`${key}.denominatorArea`)}=0,0,` +
          `${refs.ref(`${key}.tenantArea`)}/${refs.ref(`${key}.denominatorArea`)})`,
        format: 'percent2',
        cachedValue: Number(detail.proRataShare),
      },
      'share',
    );
    put(
      4,
      {
        kind: 'staticDerived',
        value: Number(detail.grossExpensePool),
        format: 'currency0',
        note:
          'Imported rather than linked to the Expenses sheet: a management fee on effective ' +
          'gross revenue would make the workbook circular. See the sheet documentation.',
      },
      'grossPool',
    );
    put(
      5,
      { kind: 'staticDerived', value: Number(detail.grossedUpExpensePool), format: 'currency0' },
      'grossedUpPool',
    );
    put(
      6,
      { kind: 'input', value: Number(detail.baseYearAmount), format: 'currency0' },
      'baseYear',
    );
    put(7, { kind: 'input', value: Number(detail.expenseStopAmount), format: 'currency0' }, 'stop');
    put(
      8,
      {
        kind: 'staticDerived',
        value: Number(detail.recoveryBeforeCaps),
        format: 'currency0',
        note:
          'Imported, not calculated. `grossed-up pool x share - base year - stop` reproduces ' +
          'this exactly for base-year and expense-stop leases but not for triple-net ones, ' +
          'so exporting it as a formula would be wrong for part of the rent roll.',
      },
      'beforeCaps',
    );
    put(
      9,
      {
        kind: 'staticDerived',
        value: Number(detail.capAdjustment),
        format: 'currency0',
        note: 'Depends on the running history of prior years under the cap.',
      },
      'capAdjustment',
    );
    put(
      10,
      { kind: 'staticDerived', value: Number(detail.adminFee), format: 'currency0' },
      'adminFee',
    );
    put(
      11,
      {
        kind: 'staticDerived',
        value: Number(detail.finalRecovery),
        format: 'currency0',
        bold: true,
        note:
          'Imported for the same reason as the line before it: the sum of before-caps, cap ' +
          'adjustment and admin fee does not reproduce this for triple-net leases.',
      },
      'finalRecovery',
    );
    put(
      12,
      { kind: 'staticDerived', value: Number(detail.estimatedRecovery), format: 'currency0' },
      'estimated',
    );
    put(
      13,
      {
        kind: 'formula',
        // The true-up is what the settlement leaves over the estimate.
        formula: (refs) => `${refs.ref(`${key}.finalRecovery`)}-${refs.ref(`${key}.estimated`)}`,
        format: 'currency0',
        cachedValue: Number(detail.trueUpAmount),
      },
      'trueUp',
    );
  }
}

/** Column the annual settlement table starts at, for callers needing geometry. */
export const RECOVERY_TABLE_FIRST_COL = TOTAL_COL;

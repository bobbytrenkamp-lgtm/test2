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
 * ## The settlement is calculated, and how the rule was pinned down
 *
 * Every step below is a formula, verified against **all 102 detail rows** the
 * regression library produces:
 *
 *   share       = tenant area / denominator area
 *   entitlement = MAX(grossed-up pool x share - base year - expense stop, 0)
 *   admin fee   = entitlement x admin fee rate
 *   before caps = entitlement + admin fee
 *   final       = before caps + cap adjustment
 *   true-up     = final - estimated
 *
 * Getting here took two corrections worth recording, because the first
 * version looked right.
 *
 * **The admin fee is already inside "before caps".** The engine computes
 * `withFee = entitlement + adminFee` and reports *that* as
 * `recoveryBeforeCaps`, so adding the fee again to reach the final recovery
 * double-counts it. The first attempt did exactly that. It went unnoticed
 * because the admin fee is zero on every base-year and expense-stop fixture —
 * the error only appeared on the grocery-anchored retail rows, whose pools
 * carry a 15% fee. That is the whole of the mysterious "1.15x": not a special
 * triple-net rule, just a fee the identity had misplaced.
 *
 * **The entitlement is floored at zero.** `Decimal.max(..., ZERO)` on the
 * base-year and expense-stop branches means a pool below the stop recovers
 * nothing rather than crediting the tenant. The first version omitted the
 * floor and would have produced negative recoveries in a low-expense year.
 *
 * One method is deliberately not calculated: `fixed_amount` escalates a stated
 * amount rather than sharing a pool, and no fixture exercises it, so its rows
 * fall back to imported values rather than to a formula nothing has checked.
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
    'Entitlement',
    'Admin fee rate',
    'Admin fee',
    'Before caps',
    'Cap adjustment',
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
    /*
     * `fixed_amount` shares no pool, so the pooled formula would be wrong for
     * it. No fixture exercises that method, so rather than emit a formula
     * nothing has checked, those rows import their figures.
     */
    const pooled = detail.method !== 'fixed_amount';

    // The engine floors the entitlement at zero: a pool below the stop
    // recovers nothing rather than crediting the tenant.
    const entitlement = Math.max(
      Number(detail.grossedUpExpensePool) * Number(detail.proRataShare) -
        Number(detail.baseYearAmount) -
        Number(detail.expenseStopAmount),
      0,
    );

    put(
      8,
      pooled
        ? {
            kind: 'formula',
            formula: (refs) =>
              `MAX(${refs.ref(`${key}.grossedUpPool`)}*${refs.ref(`${key}.share`)}-` +
              `${refs.ref(`${key}.baseYear`)}-${refs.ref(`${key}.stop`)},0)`,
            format: 'currency0',
            cachedValue: entitlement,
          }
        : { kind: 'staticDerived', value: entitlement, format: 'currency0' },
      'entitlement',
    );

    // Recovered as a rate so the fee scales with the entitlement rather than
    // sitting frozen at whatever the engine happened to compute.
    put(
      9,
      {
        kind: 'input',
        value: entitlement === 0 ? 0 : Number(detail.adminFee) / entitlement,
        format: 'percent2',
      },
      'adminFeeRate',
    );

    put(
      10,
      pooled
        ? {
            kind: 'formula',
            formula: (refs) =>
              `${refs.ref(`${key}.entitlement`)}*${refs.ref(`${key}.adminFeeRate`)}`,
            format: 'currency0',
            cachedValue: Number(detail.adminFee),
          }
        : { kind: 'staticDerived', value: Number(detail.adminFee), format: 'currency0' },
      'adminFee',
    );

    put(
      11,
      pooled
        ? {
            kind: 'formula',
            // The engine reports `entitlement + adminFee` as "before caps", so
            // the fee belongs here and must not be added again below.
            formula: (refs) => `${refs.ref(`${key}.entitlement`)}+${refs.ref(`${key}.adminFee`)}`,
            format: 'currency0',
            cachedValue: Number(detail.recoveryBeforeCaps),
          }
        : {
            kind: 'staticDerived',
            value: Number(detail.recoveryBeforeCaps),
            format: 'currency0',
          },
      'beforeCaps',
    );
    put(
      12,
      {
        kind: 'staticDerived',
        value: Number(detail.capAdjustment),
        format: 'currency0',
        note: 'Depends on the running history of prior years under the cap.',
      },
      'capAdjustment',
    );
    put(
      13,
      pooled
        ? {
            kind: 'formula',
            // Cap adjustment only; the admin fee is already inside before-caps.
            formula: (refs) =>
              `${refs.ref(`${key}.beforeCaps`)}+${refs.ref(`${key}.capAdjustment`)}`,
            format: 'currency0',
            cachedValue: Number(detail.finalRecovery),
            bold: true,
          }
        : {
            kind: 'staticDerived',
            value: Number(detail.finalRecovery),
            format: 'currency0',
            bold: true,
          },
      'finalRecovery',
    );
    put(
      14,
      { kind: 'staticDerived', value: Number(detail.estimatedRecovery), format: 'currency0' },
      'estimated',
    );
    put(
      15,
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

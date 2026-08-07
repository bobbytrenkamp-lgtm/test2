import type { ModelInput, ModelResult } from '@cre/domain-models';
import type { WorkbookModel } from '../model.js';
import { LABEL_COL, scheduleColumnWidths, seriesRow } from '../layout.js';
import type { TimeAxis } from '../layout.js';

/**
 * Tenant-level detail, and the base rent the Revenue sheet adds up.
 *
 * This sheet is load-bearing rather than decorative: `Revenue!contractual base
 * rent` is a `SUM` over the rows here, so an analyst can trace a revenue figure
 * to the leases that produced it, and deleting a tenant changes the model.
 *
 * ## Only base rent is summed, and that is deliberate
 *
 * Contractual base rent is exactly the sum of the per-lease `baseRent` series
 * (checked against every fixture). Free rent, tenant improvements and leasing
 * commissions are **not**: the aggregate lines include amounts that do not
 * appear in `leaseCashFlows`, so summing these rows would silently understate
 * them. Rather than link a total that does not reconcile, those stay as the
 * engine's own aggregate lines and the per-lease figures here are shown for
 * reference only.
 *
 * Each lease's own rent is an engine value. Escalations, downtime, rollover and
 * market leasing are a per-occurrence simulation with no closed form, so
 * reproducing them in formulas would be the second engine this design avoids.
 * They are counted as coverage gaps.
 */
export function buildRentRoll(
  workbook: WorkbookModel,
  input: ModelInput,
  result: ModelResult,
  axis: TimeAxis,
): void {
  const sheet = workbook.sheet('Rent Roll', {
    freezeRows: 4,
    freezeColumns: 2,
    columnWidths: scheduleColumnWidths(axis),
  });

  sheet.at(sheet.claimRow(), LABEL_COL, {
    kind: 'header',
    value: 'Rent roll — contractual base rent by lease',
    format: 'text',
  });

  const leases = result.leaseCashFlows;

  /*
   * Keyed by row index, not by lease id.
   *
   * A lease appears more than once when the engine models its rollover: the
   * contract row, then a renewal and a new-lease row for the same `leaseId`.
   * Keying on the id collided, which the registry caught at build time rather
   * than letting two rows silently share a cell.
   */
  for (const [index, lease] of leases.entries()) {
    const contract = input.leases.find((entry) => entry.id === lease.leaseId);
    const descriptor = [
      lease.tenantName,
      contract?.spaceIds.join(', '),
      contract ? `${Number(contract.area).toLocaleString()} area` : undefined,
      lease.scenario && lease.scenario !== 'contract' ? `(${lease.scenario})` : undefined,
    ]
      .filter(Boolean)
      .join(' · ');

    seriesRow(
      sheet,
      axis,
      {
        label: descriptor || lease.leaseId,
        key: `rentRoll.base.${index}`,
        indent: 1,
        ...(contract
          ? {
              note:
                `Lease ${lease.leaseId}: ${contract.commencementDate} to ` +
                `${contract.expirationDate}, ${contract.baseRent} ${contract.baseRentBasis}.`,
            }
          : {}),
      },
      (period) => ({
        kind: 'staticDerived',
        value: Number(lease.baseRent[period] ?? '0'),
      }),
    );
  }

  seriesRow(
    sheet,
    axis,
    { label: 'Total contractual base rent', key: 'rentRoll.totalBaseRent', bold: true },
    (period) => ({
      kind: 'formula',
      formula: (refs) =>
        leases.length === 0
          ? '0'
          : leases.map((_, index) => refs.ref(`rentRoll.base.${index}`, period)).join('+'),
      cachedValue: Number(result.monthly.contractualBaseRent[period] ?? '0'),
    }),
  );
}

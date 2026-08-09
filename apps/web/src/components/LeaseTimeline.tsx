import { useMemo, useState } from 'react';
import type { CashFlowResponse } from '../api.js';
import { formatCurrency, formatMonth } from '../format.js';

/**
 * When each space is let, when it rolls, and how long it sits empty.
 *
 * An expiration report answers "what expires in 2028". It cannot answer the
 * question an analyst actually has, which is "where are the holes" — and the
 * holes are what the downtime, tenant improvement and leasing commission
 * assumptions are being applied to.
 *
 * ## Read from the calculation, not from the rent roll
 *
 * The bars come from `leaseCashFlows`, which reports each row's occupied area
 * month by month — including the rows the engine *generated*: a renewal branch,
 * a new-lease branch, a speculative lease-up. Drawing this from lease dates
 * instead would show only what is contracted and leave the forecast's own
 * leasing invisible, which is the half worth looking at.
 *
 * A weighted branch is drawn at its weight. A rollover at 70% renewal is two
 * bars, one at 70% and one at 30%, because that is what the model does — it
 * does not pick a winner, and neither should the picture.
 */

interface Band {
  from: number;
  to: number;
  /** 0–1. A probability-weighted branch is drawn at its weight. */
  weight: number;
}

interface Row {
  key: string;
  tenant: string;
  scenario: string;
  bands: Band[];
  /** Peak occupied area, for sorting the largest spaces to the top. */
  area: number;
  rent: number;
}

const HORIZONS = [
  { key: '12', label: 'Next 12 months', months: 12 },
  { key: '36', label: 'Next 3 years', months: 36 },
  { key: '60', label: 'Next 5 years', months: 60 },
  { key: 'all', label: 'All forecast', months: Number.POSITIVE_INFINITY },
] as const;

export function LeaseTimeline({
  cashFlow,
  currency,
}: {
  cashFlow: CashFlowResponse;
  currency: string;
}): JSX.Element {
  const [horizon, setHorizon] = useState<string>('36');
  const months = Math.min(
    HORIZONS.find((entry) => entry.key === horizon)?.months ?? 36,
    cashFlow.periods.length,
  );

  const rows = useMemo(() => buildRows(cashFlow, months), [cashFlow, months]);

  if (rows.length === 0) {
    return (
      <div className="message info">
        Nothing is occupied in this window, so there is no timeline to draw. That is itself worth
        knowing — check the lease dates against the forecast start.
      </div>
    );
  }

  const yearMarks = cashFlow.periods
    .slice(0, months)
    .map((period, index) => ({ index, period }))
    .filter((entry) => entry.period.month === 1 || entry.index === 0);

  return (
    <div className="timeline">
      <div className="row" style={{ marginBottom: 8 }}>
        <label className="visually-hidden" htmlFor="timeline-horizon">
          Timeline horizon
        </label>
        <select
          id="timeline-horizon"
          value={horizon}
          onChange={(event) => setHorizon(event.target.value)}
          style={{ width: 'auto' }}
        >
          {HORIZONS.map((entry) => (
            <option key={entry.key} value={entry.key}>
              {entry.label}
            </option>
          ))}
        </select>
        <span className="field-hint">
          {rows.length} occupancy row{rows.length === 1 ? '' : 's'} across {months} month
          {months === 1 ? '' : 's'}
        </span>
        <div className="spacer" />
        <span className="timeline-key">
          <span className="timeline-swatch is-contract" aria-hidden="true" /> Contract
          <span className="timeline-swatch is-renewal" aria-hidden="true" /> Renewal
          <span className="timeline-swatch is-new" aria-hidden="true" /> New lease
        </span>
      </div>

      <div className="table-scroll" tabIndex={0} style={{ maxHeight: '60vh' }}>
        <table className="timeline-table">
          <caption className="visually-hidden">
            Occupancy by lease over the next {months} months. Each row is a lease or a modelled
            rollover branch; a gap is downtime.
          </caption>
          <thead>
            <tr>
              <th scope="col">Tenant</th>
              <th scope="col" className="numeric">
                Area
              </th>
              <th scope="col">
                <span className="visually-hidden">Timeline</span>
                <span className="timeline-axis" aria-hidden="true">
                  {yearMarks.map((mark) => (
                    <span
                      key={mark.index}
                      style={{ left: `${(mark.index / months) * 100}%` }}
                      className="timeline-tick"
                    >
                      {formatMonth(mark.period.startDate)}
                    </span>
                  ))}
                </span>
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.key}>
                <th scope="row">
                  {row.tenant}
                  {row.scenario !== 'contract' && (
                    <span className="badge" style={{ marginLeft: 6 }}>
                      {row.scenario.replace('_', ' ')}
                    </span>
                  )}
                </th>
                <td className="numeric">{row.area.toLocaleString()}</td>
                <td>
                  <span className="timeline-track">
                    {row.bands.map((band, index) => (
                      <span
                        key={index}
                        className={`timeline-bar is-${row.scenario === 'contract' ? 'contract' : row.scenario === 'renewal' ? 'renewal' : 'new'}`}
                        style={{
                          left: `${(band.from / months) * 100}%`,
                          width: `${((band.to - band.from + 1) / months) * 100}%`,
                          // Opacity carries the probability weight: a rollover
                          // at 70% renewal is two bars, and drawing both solid
                          // would claim the model picked one.
                          opacity: 0.35 + band.weight * 0.65,
                        }}
                        title={
                          `${row.tenant} — ${formatMonth(cashFlow.periods[band.from]?.startDate ?? '')} to ` +
                          `${formatMonth(cashFlow.periods[band.to]?.startDate ?? '')}` +
                          (band.weight < 1 ? `, weighted ${(band.weight * 100).toFixed(0)}%` : '') +
                          (row.rent > 0
                            ? `, ${formatCurrency(String(row.rent), currency, { compact: true })} of rent in this window`
                            : '')
                        }
                      />
                    ))}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <p className="field-hint">
        Drawn from the calculation, not from the lease dates, so the engine&rsquo;s own rollover and
        speculative lease-up appear alongside signed leases. A gap between bars on the same space is
        modelled downtime. A faded bar is a probability-weighted branch drawn at its weight — the
        model does not pick a winner between renewal and re-letting, and neither does this.
      </p>
    </div>
  );
}

/**
 * Turns each lease's monthly occupied area into contiguous bands.
 *
 * The weight is the row's occupied area against the largest it ever reaches, so
 * a 70%-weighted renewal branch draws at 0.7 without this having to know
 * anything about probabilities — the engine already applied them.
 */
function buildRows(cashFlow: CashFlowResponse, months: number): Row[] {
  const rows: Row[] = [];

  for (const [index, lease] of cashFlow.leaseCashFlows.entries()) {
    const occupancy = lease.occupiedArea.slice(0, months).map(Number);
    const peak = Math.max(...occupancy, 0);
    if (peak <= 0) continue;

    const bands: Band[] = [];
    let start: number | null = null;
    let weightSum = 0;
    for (let i = 0; i < occupancy.length; i += 1) {
      const value = occupancy[i] ?? 0;
      if (value > 0) {
        if (start === null) start = i;
        weightSum += value / peak;
      } else if (start !== null) {
        bands.push({ from: start, to: i - 1, weight: weightSum / (i - start) });
        start = null;
        weightSum = 0;
      }
    }
    if (start !== null) {
      bands.push({
        from: start,
        to: occupancy.length - 1,
        weight: weightSum / (occupancy.length - start),
      });
    }
    if (bands.length === 0) continue;

    rows.push({
      key: `${lease.leaseId}-${lease.scenario ?? 'contract'}-${index}`,
      tenant: lease.tenantName,
      scenario: lease.scenario ?? 'contract',
      bands,
      area: Math.round(peak),
      rent: lease.baseRent.slice(0, months).reduce((sum, value) => sum + Number(value), 0),
    });
  }

  // Largest spaces first: the biggest hole is the one worth looking at.
  rows.sort((a, b) => b.area - a.area);
  return rows;
}

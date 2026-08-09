import { Link } from 'react-router-dom';
import { EmptyState, Loading, Metric, StatusBadge } from '../components.js';
import {
  formatCurrency,
  formatDate,
  formatMultiple,
  formatNumber,
  formatPercent,
  titleCase,
} from '../format.js';
import { useResource } from '../hooks.js';
import { useModelContext } from './ModelWorkspace.js';

/**
 * One page, built for a committee that has ten minutes and did not build the
 * model.
 *
 * Everything on it is read from what the model already produced — the same
 * cash flow the Returns tab shows, the same findings the Health tab
 * computed. Nothing is derived a second time, so this page cannot disagree
 * with the tabs it summarises; if a number looks wrong here, it is wrong
 * there too, and the fix is the same fix.
 *
 * A committee reads risk before it reads returns. The risk section leads
 * with `assessHealth`'s own warnings, each carrying the threshold it crossed,
 * because a summary that hid the reasons a reviewer would object would not
 * be a summary — it would be a pitch.
 */
export function ICSummaryTab(): JSX.Element {
  const { model, property, cashFlow, cashFlowError, calculate, calculating } = useModelContext();
  const health = useResource<HealthResponse>(cashFlow ? `/models/${model.id}/health` : null);

  if (cashFlowError) {
    return (
      <EmptyState
        title="Not calculated yet"
        action={
          <button
            type="button"
            className="primary"
            onClick={() => void calculate(true)}
            disabled={calculating}
          >
            Run the calculation
          </button>
        }
      >
        A summary is only as good as the calculation behind it, so this page waits for one rather
        than showing blanks.
      </EmptyState>
    );
  }
  if (!cashFlow) return <Loading label="Building the summary" />;

  const { returns, valuations, debtSchedules, currency, areaUnit } = cashFlow;
  const dcf = valuations.find((valuation) => valuation.method === 'dcf');
  const directCap = valuations.find((valuation) => valuation.method === 'direct_capitalization');
  const totalDebt = debtSchedules.reduce(
    (sum, schedule) => sum + Number(schedule.rows[0]?.beginningBalance ?? '0'),
    0,
  );
  const breaches = debtSchedules.flatMap((schedule) =>
    schedule.covenantBreaches.map((breach) => ({ ...breach, facility: schedule.facilityName })),
  );
  const warnings = (health.data?.findings ?? []).filter(
    (finding) => finding.severity === 'warning',
  );
  const notes = (health.data?.findings ?? []).filter((finding) => finding.severity === 'note');

  return (
    <div className="ic-summary">
      <div className="page-title ic-summary-print-hide">
        <div>
          <h1>Investment committee summary</h1>
          <p>
            Read-only. Every figure below comes from the calculation on the other tabs — nothing is
            recomputed for this page.
          </p>
        </div>
        <button type="button" onClick={() => window.print()}>
          Print
        </button>
      </div>

      <div className="card ic-summary-header">
        <h2>
          {property?.name ?? 'Property'} — {model.name}
        </h2>
        <p className="field-hint" style={{ marginTop: 0 }}>
          {property && `${titleCase(property.property_type)} · `}
          {titleCase(model.classification)} · valued {formatDate(model.valuation_date)} ·{' '}
          {model.forecast_months}-month forecast from {formatDate(model.forecast_start_date)}
          {property?.market && ` · ${property.market}`}
        </p>
        <StatusBadge status={model.status} />
      </div>

      <div className="card">
        <h2>Deal snapshot</h2>
        <dl className="metric-grid">
          <Metric
            label="Acquisition price"
            value={
              model.acquisition_price
                ? formatCurrency(model.acquisition_price, currency, { compact: true })
                : 'Not stated'
            }
          />
          <Metric
            label="Rentable area"
            value={property?.rentable_area ? formatNumber(property.rentable_area, 0) : '—'}
            note={areaUnit}
          />
          <Metric
            label="Going-in cap rate"
            value={formatPercent(returns.goingInCapRate)}
            note="Year 1 NOI over price"
          />
          <Metric label="Exit cap rate" value={formatPercent(returns.exitCapRate)} />
          <Metric
            label="Concluded value (DCF)"
            value={dcf ? formatCurrency(dcf.value, currency, { compact: true }) : 'Not modelled'}
          />
          <Metric
            label="Concluded value (direct cap)"
            value={
              directCap
                ? formatCurrency(directCap.value, currency, { compact: true })
                : 'Not modelled'
            }
          />
        </dl>
      </div>

      <div className="card">
        <h2>Returns</h2>
        <dl className="metric-grid">
          <Metric label="Unlevered IRR" value={formatPercent(returns.unleveredIrr)} />
          <Metric label="Levered IRR" value={formatPercent(returns.leveredIrr)} />
          <Metric label="Equity multiple" value={formatMultiple(returns.equityMultiple)} />
          <Metric
            label="Net present value"
            value={
              returns.netPresentValue
                ? formatCurrency(returns.netPresentValue, currency, { compact: true })
                : '—'
            }
          />
          <Metric label="Average DSCR" value={formatMultiple(returns.averageDscr)} />
          <Metric label="Minimum DSCR" value={formatMultiple(returns.minimumDscr)} />
        </dl>
      </div>

      {debtSchedules.length > 0 && (
        <div className="card">
          <h2>Debt</h2>
          <dl className="metric-grid">
            <Metric
              label="Facilities"
              value={String(debtSchedules.length)}
              note={debtSchedules.map((schedule) => schedule.facilityName).join(', ')}
            />
            <Metric
              label="Opening balance"
              value={formatCurrency(String(totalDebt), currency, { compact: true })}
            />
            <Metric label="Debt yield, year 1" value={formatPercent(returns.debtYieldYear1)} />
          </dl>
          {breaches.length > 0 && (
            <div className="message warning" style={{ marginTop: 12 }}>
              {breaches.length} covenant breach{breaches.length === 1 ? '' : 'es'} in the forecast —
              see the Returns tab for the full debt schedule.
            </div>
          )}
        </div>
      )}

      <div className="card">
        <h2>Risk</h2>
        <p className="field-hint" style={{ marginTop: 0 }}>
          Read from the Health tab's own findings — each states the threshold it crossed, so a
          reviewer can disagree with the threshold rather than with this page.
        </p>
        {health.loading && <Loading label="Assessing the model" />}
        {!health.loading && warnings.length === 0 && notes.length === 0 && (
          <div className="message info">
            Nothing crossed a threshold on the last calculation. See the Health tab for what passed.
          </div>
        )}
        {(warnings.length > 0 || notes.length > 0) && (
          <ul className="finding-list">
            {[...warnings, ...notes].slice(0, 6).map((finding) => (
              <li key={finding.id} className={`finding finding-${finding.severity}`}>
                <div className="row" style={{ alignItems: 'baseline', gap: 8 }}>
                  <span
                    className={`badge ${finding.severity === 'warning' ? 'negative' : 'warning'}`}
                  >
                    {finding.severity === 'warning' ? 'Warning' : 'Note'}
                  </span>
                  <strong>{finding.title}</strong>
                </div>
                <p>{finding.detail}</p>
              </li>
            ))}
          </ul>
        )}
        {warnings.length + notes.length > 6 && (
          <p className="field-hint ic-summary-print-hide">
            <Link to={`/models/${model.id}/health`}>
              {warnings.length + notes.length - 6} more finding
              {warnings.length + notes.length - 6 === 1 ? '' : 's'} on the Health tab
            </Link>
          </p>
        )}
      </div>

      <p className="field-hint ic-summary-print-hide">
        For the full working — monthly cash flow, the lease-by-lease detail, the debt schedule, the
        driver ranking — see the other tabs on this model.
      </p>
    </div>
  );
}

interface Finding {
  id: string;
  severity: 'warning' | 'note' | 'pass';
  title: string;
  detail: string;
}

interface HealthResponse {
  findings: Finding[];
}

import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api.js';
import { EmptyState, ErrorMessage, Loading } from '../components.js';
import { formatCurrency, formatMultiple, formatPercent } from '../format.js';
import { useMutation, useResource } from '../hooks.js';
import { useModelContext } from './ModelWorkspace.js';

/**
 * Underwriting health, and what actually moves the answer.
 *
 * Two panels that a reviewer wants before they want anything else: where the
 * risk in this model is, and which assumption is doing the most work.
 *
 * Neither shows a score. A model reduced to "72 out of 100" invites an argument
 * about the 72 and hides the four things that matter, and any weighting used to
 * produce it would be an opinion presented as a measurement. So each finding
 * states the fact, the threshold it crossed — so the reader can disagree with
 * the threshold rather than with the tool — and where to go to change it.
 */

interface Finding {
  id: string;
  severity: 'warning' | 'note' | 'pass';
  title: string;
  detail: string;
  link?: { tab: string; query?: Record<string, string> };
}

interface HealthResponse {
  findings: Finding[];
  warnings: number;
  notes: number;
  passes: number;
  calculatedAt: string;
}

interface Driver {
  key: string;
  label: string;
  change: string;
  base: string | null;
  low: string | null;
  high: string | null;
  swing: number;
  partial: boolean;
}

interface DriverResponse {
  metric: string;
  base: string | null;
  drivers: Driver[];
  runs: number;
}

const METRICS = [
  { value: 'unleveredIrr', label: 'Unlevered IRR', kind: 'percent' },
  { value: 'leveredIrr', label: 'Levered IRR', kind: 'percent' },
  { value: 'equityMultiple', label: 'Equity multiple', kind: 'multiple' },
  { value: 'netPresentValue', label: 'Net present value', kind: 'currency' },
  { value: 'year1Noi', label: 'Year 1 NOI', kind: 'currency' },
  { value: 'minimumDscr', label: 'Minimum DSCR', kind: 'multiple' },
] as const;

export function HealthTab(): JSX.Element {
  const { model, cashFlowError, calculate, calculating } = useModelContext();
  const health = useResource<HealthResponse>(`/models/${model.id}/health`);
  const [metric, setMetric] = useState<string>('unleveredIrr');
  const [drivers, setDrivers] = useState<DriverResponse | null>(null);

  const run = useMutation(async (chosen: string) => {
    const response = await api.post<DriverResponse>(`/models/${model.id}/drivers`, {
      metric: chosen,
    });
    setDrivers(response);
    return response;
  });

  if (cashFlowError || health.error?.status === 422) {
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
        Both panels here read a calculation the model has already produced — nothing is derived a
        second time, so the findings cannot disagree with the cash flow beside them.
      </EmptyState>
    );
  }

  if (health.loading) return <Loading label="Assessing the model" />;

  const findings = health.data?.findings ?? [];
  const warnings = findings.filter((finding) => finding.severity === 'warning');
  const notes = findings.filter((finding) => finding.severity === 'note');
  const passes = findings.filter((finding) => finding.severity === 'pass');

  const shape = METRICS.find((entry) => entry.value === metric) ?? METRICS[0];
  const show = (value: string | null): string => {
    if (value === null) return '—';
    if (shape.kind === 'percent') return formatPercent(value);
    if (shape.kind === 'currency') return formatCurrency(value, model.currency, { compact: true });
    return formatMultiple(value);
  };

  return (
    <>
      <ErrorMessage error={health.error} />

      <div className="card">
        <div className="row" style={{ marginBottom: 8 }}>
          <h2 style={{ margin: 0 }}>Model health</h2>
          {warnings.length > 0 && (
            <span className="badge negative">
              {warnings.length} warning{warnings.length === 1 ? '' : 's'}
            </span>
          )}
          {notes.length > 0 && <span className="badge warning">{notes.length} to note</span>}
          <span className="badge positive">{passes.length} checks passed</span>
        </div>
        <p className="field-hint" style={{ marginTop: 0 }}>
          There is deliberately no overall score. Each finding states what the model does, the
          threshold it crossed, and where to change it — so you can disagree with a threshold rather
          than with the tool. None of this is a judgement about whether the deal is good.
        </p>

        {warnings.length === 0 && notes.length === 0 ? (
          <div className="message info">
            Nothing crossed a threshold. The checks that passed are listed below.
          </div>
        ) : (
          <ul className="finding-list">
            {[...warnings, ...notes].map((finding) => (
              <FindingRow key={finding.id} finding={finding} modelId={model.id} />
            ))}
          </ul>
        )}

        <details style={{ marginTop: 12 }}>
          <summary>
            {passes.length} check{passes.length === 1 ? '' : 's'} passed
          </summary>
          <ul className="finding-list">
            {passes.map((finding) => (
              <FindingRow key={finding.id} finding={finding} modelId={model.id} />
            ))}
          </ul>
        </details>
      </div>

      <div className="card">
        <div className="row" style={{ marginBottom: 8 }}>
          <h2 style={{ margin: 0 }}>Key value drivers</h2>
          <div className="spacer" />
          <label className="visually-hidden" htmlFor="driver-metric">
            Metric to rank against
          </label>
          <select
            id="driver-metric"
            value={metric}
            onChange={(event) => {
              setMetric(event.target.value);
              setDrivers(null);
            }}
            style={{ width: 'auto' }}
          >
            {METRICS.map((entry) => (
              <option key={entry.value} value={entry.value}>
                {entry.label}
              </option>
            ))}
          </select>
          <button
            type="button"
            className="primary"
            disabled={run.pending}
            onClick={() => void run.run(metric)}
          >
            {run.pending ? 'Measuring…' : 'Measure'}
          </button>
        </div>

        <p className="field-hint" style={{ marginTop: 0 }}>
          Each assumption is moved up and down by the stated amount and the{' '}
          <strong>whole model is re-run</strong> — these relationships are not linear, and an
          approximation would be a second model. That costs two engine passes per driver, so it runs
          when you ask rather than on load.
        </p>

        <ErrorMessage error={run.error} />

        {!drivers && !run.pending && (
          <div className="message info">
            Nothing measured yet. This ranks assumptions by how far they move the metric — not by
            how uncertain they are. An exit cap rate usually tops the list because the arithmetic is
            very sensitive to it, not because anybody is unsure what it should be.
          </div>
        )}

        {drivers && (
          <>
            <div className="table-scroll" tabIndex={0}>
              <table>
                <caption className="visually-hidden">
                  Assumptions ranked by their effect on {shape.label}
                </caption>
                <thead>
                  <tr>
                    <th scope="col">Assumption</th>
                    <th scope="col">Moved by</th>
                    <th scope="col" className="numeric">
                      Lower
                    </th>
                    <th scope="col" className="numeric">
                      Base
                    </th>
                    <th scope="col" className="numeric">
                      Higher
                    </th>
                    <th scope="col" className="numeric">
                      Swing
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {drivers.drivers.map((driver) => (
                    <tr key={driver.key}>
                      <th scope="row">
                        {driver.label}
                        {driver.partial && (
                          <span className="badge warning" style={{ marginLeft: 6 }}>
                            one direction only
                          </span>
                        )}
                      </th>
                      <td>{driver.change}</td>
                      <td className="numeric">{show(driver.low)}</td>
                      <td className="numeric">{show(driver.base)}</td>
                      <td className="numeric">{show(driver.high)}</td>
                      <td className="numeric">
                        <strong>{show(String(driver.swing))}</strong>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="field-hint">
              {drivers.runs} engine run{drivers.runs === 1 ? '' : 's'} against{' '}
              {drivers.drivers.length} driver{drivers.drivers.length === 1 ? '' : 's'}. A driver the
              model has nothing to move — a debt rate with no debt — is left out rather than listed
              at zero, which would say the opposite of the truth.
            </p>
          </>
        )}
      </div>
    </>
  );
}

function FindingRow({ finding, modelId }: { finding: Finding; modelId: string }): JSX.Element {
  const tone =
    finding.severity === 'warning'
      ? 'negative'
      : finding.severity === 'note'
        ? 'warning'
        : 'positive';
  const href = finding.link
    ? `/models/${modelId}/${finding.link.tab}${
        finding.link.query ? `?${new URLSearchParams(finding.link.query).toString()}` : ''
      }`
    : null;

  return (
    <li className={`finding finding-${finding.severity}`}>
      <div className="row" style={{ alignItems: 'baseline', gap: 8 }}>
        <span className={`badge ${tone}`}>
          {finding.severity === 'pass' ? 'OK' : finding.severity === 'note' ? 'Note' : 'Warning'}
        </span>
        <strong>{finding.title}</strong>
      </div>
      <p>{finding.detail}</p>
      {href && <Link to={href}>Go to the assumption</Link>}
    </li>
  );
}

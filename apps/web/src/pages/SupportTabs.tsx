import { useState } from 'react';
import { api } from '../api.js';
import { DiagnosticList, EmptyState, ErrorMessage, Field, Loading, Metric } from '../components.js';
import { formatDateTime, formatNumber, formatPercent, isNegative, titleCase } from '../format.js';
import { useMutation, useResource } from '../hooks.js';
import { useSession } from '../session.js';
import { useModelContext } from './ModelWorkspace.js';

/** Model health: every diagnostic the engine raised on the last calculation. */
export function ValidationTab(): JSX.Element {
  const { cashFlow, cashFlowError, calculate, calculating } = useModelContext();

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
        {cashFlowError}
      </EmptyState>
    );
  }
  if (!cashFlow) return <Loading label="Loading validation findings" />;

  const occupancy = cashFlow.occupancy;
  const first = occupancy[0];
  const last = occupancy[occupancy.length - 1];

  return (
    <>
      <div className="card">
        <h2>Model health</h2>
        <DiagnosticList diagnostics={cashFlow.diagnostics} />
      </div>

      <div className="card">
        <h2>Occupancy reconciliation</h2>
        <p className="field-hint" style={{ marginTop: 0 }}>
          Occupied plus available always equals rentable area. Economic occupancy is effective gross
          revenue over revenue at full occupancy and market rent, so it captures free rent and
          credit loss as well as empty space.
        </p>
        <dl className="metric-grid">
          <div className="metric">
            <dt>Rentable area</dt>
            <dd>
              {formatNumber(first?.totalRentableArea, 0)}
              <div className="metric-note">{cashFlow.areaUnit}</div>
            </dd>
          </div>
          <div className="metric">
            <dt>Occupied, month 1</dt>
            <dd>
              {formatNumber(first?.occupiedArea, 0)}
              <div className="metric-note">
                {(Number(first?.physicalOccupancyPercent ?? 0) * 100).toFixed(1)}% physical
              </div>
            </dd>
          </div>
          <div className="metric">
            <dt>Occupied, final month</dt>
            <dd>
              {formatNumber(last?.occupiedArea, 0)}
              <div className="metric-note">
                {(Number(last?.physicalOccupancyPercent ?? 0) * 100).toFixed(1)}% physical
              </div>
            </dd>
          </div>
          <div className="metric">
            <dt>Economic occupancy, month 1</dt>
            <dd>{(Number(first?.economicOccupancyPercent ?? 0) * 100).toFixed(1)}%</dd>
          </div>
        </dl>
      </div>

      {cashFlow.recoveryDetail.length > 0 && (
        <div className="card">
          <h2>Expense recovery workings</h2>
          <div className="table-scroll" tabIndex={0} style={{ maxHeight: 420 }}>
            <table>
              <caption className="visually-hidden">
                Recovery detail by lease and fiscal year
              </caption>
              <thead>
                <tr>
                  <th scope="col">Lease</th>
                  <th scope="col">Year</th>
                  <th scope="col">Pool</th>
                  <th scope="col">Structure</th>
                  <th scope="col" className="numeric">
                    Tenant area
                  </th>
                  <th scope="col" className="numeric">
                    Denominator
                  </th>
                  <th scope="col" className="numeric">
                    Pro-rata
                  </th>
                  <th scope="col" className="numeric">
                    Expense pool
                  </th>
                  <th scope="col" className="numeric">
                    Grossed up
                  </th>
                  <th scope="col" className="numeric">
                    Base year
                  </th>
                  <th scope="col" className="numeric">
                    Stop
                  </th>
                  <th scope="col" className="numeric">
                    Admin fee
                  </th>
                  <th scope="col" className="numeric">
                    Cap adjustment
                  </th>
                  <th scope="col" className="numeric">
                    Settled
                  </th>
                  <th scope="col" className="numeric">
                    Billed as estimate
                  </th>
                  <th scope="col" className="numeric">
                    True-up
                  </th>
                  <th scope="col">Settles in</th>
                </tr>
              </thead>
              <tbody>
                {cashFlow.recoveryDetail.map((row, index) => (
                  <tr key={`${row.leaseId}-${row.poolCode}-${row.fiscalYear}-${index}`}>
                    <th scope="row">{row.leaseId}</th>
                    <td>{row.fiscalYear}</td>
                    <td>{row.poolName}</td>
                    <td>{titleCase(row.method)}</td>
                    <td className="numeric">{formatNumber(row.tenantArea, 0)}</td>
                    <td className="numeric">{formatNumber(row.denominatorArea, 0)}</td>
                    <td className="numeric">{(Number(row.proRataShare) * 100).toFixed(2)}%</td>
                    <td className="numeric">{formatNumber(row.grossExpensePool, 0)}</td>
                    <td className="numeric">{formatNumber(row.grossedUpExpensePool, 0)}</td>
                    <td className="numeric">{formatNumber(row.baseYearAmount, 0)}</td>
                    <td className="numeric">{formatNumber(row.expenseStopAmount, 0)}</td>
                    <td className="numeric">{formatNumber(row.adminFee, 0)}</td>
                    <td className="numeric">{formatNumber(row.capAdjustment, 0)}</td>
                    <td className="numeric">
                      <strong>{formatNumber(row.finalRecovery, 0)}</strong>
                    </td>
                    <td className="numeric">{formatNumber(row.estimatedRecovery, 0)}</td>
                    <td className={`numeric ${isNegative(row.trueUpAmount) ? 'negative' : ''}`}>
                      {formatNumber(row.trueUpAmount, 0)}
                    </td>
                    <td>
                      {row.trueUpPeriodIndex === null
                        ? Number(row.trueUpAmount) === 0
                          ? '-'
                          : 'Outside the forecast'
                        : `Period ${row.trueUpPeriodIndex + 1}`}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </>
  );
}

/** Reports: render in the browser, or download as CSV, spreadsheet or JSON. */
export function ReportsTab(): JSX.Element {
  const { model, cashFlowError } = useModelContext();
  const { can } = useSession();
  const reports = useResource<{
    reports: Array<{ id: string; title: string; category: string; description: string }>;
  }>('/reports');
  const [selected, setSelected] = useState<string | null>(null);

  const preview = useResource<{
    report: {
      title: string;
      description: string;
      columns: Array<{ key: string; label: string; align: string }>;
      rows: Array<Record<string, string | number | null>>;
      totals?: Record<string, string | number | null>;
      footnotes: string[];
    };
  }>(selected ? `/models/${model.id}/reports/${selected}` : null);

  if (cashFlowError) {
    return <EmptyState title="Not calculated yet">{cashFlowError}</EmptyState>;
  }

  const propertyReports =
    reports.data?.reports.filter((report) => report.category === 'property') ?? [];

  return (
    <>
      <div className="card">
        <h2>Reports</h2>
        <p className="field-hint" style={{ marginTop: 0 }}>
          Each report is one definition rendered four ways, so the screen, the CSV, the spreadsheet
          and the print view can never disagree about what it contains.
        </p>
        <ErrorMessage error={reports.error} />
        {reports.loading && <Loading label="Loading report definitions" />}
        <div className="table-scroll" tabIndex={0} style={{ maxHeight: 360 }}>
          <table>
            <caption className="visually-hidden">Available property reports</caption>
            <thead>
              <tr>
                <th scope="col">Report</th>
                <th scope="col">Description</th>
                <th scope="col">Open</th>
                <th scope="col">Download</th>
              </tr>
            </thead>
            <tbody>
              {propertyReports.map((report) => (
                <tr key={report.id}>
                  <th scope="row">{report.title}</th>
                  <td style={{ whiteSpace: 'normal', minWidth: '24rem' }}>{report.description}</td>
                  <td>
                    <button type="button" className="subtle" onClick={() => setSelected(report.id)}>
                      View
                    </button>
                  </td>
                  <td>
                    <a
                      className="button subtle"
                      href={`/api/v1/models/${model.id}/reports/${report.id}?format=csv`}
                      download
                    >
                      CSV
                    </a>
                    {can('export:run') && (
                      <a
                        className="button subtle"
                        href={`/api/v1/models/${model.id}/reports/${report.id}?format=xlsx`}
                        download
                      >
                        Excel
                      </a>
                    )}
                    <a
                      className="button subtle"
                      href={`/api/v1/models/${model.id}/reports/${report.id}?format=html`}
                      target="_blank"
                      rel="noreferrer"
                    >
                      Print
                    </a>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {can('export:run') && (
          <div className="row" style={{ marginTop: 12 }}>
            <a className="button" href={`/api/v1/models/${model.id}/export/live-model`} download>
              Excel — Live Model
            </a>
            <a className="button" href={`/api/v1/models/${model.id}/export/workbook`} download>
              Excel — values only
            </a>
            <a className="button" href={`/api/v1/models/${model.id}/export/json`} download>
              Export the model as portable JSON
            </a>
          </div>
        )}
      </div>

      {selected && (
        <div className="card">
          <ErrorMessage error={preview.error} />
          {preview.loading && <Loading label="Rendering report" />}
          {preview.data && (
            <>
              <h2>{preview.data.report.title}</h2>
              <p className="field-hint" style={{ marginTop: 0 }}>
                {preview.data.report.description}
              </p>
              <div className="table-scroll" tabIndex={0}>
                <table className="freeze-first">
                  <caption className="visually-hidden">{preview.data.report.title}</caption>
                  <thead>
                    <tr>
                      {preview.data.report.columns.map((column) => (
                        <th
                          key={column.key}
                          scope="col"
                          className={column.align === 'right' ? 'numeric' : ''}
                        >
                          {column.label}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {preview.data.report.rows.map((row, index) => (
                      <tr key={index}>
                        {preview.data?.report.columns.map((column, columnIndex) =>
                          columnIndex === 0 ? (
                            <th key={column.key} scope="row">
                              {String(row[column.key] ?? '—')}
                            </th>
                          ) : (
                            <td
                              key={column.key}
                              className={column.align === 'right' ? 'numeric' : ''}
                            >
                              {String(row[column.key] ?? '—')}
                            </td>
                          ),
                        )}
                      </tr>
                    ))}
                  </tbody>
                  {preview.data.report.totals && (
                    <tfoot>
                      <tr className="emphasis">
                        {preview.data.report.columns.map((column) => (
                          <th
                            key={column.key}
                            scope="row"
                            className={column.align === 'right' ? 'numeric' : ''}
                          >
                            {String(preview.data?.report.totals?.[column.key] ?? '')}
                          </th>
                        ))}
                      </tr>
                    </tfoot>
                  )}
                </table>
              </div>
              <ol className="field-hint">
                {preview.data.report.footnotes.map((note, index) => (
                  <li key={index}>{note}</li>
                ))}
              </ol>
            </>
          )}
        </div>
      )}
    </>
  );
}

/** Immutable versions and the approval workflow. */
export function VersionsTab(): JSX.Element {
  const { model } = useModelContext();
  const { can } = useSession();
  const versions = useResource<{
    versions: Array<{
      id: string;
      version_number: number;
      status: string;
      engine_version: string;
      label: string | null;
      created_at: string;
      approved_at: string | null;
    }>;
  }>(`/models/${model.id}/versions`);

  const [label, setLabel] = useState('');
  const [compare, setCompare] = useState<string[]>([]);
  const snapshot = useMutation(async () =>
    api.post(`/models/${model.id}/versions`, { label: label || null }),
  );

  return (
    <>
      <div className="card">
        <div className="row" style={{ marginBottom: 12 }}>
          <h2 style={{ margin: 0 }}>Versions</h2>
          <div className="spacer" />
          {can('model:write') && (
            <>
              <div style={{ width: 220 }}>
                <label htmlFor="version-label" className="visually-hidden">
                  Version label
                </label>
                <input
                  id="version-label"
                  placeholder="Label (optional)"
                  value={label}
                  onChange={(event) => setLabel(event.target.value)}
                />
              </div>
              <button
                type="button"
                disabled={snapshot.pending}
                onClick={async () => {
                  if (await snapshot.run()) {
                    setLabel('');
                    versions.reload();
                  }
                }}
              >
                {snapshot.pending ? 'Snapshotting…' : 'Snapshot now'}
              </button>
            </>
          )}
        </div>
        <ErrorMessage error={snapshot.error} />
        <ErrorMessage error={versions.error} />
        {versions.loading && <Loading label="Loading versions" />}
        {versions.data && versions.data.versions.length === 0 ? (
          <EmptyState title="No versions yet">
            A version freezes the model's engine input so a result can be reproduced exactly. One is
            created automatically on approval.
          </EmptyState>
        ) : (
          versions.data && (
            <div className="table-scroll" tabIndex={0}>
              <table>
                <caption className="visually-hidden">Immutable model versions</caption>
                <thead>
                  <tr>
                    <th scope="col">Compare</th>
                    <th scope="col">Version</th>
                    <th scope="col">Label</th>
                    <th scope="col">Status</th>
                    <th scope="col">Engine</th>
                    <th scope="col">Created</th>
                    <th scope="col">Approved</th>
                    <th scope="col">Recalculate</th>
                  </tr>
                </thead>
                <tbody>
                  {versions.data.versions.map((version) => (
                    <tr key={version.id}>
                      <td>
                        <input
                          type="checkbox"
                          aria-label={`Compare version ${version.version_number}`}
                          checked={compare.includes(version.id)}
                          onChange={(event) =>
                            setCompare((current) =>
                              event.target.checked
                                ? // Two at a time: a comparison of three has no
                                  // before and after, and the oldest selection
                                  // is the one a reader has moved on from.
                                  [...current, version.id].slice(-2)
                                : current.filter((id) => id !== version.id),
                            )
                          }
                        />
                      </td>
                      <th scope="row">v{version.version_number}</th>
                      <td>{version.label ?? '—'}</td>
                      <td>{titleCase(version.status)}</td>
                      <td>{version.engine_version}</td>
                      <td>{formatDateTime(version.created_at)}</td>
                      <td>{version.approved_at ? formatDateTime(version.approved_at) : '—'}</td>
                      <td>
                        <RecalculateButton modelId={model.id} versionId={version.id} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )
        )}
      </div>

      {compare.length === 2 && (
        <VersionComparison
          modelId={model.id}
          beforeId={compare[0] as string}
          afterId={compare[1] as string}
        />
      )}
    </>
  );
}

interface FieldChange {
  path: string;
  unit: string;
  before: string | null;
  after: string | null;
  delta: string | null;
}

interface Comparison {
  before: { version_number: number; label: string | null; engine_version: string } | null;
  after: { version_number: number; label: string | null; engine_version: string } | null;
  comparison: {
    inputChanges: Array<{
      kind: string;
      entity: string;
      code: string;
      label: string;
      fields: FieldChange[];
    }>;
    annual: Array<{
      fiscalYear: number;
      lines: Array<{
        line: string;
        before: string;
        after: string;
        delta: string;
        percentChange: string | null;
      }>;
    }>;
    headline: {
      value: { before: string; after: string; delta: string; percentChange: string | null } | null;
      netOperatingIncomeYear1: { delta: string } | null;
      unleveredIrr: FieldChange | null;
      leveredIrr: FieldChange | null;
    };
    engineChanged: boolean;
    engineBefore: string;
    engineAfter: string;
  };
}

/** How a changed field should be read, given the units it was recorded in. */
function formatChange(field: FieldChange): string {
  if (field.unit === 'rate') {
    return `${formatPercent(field.before)} → ${formatPercent(field.after)}`;
  }
  if (field.unit === 'currency') {
    return `${formatNumber(field.before, 2)} → ${formatNumber(field.after, 2)}`;
  }
  return `${field.before ?? '—'} → ${field.after ?? '—'}`;
}

/**
 * Two versions, side by side.
 *
 * Both halves are shown together on purpose: a value that moved four million
 * with no account of why is the artefact this replaces, and a diff nobody can
 * prioritise is the other one.
 */
export function VersionComparison({
  modelId,
  beforeId,
  afterId,
}: {
  modelId: string;
  beforeId: string;
  afterId: string;
}): JSX.Element {
  const result = useResource<Comparison>(
    `/models/${modelId}/versions/${beforeId}/compare/${afterId}`,
    [modelId, beforeId, afterId],
  );

  if (result.loading) return <Loading label="Comparing versions" />;
  if (result.error) {
    return (
      <div className="card">
        <ErrorMessage error={result.error} />
      </div>
    );
  }
  if (!result.data) return <></>;

  const { comparison, before, after } = result.data;

  return (
    <>
      <div className="card">
        <h2>
          v{before?.version_number} → v{after?.version_number}
        </h2>

        {comparison.engineChanged && (
          <div className="message warning" role="status" aria-label="Engine version notice">
            These versions were originally calculated by engine {comparison.engineBefore} and{' '}
            {comparison.engineAfter}. Both are recalculated here under the current engine, so this
            comparison isolates what was edited — but neither figure will match what was stored at
            the time.
          </div>
        )}

        <dl className="metric-grid">
          <Metric
            label="Value"
            value={formatNumber(comparison.headline.value?.delta, 0)}
            note="Change in the discounted cash flow"
          />
          <Metric
            label="Year 1 NOI"
            value={formatNumber(comparison.headline.netOperatingIncomeYear1?.delta, 0)}
            note="Change"
          />
          <Metric
            label="Unlevered IRR"
            value={
              comparison.headline.unleveredIrr
                ? formatChange(comparison.headline.unleveredIrr)
                : 'Unchanged'
            }
          />
          <Metric
            label="Levered IRR"
            value={
              comparison.headline.leveredIrr
                ? formatChange(comparison.headline.leveredIrr)
                : 'Unchanged'
            }
          />
        </dl>
      </div>

      <div className="card">
        <h2>What was edited</h2>
        {comparison.inputChanges.length === 0 ? (
          <EmptyState title="No input differences">
            The two versions have identical assumptions. Any difference in the figures above would
            come from the engine, not from an edit.
          </EmptyState>
        ) : (
          <div className="table-scroll" tabIndex={0} style={{ maxHeight: 360 }}>
            <table>
              <caption className="visually-hidden">Input differences between the versions</caption>
              <thead>
                <tr>
                  <th scope="col">Change</th>
                  <th scope="col">What</th>
                  <th scope="col">Field</th>
                  <th scope="col">Before and after</th>
                </tr>
              </thead>
              <tbody>
                {comparison.inputChanges.flatMap((entry) =>
                  entry.fields.length === 0
                    ? [
                        <tr key={`${entry.entity}-${entry.code}`}>
                          <td>{titleCase(entry.kind)}</td>
                          <th scope="row">
                            {titleCase(entry.entity)} {entry.code}
                          </th>
                          <td colSpan={2}>{entry.label}</td>
                        </tr>,
                      ]
                    : entry.fields.map((field, index) => (
                        <tr key={`${entry.entity}-${entry.code}-${field.path}`}>
                          <td>{index === 0 ? titleCase(entry.kind) : ''}</td>
                          <th scope="row">
                            {index === 0 ? `${titleCase(entry.entity)} ${entry.code}` : ''}
                          </th>
                          <td>{field.path.split('.').pop()}</td>
                          <td>{formatChange(field)}</td>
                        </tr>
                      )),
                )}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className="card">
        <h2>What it did, year by year</h2>
        <div className="table-scroll" tabIndex={0} style={{ maxHeight: 400 }}>
          <table>
            <caption className="visually-hidden">Annual movement between the versions</caption>
            <thead>
              <tr>
                <th scope="col">Year</th>
                {(comparison.annual[0]?.lines ?? []).map((line) => (
                  <th key={line.line} scope="col" className="numeric">
                    {titleCase(line.line.replace(/([A-Z])/g, ' $1'))}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {comparison.annual.map((year) => (
                <tr key={year.fiscalYear}>
                  <th scope="row">FY{year.fiscalYear}</th>
                  {year.lines.map((line) => (
                    <td
                      key={line.line}
                      className={`numeric ${isNegative(line.delta) ? 'negative' : ''}`}
                    >
                      {Number(line.delta) === 0 ? '—' : formatNumber(line.delta, 0)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </>
  );
}

function RecalculateButton({
  modelId,
  versionId,
}: {
  modelId: string;
  versionId: string;
}): JSX.Element {
  const [summary, setSummary] = useState<string | null>(null);
  const recalc = useMutation(async () =>
    api.post<{ engineVersion: string; annual: Array<{ lines: Record<string, string> }> }>(
      `/models/${modelId}/versions/${versionId}/recalculate`,
    ),
  );

  return (
    <>
      <button
        type="button"
        className="subtle"
        disabled={recalc.pending}
        onClick={async () => {
          const result = await recalc.run();
          if (result) {
            setSummary(
              `Engine ${result.engineVersion}: year 1 NOI ${result.annual[0]?.lines.netOperatingIncome ?? '—'}`,
            );
          }
        }}
      >
        {recalc.pending ? 'Running…' : 'Under current engine'}
      </button>
      {summary && (
        <div className="field-hint" style={{ whiteSpace: 'normal' }}>
          {summary}
        </div>
      )}
    </>
  );
}

/** Import a rent roll from a CSV: analyse, map, validate, then commit. */
/**
 * A file's bytes as base64, without blowing the stack on a large one.
 *
 * `String.fromCharCode(...bytes)` is the usual one-liner and throws on a
 * spreadsheet of any size — the spread becomes one argument per byte. Chunked
 * instead, which is the same result and survives a real rent roll.
 */
async function readAsBase64(file: File): Promise<string> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

const isWorkbookName = (name: string): boolean => /\.(xlsx|xlsm)$/i.test(name.trim());

export function ImportsTab(): JSX.Element {
  const { model, reloadCashFlow } = useModelContext();
  const [content, setContent] = useState('');
  const [filename, setFilename] = useState('');
  /**
   * Which worksheet to read.
   *
   * Held here rather than only inside the analysis, because all three steps
   * have to agree: analysing sheet 1 and committing sheet 0 would import
   * something nobody previewed, and every row of it would look plausible.
   */
  const [sheetIndex, setSheetIndex] = useState<number | undefined>(undefined);
  const [analysis, setAnalysis] = useState<{
    batchId: string;
    headers: string[];
    headerRowIndex: number;
    confidence: number;
    suggestedMapping: Record<string, number>;
    rowCount: number;
    preview: string[][];
    sheetNames: string[];
    sheetIndex: number;
  } | null>(null);
  const [mapping, setMapping] = useState<Record<string, number>>({});
  const [validation, setValidation] = useState<{
    readyToImport: boolean;
    leaseCount: number;
    issues: Array<{ rowIndex: number; severity: string; message: string; field?: string }>;
  } | null>(null);

  const analyze = useMutation(async (chosenSheet?: number) => {
    const response = await api.post<NonNullable<typeof analysis>>(
      `/models/${model.id}/imports/analyze`,
      {
        filename: filename || 'rent-roll.csv',
        content,
        ...(chosenSheet === undefined ? {} : { sheetIndex: chosenSheet }),
      },
    );
    setAnalysis(response);
    setMapping(response.suggestedMapping);
    // Adopt whichever sheet the server actually read, so a suggestion becomes
    // the explicit choice the later steps send back.
    setSheetIndex(response.sheetIndex);
    setValidation(null);
    return response;
  });

  const validate = useMutation(async () => {
    const response = await api.post<NonNullable<typeof validation>>(
      `/models/${model.id}/imports/validate`,
      { batchId: analysis?.batchId, filename, sheetIndex, content, mapping },
    );
    setValidation(response);
    return response;
  });

  const [committed, setCommitted] = useState<{ imported: number; skipped: number } | null>(null);

  const commit = useMutation(async () =>
    api.post<{ imported: number; skipped: number }>(`/models/${model.id}/imports/commit`, {
      batchId: analysis?.batchId,
      filename,
      sheetIndex,
      content,
      mapping,
      skipRowsWithErrors: true,
    }),
  );

  return (
    <div className="card">
      <h2>Import a rent roll</h2>
      <p className="field-hint" style={{ marginTop: 0 }}>
        Parsing is entirely deterministic and the file never leaves this deployment. Headers are
        located, columns are matched to fields, and every date, area and amount is normalised with
        the result shown to you before anything is written.
      </p>

      <Field label="File name">
        <input value={filename} onChange={(event) => setFilename(event.target.value)} />
      </Field>
      {isWorkbookName(filename) ? (
        // A spreadsheet's bytes are not text, so there is nothing useful to
        // show and nothing to paste. Saying what was read beats an empty box
        // or a screen of mojibake.
        <div className="message info" role="status" aria-label="Selected file">
          <strong>{filename}</strong> will be read as a spreadsheet.
          {analysis?.sheetNames.length
            ? ` It has ${analysis.sheetNames.length} sheet${analysis.sheetNames.length === 1 ? '' : 's'}.`
            : ''}
        </div>
      ) : (
        <Field
          label="CSV contents"
          hint="Paste the file, or read it in with the file picker below."
        >
          <textarea
            rows={8}
            value={content}
            spellCheck={false}
            onChange={(event) => setContent(event.target.value)}
            style={{ fontFamily: 'var(--font-mono)', fontSize: 12 }}
          />
        </Field>
      )}
      <Field
        label="Or choose a file"
        hint="CSV or Excel (.xlsx, .xlsm). The file is read in the browser and never leaves this deployment."
      >
        <input
          type="file"
          accept=".csv,text/csv,.xlsx,.xlsm,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
          onChange={async (event) => {
            const file = event.target.files?.[0];
            if (!file) return;
            setFilename(file.name);
            // A spreadsheet is binary and goes over as base64; a CSV is text
            // and goes over as itself, exactly as before.
            setContent(isWorkbookName(file.name) ? await readAsBase64(file) : await file.text());
            // A new file invalidates any sheet chosen for the previous one.
            setSheetIndex(undefined);
            setAnalysis(null);
            setValidation(null);
          }}
        />
      </Field>

      <ErrorMessage error={analyze.error} />
      <div className="row end" style={{ marginTop: 12 }}>
        <button
          type="button"
          className="primary"
          disabled={!content || analyze.pending}
          onClick={() => void analyze.run(undefined)}
        >
          {analyze.pending ? 'Analysing…' : 'Analyse the file'}
        </button>
      </div>

      {analysis && (
        <>
          {analysis.sheetNames.length > 1 && (
            /*
             * The sheet is a choice, not a guess left to the software. A rent
             * roll workbook routinely carries a cover sheet first, and the one
             * that scores highest on rent-roll words is a suggestion that can
             * be wrong — so it is shown, named, and changeable. Changing it
             * re-analyses, because the headers and mapping belong to a sheet.
             */
            <Field
              label="Worksheet"
              hint="The sheet that most looks like a rent roll is chosen; change it if that is not this one."
            >
              <select
                value={analysis.sheetIndex}
                disabled={analyze.pending}
                onChange={(event) => void analyze.run(Number(event.target.value))}
              >
                {analysis.sheetNames.map((name, index) => (
                  <option key={name} value={index}>
                    {name}
                  </option>
                ))}
              </select>
            </Field>
          )}

          <div className="message info" style={{ marginTop: 16 }}>
            Header row {analysis.headerRowIndex + 1}, {analysis.rowCount} data rows,{' '}
            {(analysis.confidence * 100).toFixed(0)}% of columns recognised.
          </div>

          <h3>Column mapping</h3>
          <div className="form-grid">
            {Object.entries(analysis.suggestedMapping).map(([field]) => (
              <Field key={field} label={titleCase(field)}>
                <select
                  value={mapping[field] ?? ''}
                  onChange={(event) => {
                    const next = { ...mapping };
                    if (event.target.value === '') delete next[field];
                    else next[field] = Number(event.target.value);
                    setMapping(next);
                  }}
                >
                  <option value="">Not mapped</option>
                  {analysis.headers.map((header, index) => (
                    <option key={index} value={index}>
                      {header || `Column ${index + 1}`}
                    </option>
                  ))}
                </select>
              </Field>
            ))}
          </div>

          <ErrorMessage error={validate.error} />
          <div className="row end">
            <button type="button" onClick={() => void validate.run()} disabled={validate.pending}>
              {validate.pending ? 'Validating…' : 'Validate'}
            </button>
          </div>
        </>
      )}

      {validation && (
        <>
          <div
            className={`message ${validation.readyToImport ? 'info' : 'warning'}`}
            style={{ marginTop: 16 }}
          >
            {validation.leaseCount} lease{validation.leaseCount === 1 ? '' : 's'} parsed.{' '}
            {validation.readyToImport
              ? 'No blocking errors.'
              : `${validation.issues.filter((i) => i.severity === 'error').length} row(s) have errors and will be skipped.`}
          </div>
          {validation.issues.length > 0 && (
            <div className="table-scroll" tabIndex={0} style={{ maxHeight: 260 }}>
              <table>
                <caption className="visually-hidden">Import findings</caption>
                <thead>
                  <tr>
                    <th scope="col">Row</th>
                    <th scope="col">Severity</th>
                    <th scope="col">Field</th>
                    <th scope="col">Finding</th>
                  </tr>
                </thead>
                <tbody>
                  {validation.issues.slice(0, 100).map((issue, index) => (
                    <tr key={index}>
                      <td>{issue.rowIndex >= 0 ? issue.rowIndex + 1 : 'File'}</td>
                      <td>
                        <span
                          className={`badge ${issue.severity === 'error' ? 'negative' : 'warning'}`}
                        >
                          {titleCase(issue.severity)}
                        </span>
                      </td>
                      <td>{issue.field ? titleCase(issue.field) : '—'}</td>
                      <td style={{ whiteSpace: 'normal', minWidth: '24rem' }}>{issue.message}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          <ErrorMessage error={commit.error} />
          <div className="row end" style={{ marginTop: 12 }}>
            <button
              type="button"
              className="primary"
              disabled={commit.pending || validation.leaseCount === 0}
              onClick={async () => {
                const result = await commit.run();
                if (result) {
                  setCommitted(result);
                  reloadCashFlow();
                }
              }}
            >
              {commit.pending ? 'Importing…' : 'Import valid rows'}
            </button>
          </div>

          {/* Writing to the rent roll without saying so would leave the analyst
              guessing whether the button worked. The count of skipped rows
              matters as much as the count written: it is the number they now
              have to go and fix by hand. */}
          {committed && (
            <div
              className="message info"
              role="status"
              aria-label="Import result"
              style={{ marginTop: 12 }}
            >
              {committed.imported} lease{committed.imported === 1 ? '' : 's'} written to the rent
              roll
              {committed.skipped > 0
                ? `, ${committed.skipped} row${committed.skipped === 1 ? '' : 's'} skipped because of the errors above.`
                : '. No rows were skipped.'}{' '}
              Recalculate to see them in the cash flow.
            </div>
          )}
        </>
      )}
    </div>
  );
}

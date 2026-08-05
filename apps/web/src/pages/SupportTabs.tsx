import { useState } from 'react';
import { api } from '../api.js';
import { DiagnosticList, EmptyState, ErrorMessage, Field, Loading } from '../components.js';
import { formatDateTime, formatNumber, titleCase } from '../format.js';
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
                    Pool
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
                    Recovery
                  </th>
                </tr>
              </thead>
              <tbody>
                {cashFlow.recoveryDetail.map((row, index) => (
                  <tr key={`${row.leaseId}-${row.fiscalYear}-${index}`}>
                    <th scope="row">{row.leaseId}</th>
                    <td>{row.fiscalYear}</td>
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
            <a className="button" href={`/api/v1/models/${model.id}/export/workbook`} download>
              Download every report as one workbook
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
  const snapshot = useMutation(async () =>
    api.post(`/models/${model.id}/versions`, { label: label || null }),
  );
  const transition = useMutation(async (to: string) =>
    api.post(`/models/${model.id}/transition`, { to }),
  );

  const NEXT: Record<string, Array<{ to: string; label: string }>> = {
    draft: [{ to: 'analyst_review', label: 'Submit for analyst review' }],
    analyst_review: [
      { to: 'manager_review', label: 'Send to manager review' },
      { to: 'draft', label: 'Return to draft' },
    ],
    manager_review: [
      { to: 'approved', label: 'Approve' },
      { to: 'draft', label: 'Reject and return to draft' },
    ],
    approved: [
      { to: 'published', label: 'Publish' },
      { to: 'draft', label: 'Withdraw approval' },
    ],
    published: [
      { to: 'superseded', label: 'Mark superseded' },
      { to: 'archived', label: 'Archive' },
    ],
    superseded: [{ to: 'archived', label: 'Archive' }],
  };

  return (
    <>
      <div className="card">
        <h2>Approval workflow</h2>
        <p className="field-hint" style={{ marginTop: 0 }}>
          Approving a model snapshots its exact engine input, so the approved numbers can be
          reproduced later even after the live model moves on. Approved and published models are
          read-only.
        </p>
        <ErrorMessage error={transition.error} />
        <div className="row">
          {(NEXT[model.status] ?? []).map((option) => (
            <button
              key={option.to}
              type="button"
              className={option.to === 'approved' || option.to === 'published' ? 'primary' : ''}
              disabled={transition.pending || !can('model:read')}
              onClick={async () => {
                if (await transition.run(option.to)) {
                  versions.reload();
                  window.location.reload();
                }
              }}
            >
              {option.label}
            </button>
          ))}
          {(NEXT[model.status] ?? []).length === 0 && (
            <span style={{ color: 'var(--text-muted)' }}>
              This model is {titleCase(model.status).toLowerCase()}; there is no further transition.
            </span>
          )}
        </div>
      </div>

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
export function ImportsTab(): JSX.Element {
  const { model, reloadCashFlow } = useModelContext();
  const [content, setContent] = useState('');
  const [filename, setFilename] = useState('');
  const [analysis, setAnalysis] = useState<{
    batchId: string;
    headers: string[];
    headerRowIndex: number;
    confidence: number;
    suggestedMapping: Record<string, number>;
    rowCount: number;
    preview: string[][];
  } | null>(null);
  const [mapping, setMapping] = useState<Record<string, number>>({});
  const [validation, setValidation] = useState<{
    readyToImport: boolean;
    leaseCount: number;
    issues: Array<{ rowIndex: number; severity: string; message: string; field?: string }>;
  } | null>(null);

  const analyze = useMutation(async () => {
    const response = await api.post<NonNullable<typeof analysis>>(
      `/models/${model.id}/imports/analyze`,
      { filename: filename || 'rent-roll.csv', content },
    );
    setAnalysis(response);
    setMapping(response.suggestedMapping);
    setValidation(null);
    return response;
  });

  const validate = useMutation(async () => {
    const response = await api.post<NonNullable<typeof validation>>(
      `/models/${model.id}/imports/validate`,
      { batchId: analysis?.batchId, content, mapping },
    );
    setValidation(response);
    return response;
  });

  const [committed, setCommitted] = useState<{ imported: number; skipped: number } | null>(null);

  const commit = useMutation(async () =>
    api.post<{ imported: number; skipped: number }>(`/models/${model.id}/imports/commit`, {
      batchId: analysis?.batchId,
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
      <Field label="CSV contents" hint="Paste the file, or read it in with the file picker below.">
        <textarea
          rows={8}
          value={content}
          spellCheck={false}
          onChange={(event) => setContent(event.target.value)}
          style={{ fontFamily: 'var(--font-mono)', fontSize: 12 }}
        />
      </Field>
      <Field label="Or choose a file" hint="The file is read in the browser and shown above first.">
        <input
          type="file"
          accept=".csv,text/csv"
          onChange={async (event) => {
            const file = event.target.files?.[0];
            if (!file) return;
            setFilename(file.name);
            setContent(await file.text());
          }}
        />
      </Field>

      <ErrorMessage error={analyze.error} />
      <div className="row end" style={{ marginTop: 12 }}>
        <button
          type="button"
          className="primary"
          disabled={!content || analyze.pending}
          onClick={() => void analyze.run()}
        >
          {analyze.pending ? 'Analysing…' : 'Analyse the file'}
        </button>
      </div>

      {analysis && (
        <>
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

import { useState } from 'react';
import { accountCategoryEnum, budgetPeriodKindEnum } from '@cre/domain-models';
import { api, type BudgetPeriod, type VarianceResponse, type VarianceRow } from '../api.js';
import { EmptyState, ErrorMessage, Field, Loading, StatusBadge } from '../components.js';
import { formatCurrency, formatPercent, titleCase } from '../format.js';
import { useMutation, useResource } from '../hooks.js';
import { useSession } from '../session.js';
import { useModelContext } from './ModelWorkspace.js';

/**
 * Budget, actuals and variance.
 *
 * A comparison always names both sides. The screen never picks a "the budget"
 * for the reader, because measuring a reforecast against the original budget
 * and against the approved budget are different questions, and quietly
 * answering the wrong one is how a board pack ends up misleading.
 */
export function BudgetsTab(): JSX.Element {
  const { model, property } = useModelContext();
  const { can } = useSession();
  const [creating, setCreating] = useState(false);
  const [baseId, setBaseId] = useState('');
  const [comparisonId, setComparisonId] = useState('');
  const [importInto, setImportInto] = useState<string | null>(null);

  const periods = useResource<{ periods: BudgetPeriod[] }>(
    property ? `/budgets?propertyId=${property.id}` : null,
  );

  const rows = periods.data?.periods ?? [];

  return (
    <>
      <div className="card">
        <div className="row" style={{ marginBottom: 12 }}>
          <h2 style={{ margin: 0 }}>Budgets and actuals</h2>
          <span className="badge">{rows.length}</span>
          <div className="spacer" />
          {can('budget:write') && (
            <button type="button" className="primary" onClick={() => setCreating((v) => !v)}>
              {creating ? 'Cancel' : 'New budget'}
            </button>
          )}
        </div>

        <p className="field-hint" style={{ marginTop: 0 }}>
          Amounts are held in the same convention as the cash flow: money in positive, money out
          negative. That is what makes a favourable variance simply a positive one, on every
          account, without the report having to know which lines are costs.
        </p>

        <ErrorMessage error={periods.error} />
        {periods.loading && <Loading label="Loading budgets" />}

        {creating && property && (
          <NewBudgetForm
            propertyId={property.id}
            modelId={model.id}
            onCreated={() => {
              setCreating(false);
              periods.reload();
            }}
          />
        )}

        {!periods.loading && rows.length === 0 && (
          <EmptyState title="No budgets yet">
            A budget holds one set of figures for a fiscal year — an original budget, an approved
            budget, or a month of actuals. Create one, then import a trial balance into it.
          </EmptyState>
        )}

        {rows.length > 0 && (
          <div className="table-scroll" tabIndex={0}>
            <table>
              <caption className="visually-hidden">Budget periods for this property</caption>
              <thead>
                <tr>
                  <th scope="col">Label</th>
                  <th scope="col">Kind</th>
                  <th scope="col" className="numeric">
                    Fiscal year
                  </th>
                  <th scope="col" className="numeric">
                    Entries
                  </th>
                  <th scope="col">Status</th>
                  <th scope="col">Actions</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((period) => (
                  <tr key={period.id}>
                    <th scope="row">{period.label}</th>
                    <td>{titleCase(period.kind)}</td>
                    <td className="numeric">{period.fiscal_year}</td>
                    <td className="numeric">{period.entry_count ?? 0}</td>
                    <td>
                      <StatusBadge status={period.approved_at ? 'approved' : 'draft'} />
                    </td>
                    <td>
                      <div className="row">
                        {can('budget:write') && !period.approved_at && (
                          <button
                            type="button"
                            className="subtle"
                            onClick={() =>
                              setImportInto(importInto === period.id ? null : period.id)
                            }
                          >
                            Import
                          </button>
                        )}
                        {can('model:approve') && !period.approved_at && (
                          <ApproveButton id={period.id} onDone={() => periods.reload()} />
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {importInto && (
        <ActualsImport
          budgetId={importInto}
          onDone={() => {
            setImportInto(null);
            periods.reload();
          }}
        />
      )}

      <div className="card">
        <h2>Variance</h2>
        <p className="field-hint" style={{ marginTop: 0 }}>
          Both sides are named explicitly. Comparing a reforecast against the original budget and
          against the approved budget are different questions.
        </p>

        <div className="form-grid">
          <Field label="Measure against (base)">
            <select value={baseId} onChange={(event) => setBaseId(event.target.value)}>
              <option value="">Select a budget…</option>
              {rows.map((period) => (
                <option key={period.id} value={period.id}>
                  {titleCase(period.kind)} {period.fiscal_year} — {period.label}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Compare" hint="Another budget period, or this model's calculated forecast.">
            <select value={comparisonId} onChange={(event) => setComparisonId(event.target.value)}>
              <option value="">Select…</option>
              <option value="__forecast__">This model&rsquo;s forecast</option>
              {rows.map((period) => (
                <option key={period.id} value={period.id}>
                  {titleCase(period.kind)} {period.fiscal_year} — {period.label}
                </option>
              ))}
            </select>
          </Field>
        </div>

        {baseId && comparisonId ? (
          <VarianceTable baseId={baseId} comparison={comparisonId} modelId={model.id} />
        ) : (
          <div className="message info">Choose both sides to see a variance.</div>
        )}
      </div>
    </>
  );
}

function ApproveButton({ id, onDone }: { id: string; onDone: () => void }): JSX.Element {
  const approve = useMutation(async () => api.post(`/budgets/${id}/approve`));
  return (
    <>
      <button
        type="button"
        className="subtle"
        disabled={approve.pending}
        onClick={async () => {
          if (await approve.run()) onDone();
        }}
        title="Approving freezes the figures. They cannot be edited afterwards."
      >
        {approve.pending ? 'Approving…' : 'Approve'}
      </button>
      <ErrorMessage error={approve.error} />
    </>
  );
}

function NewBudgetForm({
  propertyId,
  modelId,
  onCreated,
}: {
  propertyId: string;
  modelId: string;
  onCreated: () => void;
}): JSX.Element {
  const [form, setForm] = useState({
    kind: 'original_budget',
    fiscalYear: String(new Date().getFullYear() + 1),
    label: '',
    linkModel: true,
  });

  const create = useMutation(async () =>
    api.post('/budgets', {
      propertyId,
      modelId: form.linkModel ? modelId : null,
      kind: form.kind,
      fiscalYear: Number(form.fiscalYear),
      label: form.label,
    }),
  );

  return (
    <form
      className="card"
      onSubmit={async (event) => {
        event.preventDefault();
        if (await create.run()) onCreated();
      }}
    >
      <h3 style={{ marginTop: 0 }}>New budget</h3>
      <ErrorMessage error={create.error} />
      <div className="form-grid">
        <Field label="Kind">
          <select
            value={form.kind}
            onChange={(event) => setForm({ ...form, kind: event.target.value })}
          >
            {budgetPeriodKindEnum.options.map((option) => (
              <option key={option} value={option}>
                {titleCase(option)}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Fiscal year">
          <input
            inputMode="numeric"
            required
            value={form.fiscalYear}
            onChange={(event) => setForm({ ...form, fiscalYear: event.target.value })}
          />
        </Field>
        <Field label="Label" hint="How this set of figures will be referred to.">
          <input
            required
            maxLength={200}
            value={form.label}
            onChange={(event) => setForm({ ...form, label: event.target.value })}
          />
        </Field>
      </div>
      <div className="row end">
        <button type="submit" className="primary" disabled={create.pending}>
          {create.pending ? 'Creating…' : 'Create budget'}
        </button>
      </div>
    </form>
  );
}

/**
 * Trial-balance import.
 *
 * The dry run is not optional politeness: nothing is written until the analyst
 * has seen the row count, the months detected and every objection raised.
 */
function ActualsImport({
  budgetId,
  onDone,
}: {
  budgetId: string;
  onDone: () => void;
}): JSX.Element {
  const [content, setContent] = useState('');
  const [expenseSign, setExpenseSign] = useState<'positive' | 'negative'>('positive');
  const [preview, setPreview] = useState<{
    wouldWrite: number;
    months: string[];
    issues: Array<{ rowIndex: number; severity: string; message: string }>;
  } | null>(null);

  const dryRun = useMutation(async () => {
    const response = await api.post<{
      wouldWrite: number;
      months: string[];
      issues: Array<{ rowIndex: number; severity: string; message: string }>;
    }>(`/budgets/${budgetId}/import/commit`, { content, expenseSign, dryRun: true });
    setPreview(response);
    return response;
  });

  const commit = useMutation(async () =>
    api.post<{ written: number }>(`/budgets/${budgetId}/import/commit`, { content, expenseSign }),
  );

  const errors = preview?.issues.filter((issue) => issue.severity === 'error') ?? [];

  return (
    <div className="card">
      <h3 style={{ marginTop: 0 }}>Import a trial balance</h3>
      <p className="field-hint" style={{ marginTop: 0 }}>
        A month per column or a row per account per month — both are read. Parsing is local and
        deterministic; the file is never sent anywhere else.
      </p>

      <Field label="File contents" hint="Paste the export, or use the file picker below.">
        <textarea
          rows={8}
          value={content}
          spellCheck={false}
          onChange={(event) => setContent(event.target.value)}
          style={{ fontFamily: 'var(--font-mono)', fontSize: 12 }}
        />
      </Field>

      <Field label="Or choose a file" hint="Read in the browser and shown above first.">
        <input
          type="file"
          accept=".csv,text/csv"
          onChange={async (event) => {
            const file = event.target.files?.[0];
            if (file) setContent(await file.text());
          }}
        />
      </Field>

      <Field
        label="How the file states costs"
        hint="Ledgers usually write costs positive. They are stored negative so the totals add up."
      >
        <select
          value={expenseSign}
          onChange={(event) => setExpenseSign(event.target.value as 'positive' | 'negative')}
        >
          <option value="positive">Costs are positive numbers</option>
          <option value="negative">Costs are already negative</option>
        </select>
      </Field>

      <ErrorMessage error={dryRun.error} />
      <div className="row end">
        <button type="button" onClick={onDone}>
          Cancel
        </button>
        <button
          type="button"
          className="primary"
          disabled={!content || dryRun.pending}
          onClick={() => void dryRun.run()}
        >
          {dryRun.pending ? 'Checking…' : 'Check the file'}
        </button>
      </div>

      {preview && (
        <>
          <div
            className={`message ${errors.length > 0 ? 'warning' : 'info'}`}
            style={{ marginTop: 16 }}
            role="status"
          >
            {preview.wouldWrite} entries would be written across {preview.months.length} month
            {preview.months.length === 1 ? '' : 's'}
            {errors.length > 0 ? `, and ${errors.length} row(s) will be skipped.` : '.'}
          </div>

          {preview.issues.length > 0 && (
            <div className="table-scroll" tabIndex={0} style={{ maxHeight: 240 }}>
              <table>
                <caption className="visually-hidden">Import findings</caption>
                <thead>
                  <tr>
                    <th scope="col">Row</th>
                    <th scope="col">Severity</th>
                    <th scope="col">Finding</th>
                  </tr>
                </thead>
                <tbody>
                  {preview.issues.slice(0, 100).map((issue, index) => (
                    <tr key={index}>
                      <td>{issue.rowIndex >= 0 ? issue.rowIndex + 1 : 'File'}</td>
                      <td>
                        <span
                          className={`badge ${issue.severity === 'error' ? 'negative' : 'warning'}`}
                        >
                          {titleCase(issue.severity)}
                        </span>
                      </td>
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
              disabled={commit.pending || preview.wouldWrite === 0}
              onClick={async () => {
                if (await commit.run()) onDone();
              }}
            >
              {commit.pending ? 'Importing…' : `Import ${preview.wouldWrite} entries`}
            </button>
          </div>
        </>
      )}
    </div>
  );
}

function designationTone(designation: VarianceRow['designation']): string {
  if (designation === 'favourable') return 'positive';
  if (designation === 'unfavourable') return 'negative';
  return '';
}

function VarianceTable({
  baseId,
  comparison,
  modelId,
}: {
  baseId: string;
  comparison: string;
  modelId: string;
}): JSX.Element {
  const query =
    comparison === '__forecast__'
      ? `baseId=${baseId}&comparisonModelId=${modelId}`
      : `baseId=${baseId}&comparisonId=${comparison}`;

  const variance = useResource<VarianceResponse>(`/variance?${query}`, [baseId, comparison]);

  if (variance.loading) return <Loading label="Computing the variance" />;
  if (variance.error) return <ErrorMessage error={variance.error} />;
  if (!variance.data) return <div className="message info">No variance to show.</div>;

  const { report, base, comparison: against } = variance.data;

  return (
    <>
      <div className="message info" style={{ marginTop: 12 }}>
        <strong>{against.label}</strong> measured against <strong>{base.label}</strong>
        {report.fromMonth ? `, ${report.fromMonth} to ${report.toMonth}` : ''}.
      </div>

      {report.unmatchedAccounts.length > 0 && (
        <div className="message warning">
          {report.unmatchedAccounts.length} account
          {report.unmatchedAccounts.length === 1 ? '' : 's'} appear on one side only (
          {report.unmatchedAccounts.slice(0, 6).join(', ')}
          {report.unmatchedAccounts.length > 6 ? '…' : ''}). That is more often a mapping mistake
          than a genuine new line.
        </div>
      )}

      <div className="table-scroll" tabIndex={0}>
        <table>
          <caption className="visually-hidden">
            Variance by account. Favourable amounts are positive.
          </caption>
          <thead>
            <tr>
              <th scope="col">Account</th>
              <th scope="col" className="numeric">
                Base
              </th>
              <th scope="col" className="numeric">
                Comparison
              </th>
              <th scope="col" className="numeric">
                Variance
              </th>
              <th scope="col" className="numeric">
                %
              </th>
              <th scope="col">Reading</th>
            </tr>
          </thead>
          <tbody>
            {report.rows.map((row) => (
              <tr key={row.accountCode}>
                <th scope="row">
                  {row.accountCode} · {row.accountName}
                  <div style={{ color: 'var(--text-muted)', fontWeight: 400, fontSize: 12 }}>
                    {titleCase(row.category)}
                  </div>
                </th>
                <td className="numeric">{formatCurrency(row.base, 'USD')}</td>
                <td className="numeric">{formatCurrency(row.comparison, 'USD')}</td>
                <td className={`numeric ${row.variance.startsWith('-') ? 'negative' : ''}`}>
                  {formatCurrency(row.variance, 'USD')}
                </td>
                <td className="numeric">
                  {row.variancePercent === null ? '—' : formatPercent(row.variancePercent, 1)}
                </td>
                <td>
                  <span className={`badge ${designationTone(row.designation)}`}>
                    {titleCase(row.designation)}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr className="emphasis">
              <th scope="row">Net</th>
              <td className="numeric">{formatCurrency(report.totalBase, 'USD')}</td>
              <td className="numeric">{formatCurrency(report.totalComparison, 'USD')}</td>
              <td className={`numeric ${report.totalVariance.startsWith('-') ? 'negative' : ''}`}>
                {formatCurrency(report.totalVariance, 'USD')}
              </td>
              <td className="numeric">
                {report.totalVariancePercent === null
                  ? '—'
                  : formatPercent(report.totalVariancePercent, 1)}
              </td>
              <td>
                <span className={`badge ${designationTone(report.totalDesignation)}`}>
                  {titleCase(report.totalDesignation)}
                </span>
              </td>
            </tr>
          </tfoot>
        </table>
      </div>

      <p className="field-hint">
        Categories shown for grouping only. A row&rsquo;s reading comes from the sign of its
        variance, so a miscategorised account lands in the wrong subtotal rather than reversing its
        own result. Available categories: {accountCategoryEnum.options.map(titleCase).join(', ')}.
      </p>
    </>
  );
}

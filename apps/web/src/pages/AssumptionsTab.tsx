import { useMemo, useState } from 'react';
import { api, type Model } from '../api.js';
import { EditableGrid } from '../grid/EditableGrid.js';
import {
  assumptionColumns,
  withPendingAssumption,
  type AssumptionRow,
} from './assumption-columns.js';
import { RecordEditor } from './record-editors/RecordEditor.js';
import { RECORD_SPECS } from './record-editors/specs.js';
import type { RecordValues } from './record-editors/spec.js';
import { EmptyState, ErrorMessage, Field, Loading } from '../components.js';
import { formatPercent, titleCase } from '../format.js';
import { useMutation, useResource, useUnsavedChangesWarning } from '../hooks.js';
import { useSession } from '../session.js';
import { useModelContext } from './ModelWorkspace.js';

interface GrowthCurveTemplate {
  code: string;
  name: string;
  default_rate: string;
  by_year: Array<{ year: number; rate: string }>;
}

/**
 * Model assumptions: the valuation inputs, the vacancy allowances, and the
 * model-scoped collections (expenses, other revenue, capital, debt, growth
 * curves and market leasing profiles).
 */
export function AssumptionsTab(): JSX.Element {
  const { model, reloadCashFlow } = useModelContext();
  const { can } = useSession();
  const editable =
    can('model:write') &&
    !['approved', 'published', 'superseded', 'archived'].includes(model.status);

  return (
    <>
      {!editable && (
        <div className="message info">
          This model is {titleCase(model.status).toLowerCase()}. Its assumptions are frozen so the
          approved figures stay reproducible. Clone the model to keep working.
        </div>
      )}

      <ValuationAssumptions editable={editable} onSaved={reloadCashFlow} />

      <Collection
        title="Operating expenses"
        segment="expenses"
        editable={editable}
        onSaved={reloadCashFlow}
        columns={[
          { key: 'code', label: 'Code' },
          { key: 'name', label: 'Name' },
          { key: 'category', label: 'Category' },
          { key: 'method', label: 'Method', transform: titleCase },
          { key: 'amount', label: 'Amount', numeric: true },
          { key: 'growth_curve', label: 'Growth curve' },
          { key: 'recoverable_share', label: 'Recoverable', numeric: true, percent: true },
          { key: 'variable_share', label: 'Occupancy variable', numeric: true, percent: true },
        ]}
        description="Expenses defined as a percentage of effective gross revenue are solved together with recoveries, because a recoverable management fee feeds the revenue it is charged on."
      />

      <Collection
        title="Other property revenue"
        segment="other-revenue"
        editable={editable}
        onSaved={reloadCashFlow}
        columns={[
          { key: 'code', label: 'Code' },
          { key: 'name', label: 'Name' },
          { key: 'category', label: 'Category' },
          { key: 'method', label: 'Method', transform: titleCase },
          { key: 'amount', label: 'Amount', numeric: true },
          { key: 'vary_with_occupancy', label: 'Varies with occupancy' },
        ]}
        description="Parking, storage, signage, antenna licences and other income that is not attached to a lease."
      />

      <Collection
        title="Capital"
        segment="capital"
        editable={editable}
        onSaved={reloadCashFlow}
        columns={[
          { key: 'code', label: 'Code' },
          { key: 'name', label: 'Name' },
          { key: 'category', label: 'Category', transform: titleCase },
          { key: 'method', label: 'Method', transform: titleCase },
          { key: 'amount', label: 'Amount', numeric: true },
          { key: 'start_date', label: 'Start' },
          { key: 'end_date', label: 'End' },
        ]}
        description="Recurring capital, reserves, major projects and development costs. Capital sits below net operating income."
      />

      <Collection
        title="Debt facilities"
        segment="debt"
        editable={editable}
        onSaved={reloadCashFlow}
        columns={[
          { key: 'code', label: 'Code' },
          { key: 'name', label: 'Name' },
          { key: 'type', label: 'Type', transform: titleCase },
          { key: 'commitment', label: 'Commitment', numeric: true },
          { key: 'funding_date', label: 'Funds' },
          { key: 'rate_type', label: 'Rate type', transform: titleCase },
          { key: 'fixed_rate', label: 'Fixed rate', numeric: true, percent: true },
          { key: 'spread', label: 'Spread', numeric: true, percent: true },
          { key: 'interest_only_months', label: 'IO months', numeric: true },
          { key: 'amortization_months', label: 'Amort. months', numeric: true },
          { key: 'term_months', label: 'Term', numeric: true },
        ]}
        description="Several facilities can run at once. A facility that matures before the modelled sale is flagged in validation."
      />

      <Collection
        title="Market leasing assumptions"
        segment="market-leasing"
        editable={editable}
        onSaved={reloadCashFlow}
        columns={[
          { key: 'code', label: 'Code' },
          { key: 'name', label: 'Name' },
          { key: 'market_rent', label: 'Market rent', numeric: true },
          {
            key: 'renewal_probability',
            label: 'Renewal probability',
            numeric: true,
            percent: true,
          },
          { key: 'downtime_months', label: 'Downtime', numeric: true },
          { key: 'new_free_rent_months', label: 'New free rent', numeric: true },
          { key: 'new_ti_per_area', label: 'New TI', numeric: true },
          { key: 'renewal_ti_per_area', label: 'Renewal TI', numeric: true },
          { key: 'precedence', label: 'Precedence', numeric: true },
        ]}
        description="Rollover is modelled probability-weighted: a renewal branch at the renewal probability and a new-lease branch at its complement, with downtime applied only to the new-lease branch. Precedence resolves overlaps; the winner is recorded in the trace."
      />

      <Collection
        title="Growth curves"
        segment="growth-curves"
        editable={editable}
        onSaved={reloadCashFlow}
        columns={[
          { key: 'code', label: 'Code' },
          { key: 'name', label: 'Name' },
          { key: 'default_rate', label: 'Default rate', numeric: true, percent: true },
          {
            key: 'source_template_name',
            label: 'Source',
            transform: (value) => `Library: ${value}`,
          },
        ]}
        description="Named annual rates used for inflation, market rent growth, tenant sales and floating-rate index paths. Year one carries a factor of 1.0; growth compounds from year two."
      />
    </>
  );
}

function ValuationAssumptions({
  editable,
  onSaved,
}: {
  editable: boolean;
  onSaved: () => void;
}): JSX.Element {
  const { model, updateModel } = useModelContext();
  const [form, setForm] = useState({
    discountRate: model.discount_rate ?? '',
    discountingConvention: model.discounting_convention,
    terminalCapRate: model.terminal_cap_rate ?? '',
    terminalNoiBasis: model.terminal_noi_basis,
    saleMonth: model.sale_month ? String(model.sale_month) : '',
    saleCostPercent: model.sale_cost_percent,
    directCapRate: model.direct_cap_rate ?? '',
    acquisitionPrice: model.acquisition_price ?? '',
    acquisitionCosts: model.acquisition_costs,
    generalVacancyRate: model.general_vacancy_rate,
    creditLossRate: model.credit_loss_rate,
  });
  const [dirty, setDirty] = useState(false);
  useUnsavedChangesWarning(dirty);

  const save = useMutation(async () =>
    api.patch<{ model: Model }>(`/models/${model.id}`, {
      // The version this tab opened. If someone else has changed an assumption
      // since, the server refuses rather than writing over a figure this screen
      // never showed.
      expectedVersion: model.version,
      discountRate: form.discountRate || null,
      discountingConvention: form.discountingConvention,
      terminalCapRate: form.terminalCapRate || null,
      terminalNoiBasis: form.terminalNoiBasis,
      saleMonth: form.saleMonth ? Number(form.saleMonth) : null,
      saleCostPercent: form.saleCostPercent,
      directCapRate: form.directCapRate || null,
      acquisitionPrice: form.acquisitionPrice || null,
      acquisitionCosts: form.acquisitionCosts,
      generalVacancyRate: form.generalVacancyRate,
      creditLossRate: form.creditLossRate,
    }),
  );

  const set = (key: keyof typeof form, value: string): void => {
    setDirty(true);
    setForm((current) => ({ ...current, [key]: value }));
  };

  const forwardNoiWarning =
    form.terminalNoiBasis === 'forward_12' &&
    form.saleMonth &&
    model.forecast_months - Number(form.saleMonth) < 12
      ? `A forward twelve-month terminal NOI needs 12 forecast months after the sale. This forecast has ${model.forecast_months - Number(form.saleMonth)}.`
      : undefined;

  async function submit(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    const result = await save.run();
    if (result) {
      setDirty(false);
      // Folds the save's own response back in, in particular the version
      // it just incremented — without this, a second save in the same visit
      // sends the version this tab opened with, one behind what its own
      // first save just produced, and is refused as a conflict with a
      // phantom other editor. See `ModelContext.updateModel`'s own comment
      // for why this isn't just `reloadModel()`.
      updateModel(result.model);
      onSaved();
    }
  }

  return (
    <form className="card" onSubmit={submit}>
      <h2>Valuation and vacancy assumptions</h2>
      <ErrorMessage error={save.error} />
      <fieldset disabled={!editable} style={{ border: 'none', padding: 0, margin: 0 }}>
        <div className="form-grid">
          <Field
            label="Discount rate"
            hint={`Annual effective rate. Currently ${formatPercent(form.discountRate)}.`}
          >
            <input
              inputMode="decimal"
              value={form.discountRate}
              onChange={(event) => set('discountRate', event.target.value)}
            />
          </Field>
          <Field label="Discounting convention">
            <select
              value={form.discountingConvention}
              onChange={(event) => set('discountingConvention', event.target.value)}
            >
              <option value="end_of_period">End of period</option>
              <option value="mid_period">Mid period</option>
            </select>
          </Field>
          <Field
            label="Exit capitalization rate"
            hint={`Currently ${formatPercent(form.terminalCapRate)}.`}
          >
            <input
              inputMode="decimal"
              value={form.terminalCapRate}
              onChange={(event) => set('terminalCapRate', event.target.value)}
            />
          </Field>
          <Field label="Terminal NOI basis" error={forwardNoiWarning}>
            <select
              value={form.terminalNoiBasis}
              onChange={(event) => set('terminalNoiBasis', event.target.value)}
              aria-invalid={forwardNoiWarning ? 'true' : undefined}
            >
              <option value="forward_12">Forward twelve months</option>
              <option value="trailing_12">Trailing twelve months</option>
            </select>
          </Field>
          <Field label="Sale month" hint={`Within the ${model.forecast_months}-month forecast.`}>
            <input
              inputMode="numeric"
              value={form.saleMonth}
              onChange={(event) => set('saleMonth', event.target.value)}
            />
          </Field>
          <Field label="Costs of sale" hint={`Currently ${formatPercent(form.saleCostPercent)}.`}>
            <input
              inputMode="decimal"
              value={form.saleCostPercent}
              onChange={(event) => set('saleCostPercent', event.target.value)}
            />
          </Field>
          <Field label="Direct capitalization rate" hint="Optional second valuation method.">
            <input
              inputMode="decimal"
              value={form.directCapRate}
              onChange={(event) => set('directCapRate', event.target.value)}
            />
          </Field>
          <Field label="Acquisition price" hint="Drives the going-in yield and both IRRs.">
            <input
              inputMode="decimal"
              value={form.acquisitionPrice}
              onChange={(event) => set('acquisitionPrice', event.target.value)}
            />
          </Field>
          <Field label="Acquisition costs">
            <input
              inputMode="decimal"
              value={form.acquisitionCosts}
              onChange={(event) => set('acquisitionCosts', event.target.value)}
            />
          </Field>
          <Field
            label="General vacancy"
            hint="Netted against the absorption and turnover vacancy already modelled lease by lease, so the same vacancy is never deducted twice."
          >
            <input
              inputMode="decimal"
              value={form.generalVacancyRate}
              onChange={(event) => set('generalVacancyRate', event.target.value)}
            />
          </Field>
          <Field label="Credit loss">
            <input
              inputMode="decimal"
              value={form.creditLossRate}
              onChange={(event) => set('creditLossRate', event.target.value)}
            />
          </Field>
        </div>
        <div className="row end">
          <button type="submit" className="primary" disabled={save.pending || !dirty}>
            {save.pending ? 'Saving…' : dirty ? 'Save assumptions' : 'No changes'}
          </button>
        </div>
      </fieldset>
    </form>
  );
}

interface ColumnSpec {
  key: string;
  label: string;
  numeric?: boolean;
  percent?: boolean;
  transform?: (value: string) => string;
}

/**
 * A model-scoped assumption collection. Rows are read here and edited as JSON
 * so every field the API accepts is reachable, while the common fields stay
 * legible in the table above.
 */
function Collection({
  title,
  segment,
  columns,
  description,
  editable,
  onSaved,
}: {
  title: string;
  segment: string;
  columns: ColumnSpec[];
  description: string;
  editable: boolean;
  onSaved: () => void;
}): JSX.Element {
  const { model } = useModelContext();
  const { session } = useSession();
  const resource = useResource<{ items: AssumptionRow[] }>(`/models/${model.id}/${segment}`);
  const gridColumns = useMemo(
    () => assumptionColumns(segment, { currency: model.currency, areaUnit: model.area_unit }),
    [segment, model.currency, model.area_unit],
  );
  /*
   * The organization's growth curve library (see
   * `apps/api/src/routes/growth-curve-templates.ts`). Fetched only for this
   * one segment — every other collection has no library to offer, and
   * fetching one anyway would be a request nothing on screen uses.
   */
  const isGrowthCurves = segment === 'growth-curves';
  const templates = useResource<{ templates: GrowthCurveTemplate[] }>(
    isGrowthCurves && editable && session?.organizationId
      ? `/organizations/${session.organizationId}/growth-curve-templates`
      : null,
  );
  const [focused, setFocused] = useState<AssumptionRow | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  /*
   * The record the structured editor opened, camelCased and stripped of the
   * columns nobody edits. Held apart from the JSON draft so switching between
   * the two views does not lose what has been typed into the other.
   */
  const [editingRecord, setEditingRecord] = useState<RecordValues | null>(null);
  const [rawJson, setRawJson] = useState(false);
  const recordSpec = RECORD_SPECS[segment] ?? null;
  const [draft, setDraft] = useState('');
  const [parseError, setParseError] = useState<string | null>(null);
  // Held outside the draft because it is not something anyone edits: it is the
  // row as this screen last saw it, and the server refuses the write if it has
  // moved on since.
  const [openedVersion, setOpenedVersion] = useState<number | null>(null);

  const save = useMutation(async (code: string, body: Record<string, unknown>) =>
    api.put(`/models/${model.id}/${segment}/${encodeURIComponent(code)}`, body),
  );
  const remove = useMutation(async (code: string) =>
    api.delete(`/models/${model.id}/${segment}/${encodeURIComponent(code)}`),
  );

  function beginEdit(row: Record<string, unknown> | null): void {
    setParseError(null);
    setRawJson(false);
    if (row) {
      const {
        id: _id,
        model_id: _modelId,
        created_at: _createdAt,
        updated_at: _updatedAt,
        version,
        ...rest
      } = row as Record<string, unknown>;
      const camel = toCamel(rest);
      setEditing(String(row.code));
      setOpenedVersion(typeof version === 'number' ? version : null);
      setEditingRecord(camel);
      setDraft(JSON.stringify(camel, null, 2));
    } else {
      setEditing('');
      setOpenedVersion(null);
      setEditingRecord(null);
      setDraft(JSON.stringify({ code: '', name: '' }, null, 2));
    }
  }

  /*
   * Seeds a new growth curve from a library entry. Not a live reference: this
   * only fills the draft the same "Add" would open blank, so the result is a
   * normal new row the analyst still reviews and saves — editing the library
   * entry afterward does not reach back into any model that started from it.
   *
   * sourceTemplateCode/sourceTemplateName travel with the draft and land on
   * the saved row (see `upsertGrowthCurve`), so the model keeps a record of
   * where the curve started even though it now owns its own copy — a
   * snapshot of "what this was called when applied," not a pointer to the
   * template, which can be renamed or deleted afterward without effect.
   */
  function beginFromTemplate(template: GrowthCurveTemplate): void {
    setParseError(null);
    setRawJson(false);
    setEditing('');
    setOpenedVersion(null);
    setEditingRecord(null);
    setDraft(
      JSON.stringify(
        {
          code: template.code,
          name: template.name,
          defaultRate: template.default_rate,
          byYear: template.by_year,
          sourceTemplateCode: template.code,
          sourceTemplateName: template.name,
        },
        null,
        2,
      ),
    );
  }

  async function submit(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    let body: Record<string, unknown>;
    try {
      body = JSON.parse(draft) as Record<string, unknown>;
    } catch {
      setParseError('That is not valid JSON. Check for a missing comma or quote.');
      return;
    }
    const code = String(body.code ?? editing ?? '');
    if (!code) {
      setParseError(
        'A "code" is required. It is the stable identifier used in traces and reports.',
      );
      return;
    }
    // The version this editor opened. Null on a new row, which cannot have been
    // changed by anyone.
    if (await save.run(code, { ...body, expectedVersion: openedVersion })) {
      setEditing(null);
      resource.reload();
      onSaved();
    }
  }

  return (
    <div className="card">
      <div className="row" style={{ marginBottom: 8 }}>
        <h2 style={{ margin: 0 }}>{title}</h2>
        <span className="badge">{resource.data?.items.length ?? 0}</span>
        <div className="spacer" />
        {isGrowthCurves && editable && (templates.data?.templates.length ?? 0) > 0 && (
          <>
            <label htmlFor="growth-curve-template" className="visually-hidden">
              Start a new growth curve from the organization's library
            </label>
            <select
              id="growth-curve-template"
              value=""
              onChange={(event) => {
                const template = templates.data?.templates.find(
                  (entry) => entry.code === event.target.value,
                );
                if (template) beginFromTemplate(template);
              }}
            >
              <option value="">Start from library…</option>
              {templates.data?.templates.map((template) => (
                <option key={template.code} value={template.code}>
                  {template.name}
                </option>
              ))}
            </select>
          </>
        )}
        {editable && (
          <button type="button" onClick={() => beginEdit(null)}>
            Add
          </button>
        )}
      </div>
      <p className="field-hint" style={{ marginTop: 0 }}>
        {description}
      </p>

      <ErrorMessage error={resource.error} />
      {resource.loading && <Loading label={`Loading ${title.toLowerCase()}`} />}

      {resource.data && resource.data.items.length === 0 ? (
        <EmptyState
          title={`No ${title.toLowerCase()} yet`}
          action={
            editable ? (
              <button type="button" className="primary" onClick={() => beginEdit(null)}>
                Add the first one
              </button>
            ) : undefined
          }
        >
          The engine treats this collection as empty rather than assuming a default, so nothing here
          contributes to the cash flow until something is defined.
        </EmptyState>
      ) : (
        resource.data &&
        (gridColumns ? (
          <EditableGrid
            rows={resource.data.items}
            columns={gridColumns}
            rowId={(row) => String(row.code)}
            merge={withPendingAssumption}
            editable={editable}
            label={title}
            preferenceKey={`${segment}.${model.id}`}
            onFocusedRowChange={setFocused}
            onSaved={() => {
              resource.reload();
              onSaved();
            }}
            save={async (changes) => {
              const byCode = new Map(
                (resource.data?.items ?? []).map((row) => [String(row.code), row]),
              );
              await api.patch(`/models/${model.id}/${segment}`, {
                changes: changes.map((change) => ({
                  code: change.rowId,
                  expectedVersion:
                    (byCode.get(change.rowId)?.version as number | undefined) ?? null,
                  fields: coerceFields(change.fields),
                })),
              });
            }}
            toolbar={
              editable ? (
                <button
                  type="button"
                  className="subtle"
                  disabled={!focused}
                  onClick={() => focused && beginEdit(focused)}
                  title="Schedules, structures and anything else a single cell cannot hold"
                >
                  {focused ? `Edit ${String(focused.code)} in full` : 'Edit in full'}
                </button>
              ) : undefined
            }
          />
        ) : (
          /* Growth curves: a per-year rate list is not a cell, so this stays a
             reading surface and the record editor does the writing. */
          <div className="table-scroll" tabIndex={0} style={{ maxHeight: 340 }}>
            <table>
              <caption className="visually-hidden">{title}</caption>
              <thead>
                <tr>
                  {columns.map((column) => (
                    <th key={column.key} scope="col" className={column.numeric ? 'numeric' : ''}>
                      {column.label}
                    </th>
                  ))}
                  {editable && <th scope="col">Actions</th>}
                </tr>
              </thead>
              <tbody>
                {resource.data.items.map((row) => (
                  <tr key={String(row.id ?? row.code)}>
                    {columns.map((column, index) => {
                      const raw = row[column.key];
                      const text =
                        raw === null || raw === undefined || raw === ''
                          ? '—'
                          : typeof raw === 'boolean'
                            ? raw
                              ? 'Yes'
                              : 'No'
                            : column.percent
                              ? formatPercent(String(raw))
                              : column.transform
                                ? column.transform(String(raw))
                                : String(raw).slice(0, 40);
                      return index === 0 ? (
                        <th key={column.key} scope="row">
                          {text}
                        </th>
                      ) : (
                        <td key={column.key} className={column.numeric ? 'numeric' : ''}>
                          {text}
                        </td>
                      );
                    })}
                    {editable && (
                      <td>
                        <button type="button" className="subtle" onClick={() => beginEdit(row)}>
                          Edit
                        </button>
                        <button
                          type="button"
                          className="subtle"
                          onClick={async () => {
                            if (await remove.run(String(row.code))) {
                              resource.reload();
                              onSaved();
                            }
                          }}
                        >
                          Delete
                        </button>
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ))
      )}

      {editing !== null &&
        (recordSpec && !rawJson ? (
          <RecordEditor
            spec={recordSpec}
            initial={editingRecord}
            expectedVersion={openedVersion}
            saving={save.pending}
            error={save.error}
            onCancel={() => setEditing(null)}
            onSave={async (values) => {
              const code = String(values.code ?? '');
              if (!code) {
                setParseError('A code is required.');
                return;
              }
              if (await save.run(code, values)) {
                setEditing(null);
                resource.reload();
                onSaved();
              }
            }}
          />
        ) : (
          <form onSubmit={submit} style={{ marginTop: 12 }}>
            {save.error?.status === 409 ? (
              <div className="message error" role="alert">
                <strong>{save.error.message}</strong>
                <p style={{ marginBottom: 0 }}>
                  Nothing has been saved. Cancel and reopen the row to see their change, then
                  reapply yours. Saving over them would discard work you cannot see from here.
                </p>
              </div>
            ) : (
              <ErrorMessage error={save.error} />
            )}
            <Field
              label={editing ? `Edit ${editing}` : `New ${title.toLowerCase().replace(/s$/, '')}`}
              error={parseError ?? undefined}
              hint="Field names use camelCase, matching the API. Amounts and rates are decimal strings."
            >
              <textarea
                rows={12}
                value={draft}
                spellCheck={false}
                onChange={(event) => setDraft(event.target.value)}
                style={{ fontFamily: 'var(--font-mono)', fontSize: 12 }}
              />
            </Field>
            <div className="row end">
              {recordSpec && (
                <button type="button" className="subtle" onClick={() => setRawJson(false)}>
                  Back to the form
                </button>
              )}
              <button type="button" onClick={() => setEditing(null)}>
                Cancel
              </button>
              <button type="submit" className="primary" disabled={save.pending}>
                {save.pending ? 'Saving…' : 'Save'}
              </button>
            </div>
          </form>
        ))}

      {/*
       * The JSON view is kept, behind a control, rather than deleted.
       *
       * A structured form can only offer the fields somebody thought to put in
       * the spec. When a collection grows a field the spec has not caught up
       * with, or when somebody is debugging what the API actually stored, the
       * raw record is the only way to see it — and taking that away would make
       * the product less capable than the thing it replaced.
       */}
      {editing !== null && recordSpec && !rawJson && (
        <p className="field-hint" style={{ marginTop: 8 }}>
          <button type="button" className="subtle" onClick={() => setRawJson(true)}>
            Edit the raw record instead
          </button>{' '}
          — every stored field, including any this form does not show.
        </p>
      )}
    </div>
  );
}

/**
 * The grid holds every value as a string; the write API wants a boolean where
 * the column is one.
 *
 * Numbers are deliberately *left* as strings. Every amount and rate in this
 * system is a decimal string end to end precisely so that 1234.55 is not stored
 * as 1234.5499999999999, and a round trip through a JavaScript number here
 * would undo that before the value ever reached the engine. Postgres reads a
 * numeric string into a numeric column without help.
 */
function coerceFields(fields: Record<string, string>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(fields)) {
    out[key] = value === 'true' ? true : value === 'false' ? false : value;
  }
  return out;
}

/** Database rows come back snake_cased; the write API takes camelCase. */
function toCamel(row: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row)) {
    out[key.replace(/_([a-z])/g, (_, letter: string) => letter.toUpperCase())] = value;
  }
  return out;
}

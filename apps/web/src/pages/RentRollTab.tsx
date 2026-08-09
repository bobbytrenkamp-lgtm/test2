import { useEffect, useId, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { leaseStatusEnum, rentBasisEnum } from '@cre/domain-models';
import { api, type Lease, type Space, type Tenant } from '../api.js';
import { EmptyState, ErrorMessage, Field, Loading } from '../components.js';
import { formatNumber, titleCase } from '../format.js';
import { useMutation, useResource, useUnsavedChangesWarning } from '../hooks.js';
import { useSession } from '../session.js';
import { useModelContext } from './ModelWorkspace.js';
import { PasteRentRoll } from '../components/PasteRentRoll.js';
import { EditableGrid } from '../grid/EditableGrid.js';
import { LeaseTimeline } from '../components/LeaseTimeline.js';
import { fieldForColumn, leaseColumns, withPending } from './rent-roll-columns.js';

/**
 * The rent roll.
 *
 * ## Cells are the input method; the record is still the unit of truth
 *
 * A lease is validated as a whole — its dates, area and rent have to agree, and
 * a half-saved lease produces a cash flow nobody can defend. That has not
 * changed. What has changed is how an analyst gets values in.
 *
 * Editing happens in a spreadsheet grid: select, type, Enter, fill down, paste
 * a column straight out of Excel. Those edits land in a **pending layer** shown
 * against the cells rather than being written a keystroke at a time. Saving
 * sends every touched lease to a batch endpoint that merges each change onto
 * the stored record and applies the same whole-record checks a single save
 * does, inside one transaction. So the grid never writes a lease the server
 * would not have accepted from the form, and a fill-down over forty rows either
 * lands completely or not at all.
 *
 * The form editor is still here and is still the only way to reach an
 * escalation, a recovery structure or a rent step, because none of those is a
 * single value and flattening one into a cell would lose part of it.
 *
 * ## Finding a lease
 *
 * A regional mall has three hundred tenancies. Reading one rent roll top to
 * bottom is how a lease gets missed, so the grid searches and sorts. Both happen
 * in the browser against the leases already loaded: a rent roll is one
 * property's, which is hundreds of rows rather than millions, and a round trip
 * per keystroke would be slower than the filter it replaces. If a single model
 * ever holds enough leases for that to stop being true, the endpoint will need
 * to filter and page — it currently returns them all.
 */

/** What the grid can be ordered by, and how each column compares. */
type SortKey = 'code' | 'tenant' | 'area' | 'commencement' | 'expiration' | 'rent';

const SORTS: Record<SortKey, { label: string; compare: (a: Lease, b: Lease) => number }> = {
  code: { label: 'Lease', compare: (a, b) => a.code.localeCompare(b.code) },
  tenant: {
    label: 'Tenant',
    compare: (a, b) => (a.tenant_name ?? '').localeCompare(b.tenant_name ?? ''),
  },
  /*
   * Area and rent are decimal *strings*, and sorting them as text puts 9,000 sf
   * above 10,000 sf. Compared as numbers instead — the only place in this file
   * where a decimal string is turned into a float, and safe because the result
   * decides an order and is never shown or stored.
   */
  area: { label: 'Area', compare: (a, b) => Number(a.area) - Number(b.area) },
  rent: { label: 'Base rent', compare: (a, b) => Number(a.base_rent) - Number(b.base_rent) },
  // ISO dates sort correctly as text. A missing date sorts last in either
  // direction: "no expiry recorded" is not "expires first".
  commencement: {
    label: 'Commences',
    compare: (a, b) => byDate(a.commencement_date, b.commencement_date),
  },
  expiration: {
    label: 'Expires',
    compare: (a, b) => byDate(a.expiration_date, b.expiration_date),
  },
};

function byDate(a: string | null, b: string | null): number {
  if (a === b) return 0;
  if (!a) return 1;
  if (!b) return -1;
  return a < b ? -1 : 1;
}

interface SortState {
  key: SortKey;
  ascending: boolean;
}

/**
 * Sorting, moved off the column headers and onto the toolbar.
 *
 * The grid's headers are no longer buttons: in a spreadsheet a click on a
 * header selects the column, and putting a sort control there would make the
 * two gestures fight. `aria-sort` still lives on the header so assistive
 * technology can report the order; this is where it is changed.
 */
function SortMenu({
  sort,
  onSort,
}: {
  sort: SortState;
  onSort: (state: SortState) => void;
}): JSX.Element {
  const id = useId();
  return (
    <span className="row" style={{ gap: 4 }}>
      <label className="visually-hidden" htmlFor={id}>
        Sort leases by
      </label>
      <select
        id={id}
        value={`${sort.key}:${sort.ascending ? 'asc' : 'desc'}`}
        style={{ width: 'auto' }}
        onChange={(event) => {
          const [key, direction] = event.target.value.split(':');
          onSort({ key: key as SortKey, ascending: direction === 'asc' });
        }}
      >
        {(Object.keys(SORTS) as SortKey[]).flatMap((key) => [
          <option key={`${key}:asc`} value={`${key}:asc`}>
            {SORTS[key].label} ↑
          </option>,
          <option key={`${key}:desc`} value={`${key}:desc`}>
            {SORTS[key].label} ↓
          </option>,
        ])}
      </select>
    </span>
  );
}

/**
 * Sort key to column key.
 *
 * The two vocabularies differ on purpose — a sort is "by expiry", a column is
 * `expirationDate` — so the correspondence is written down here rather than
 * inferred, and a column the grid cannot show simply has no arrow.
 */
const SORT_COLUMN: Record<SortKey, string> = {
  code: 'code',
  tenant: 'tenantName',
  area: 'area',
  rent: 'baseRent',
  commencement: 'commencementDate',
  expiration: 'expirationDate',
};

function matches(lease: Lease, needle: string): boolean {
  const haystack = [lease.code, lease.tenant_name ?? '', ...lease.space_codes]
    .join(' ')
    .toLowerCase();
  return haystack.includes(needle);
}

export function RentRollTab(): JSX.Element {
  const { model, property, reloadCashFlow, cashFlow } = useModelContext();
  /*
   * Grid or timeline, not both at once.
   *
   * They answer different questions — "what are the terms" and "where are the
   * holes" — and stacking them would mean scrolling past three hundred rows to
   * reach the picture.
   */
  const [view, setView] = useState<'grid' | 'timeline'>('grid');
  const { can } = useSession();
  const [editing, setEditing] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [pasting, setPasting] = useState(false);
  /*
   * The search box is URL state.
   *
   * "Where is that tenant?" is answered by linking to them — the calculation
   * inspector names a lease and offers to take you to it — and a link that
   * lands on an unfiltered rent roll of three hundred rows has not answered
   * anything. Keeping it in the query also means the browser's back button
   * returns to what the reader was looking at rather than to a blank filter.
   */
  const [params, setParams] = useSearchParams();
  const search = params.get('lease') ?? '';
  const setSearch = (value: string): void => {
    setParams(
      (current) => {
        const next = new URLSearchParams(current);
        if (value.trim() === '') next.delete('lease');
        else next.set('lease', value);
        return next;
      },
      { replace: true },
    );
  };
  const [sort, setSort] = useState<{ key: SortKey; ascending: boolean }>({
    // Expiry first, ascending: the question asked of a rent roll more often
    // than any other is what rolls over next.
    key: 'expiration',
    ascending: true,
  });

  const [focused, setFocused] = useState<Lease | null>(null);

  const leases = useResource<{ leases: Lease[] }>(`/models/${model.id}/leases`);
  const spaces = useResource<{ spaces: Space[] }>(
    property ? `/properties/${property.id}/spaces` : null,
  );
  const tenants = useResource<{ tenants: Tenant[] }>(
    property ? `/tenants?propertyId=${property.id}` : null,
  );

  const editable =
    can('model:write') &&
    !['approved', 'published', 'superseded', 'archived'].includes(model.status);

  const all = useMemo(() => leases.data?.leases ?? [], [leases.data]);

  const visible = useMemo(() => {
    const needle = search.trim().toLowerCase();
    const rows = needle ? all.filter((lease) => matches(lease, needle)) : all;
    // Sorted on a copy: `all` is the memo of what the server sent, and sorting
    // in place would quietly reorder it for every other reader of it.
    return [...rows].sort((a, b) => {
      const order = SORTS[sort.key].compare(a, b);
      return sort.ascending ? order : -order;
    });
  }, [all, search, sort]);

  const columns = useMemo(
    () => leaseColumns({ currency: model.currency, areaUnit: model.area_unit }),
    [model.currency, model.area_unit],
  );

  /*
   * Totals read the *stored* leases, not the pending ones.
   *
   * The grid shows an analyst their unsaved edits, which is right. A header
   * that counted them too would report an area the model does not hold, and
   * "42,700 sqft" that nobody has saved is worse than one that lags by a click.
   */
  const totals = useMemo(
    () => ({
      count: visible.length,
      area: visible.reduce((acc, lease) => acc + Number(lease.area), 0),
    }),
    [visible],
  );

  if (leases.loading) return <Loading label="Loading the rent roll" />;

  return (
    <>
      <ErrorMessage error={leases.error} />

      <div className="card">
        <div className="row" style={{ marginBottom: 12 }}>
          <h2 style={{ margin: 0 }}>Leases</h2>
          {/* Counts what is shown, and says so when that is not everything —
              a total that silently means "the filtered subset" is how a rent
              roll gets reported short. */}
          <span className="badge">
            {totals.count} lease{totals.count === 1 ? '' : 's'} · {formatNumber(totals.area, 0)}{' '}
            {model.area_unit}
          </span>
          {totals.count !== all.length && (
            <span className="badge accent">filtered from {all.length}</span>
          )}
          <div className="spacer" />
          <div className="segmented" role="group" aria-label="Rent roll view">
            <button type="button" aria-pressed={view === 'grid'} onClick={() => setView('grid')}>
              Grid
            </button>
            <button
              type="button"
              aria-pressed={view === 'timeline'}
              onClick={() => setView('timeline')}
            >
              Timeline
            </button>
          </div>
          <label className="visually-hidden" htmlFor="lease-search">
            Search leases
          </label>
          <input
            id="lease-search"
            type="search"
            placeholder="Search lease, tenant or suite…"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            style={{ width: 'auto', minWidth: 220 }}
          />
          {editable && (
            <>
              <button
                type="button"
                onClick={() => {
                  setPasting((value) => !value);
                  setCreating(false);
                  setEditing(null);
                }}
              >
                {pasting ? 'Cancel paste' : 'Paste from spreadsheet'}
              </button>
              <button
                type="button"
                className="primary"
                onClick={() => {
                  setCreating(true);
                  setEditing(null);
                  setPasting(false);
                }}
              >
                Add lease
              </button>
            </>
          )}
        </div>

        {!editable && (
          <div className="message info">
            This model is {titleCase(model.status).toLowerCase()}, so its leases are read-only.
            Clone the model to continue working.
          </div>
        )}

        {view === 'timeline' ? (
          cashFlow ? (
            <LeaseTimeline cashFlow={cashFlow} currency={model.currency} />
          ) : (
            <div className="message info">
              The timeline is drawn from the calculation, so the model has to have been calculated.
              Run one and it will appear.
            </div>
          )
        ) : leases.data && leases.data.leases.length === 0 ? (
          <EmptyState
            title="No leases have been added yet"
            action={
              editable ? (
                <div className="row">
                  <button type="button" className="primary" onClick={() => setCreating(true)}>
                    Add a lease
                  </button>
                  <button type="button" onClick={() => setPasting(true)}>
                    Paste from Excel
                  </button>
                </div>
              ) : undefined
            }
          >
            Add one by hand, paste a rent roll straight out of a spreadsheet, or import an XLSX
            workbook from the Imports tab. Space that never carries a lease is absorbed
            speculatively on the market leasing assumptions.
          </EmptyState>
        ) : visible.length === 0 ? (
          <EmptyState title="No lease matches that search">
            {all.length} lease{all.length === 1 ? '' : 's'} on this model; none has a code, tenant
            or suite containing “{search.trim()}”.
          </EmptyState>
        ) : (
          <EditableGrid
            rows={visible}
            columns={columns}
            rowId={(lease) => lease.code}
            merge={withPending}
            editable={editable}
            label="Leases on this model"
            preferenceKey={`rentRoll.${model.id}`}
            onFocusedRowChange={setFocused}
            sortedBy={{ columnKey: SORT_COLUMN[sort.key], ascending: sort.ascending }}
            onSaved={() => {
              leases.reload();
              reloadCashFlow();
            }}
            save={async (changes) => {
              const byCode = new Map(all.map((lease) => [lease.code, lease]));
              const payload = changes.flatMap((change) => {
                const lease = byCode.get(change.rowId);
                if (!lease) return [];
                // Column keys and lease fields are the same vocabulary here,
                // but only the editable ones are accepted by the endpoint, so
                // the mapping is asserted rather than assumed.
                const fields: Record<string, string> = {};
                for (const [key, value] of Object.entries(change.fields)) {
                  const field = fieldForColumn(key);
                  if (field) fields[field] = value;
                }
                return Object.keys(fields).length === 0
                  ? []
                  : [{ code: change.rowId, expectedVersion: lease.version, fields }];
              });
              if (payload.length === 0) return;
              await api.patch(`/models/${model.id}/leases`, { changes: payload });
            }}
            toolbar={
              <>
                <SortMenu sort={sort} onSort={setSort} />
                {editable && (
                  <button
                    type="button"
                    className="subtle"
                    disabled={!focused}
                    onClick={() => {
                      if (focused) {
                        setEditing(focused.code);
                        setCreating(false);
                      }
                    }}
                    title="Escalations, recoveries, rent steps and options are records rather than single values, so they are edited here"
                  >
                    {focused ? `Edit ${focused.code} in full` : 'Edit in full'}
                  </button>
                )}
              </>
            }
          />
        )}
      </div>

      {pasting && (
        <PasteRentRoll
          modelId={model.id}
          onCancel={() => setPasting(false)}
          onImported={() => {
            setPasting(false);
            leases.reload();
            reloadCashFlow();
          }}
        />
      )}

      {(creating || editing) && (
        <LeaseEditor
          modelId={model.id}
          currency={model.currency}
          spaces={spaces.data?.spaces ?? []}
          tenants={tenants.data?.tenants ?? []}
          lease={editing ? (leases.data?.leases.find((l) => l.code === editing) ?? null) : null}
          onCancel={() => {
            setCreating(false);
            setEditing(null);
          }}
          onSaved={() => {
            setCreating(false);
            setEditing(null);
            leases.reload();
            reloadCashFlow();
          }}
        />
      )}
    </>
  );
}

interface LeaseForm {
  code: string;
  tenantId: string;
  newTenantName: string;
  status: string;
  area: string;
  spaceCode: string;
  commencementDate: string;
  expirationDate: string;
  baseRent: string;
  baseRentBasis: string;
  escalationType: string;
  escalationRate: string;
  recoveryMethod: string;
  steps: Array<{ startDate: string; amount: string; basis: string }>;
}

function LeaseEditor({
  modelId,
  currency,
  spaces,
  tenants,
  lease,
  onCancel,
  onSaved,
}: {
  modelId: string;
  currency: string;
  spaces: Space[];
  tenants: Tenant[];
  lease: Lease | null;
  onCancel: () => void;
  onSaved: () => void;
}): JSX.Element {
  const [form, setForm] = useState<LeaseForm>(() => ({
    code: lease?.code ?? '',
    tenantId: lease?.tenant_id ?? '',
    newTenantName: '',
    status: lease?.status ?? 'occupied',
    area: lease?.area ?? '',
    spaceCode: lease?.space_codes[0] ?? '',
    commencementDate: lease?.commencement_date?.slice(0, 10) ?? '',
    expirationDate: lease?.expiration_date?.slice(0, 10) ?? '',
    baseRent: lease?.base_rent ?? '',
    baseRentBasis: lease?.base_rent_basis ?? 'per_area_per_year',
    escalationType: (lease?.escalation?.type as string) ?? 'fixed_percent',
    escalationRate: (lease?.escalation?.rate as string) ?? '0.03',
    recoveryMethod: (lease?.recovery?.method as string) ?? 'triple_net',
    steps: lease?.rent_steps ?? [],
  }));
  const [dirty, setDirty] = useState(false);
  useUnsavedChangesWarning(dirty);

  useEffect(() => {
    // Match the lease area to the selected suite unless the user has typed one.
    if (!form.area && form.spaceCode) {
      const space = spaces.find((entry) => entry.code === form.spaceCode);
      if (space) setForm((current) => ({ ...current, area: space.area }));
    }
    // Deps are listed deliberately; see the comment above.
  }, [form.spaceCode]);

  const update = <K extends keyof LeaseForm>(key: K, value: LeaseForm[K]): void => {
    setDirty(true);
    setForm((current) => ({ ...current, [key]: value }));
  };

  const dateError =
    form.commencementDate && form.expirationDate && form.expirationDate < form.commencementDate
      ? 'A lease cannot expire before it commences.'
      : undefined;

  const save = useMutation(async () => {
    let tenantId = form.tenantId;
    if (!tenantId && form.newTenantName.trim()) {
      const created = await api.post<{ tenant: Tenant }>('/tenants', {
        name: form.newTenantName.trim(),
      });
      tenantId = created.tenant.id;
    }
    return api.put(`/models/${modelId}/leases/${encodeURIComponent(form.code)}`, {
      // The version this editor opened. If someone else has saved since, the
      // server refuses rather than writing over work this screen never showed.
      expectedVersion: lease?.version ?? null,
      tenantId,
      status: form.status,
      area: form.area,
      spaceIds: form.spaceCode ? [form.spaceCode] : [],
      commencementDate: form.commencementDate,
      expirationDate: form.expirationDate,
      baseRent: form.baseRent,
      baseRentBasis: form.baseRentBasis,
      rentSteps: form.steps.filter((step) => step.startDate && step.amount),
      escalation:
        form.escalationType === 'none'
          ? { type: 'none' }
          : { type: form.escalationType, rate: form.escalationRate, frequencyMonths: 12 },
      recovery: { method: form.recoveryMethod },
    });
  });

  async function submit(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    if (dateError) return;
    if (await save.run()) {
      setDirty(false);
      onSaved();
    }
  }

  return (
    <form className="card" onSubmit={submit}>
      <h2>{lease ? `Edit lease ${lease.code}` : 'New lease'}</h2>

      {save.error?.status === 409 ? (
        <div className="message error" role="alert">
          <strong>{save.error.message}</strong>
          <p style={{ marginBottom: 0 }}>
            Nothing has been saved. Cancel and reopen the lease to see their changes, then reapply
            yours. Saving over them would discard work you cannot see from here.
          </p>
        </div>
      ) : (
        <ErrorMessage error={save.error} />
      )}

      <div className="form-grid">
        <Field label="Lease reference" hint="Stable identifier used in traces and reports.">
          <input
            required
            maxLength={60}
            readOnly={Boolean(lease)}
            value={form.code}
            onChange={(event) => update('code', event.target.value)}
          />
        </Field>

        <Field label="Tenant">
          <select
            value={form.tenantId}
            onChange={(event) => update('tenantId', event.target.value)}
          >
            <option value="">New tenant…</option>
            {tenants.map((tenant) => (
              <option key={tenant.id} value={tenant.id}>
                {tenant.name}
              </option>
            ))}
          </select>
        </Field>

        {!form.tenantId && (
          <Field label="New tenant name">
            <input
              required
              value={form.newTenantName}
              onChange={(event) => update('newTenantName', event.target.value)}
            />
          </Field>
        )}

        <Field label="Suite or space">
          <select
            value={form.spaceCode}
            onChange={(event) => update('spaceCode', event.target.value)}
          >
            <option value="">Not assigned</option>
            {spaces.map((space) => (
              <option key={space.id} value={space.code}>
                {space.code} ({formatNumber(space.area, 0)})
              </option>
            ))}
          </select>
        </Field>

        <Field label="Status">
          <select value={form.status} onChange={(event) => update('status', event.target.value)}>
            {leaseStatusEnum.options.map((option) => (
              <option key={option} value={option}>
                {titleCase(option)}
              </option>
            ))}
          </select>
        </Field>

        <Field label="Area">
          <input
            required
            inputMode="decimal"
            value={form.area}
            onChange={(event) => update('area', event.target.value)}
          />
        </Field>

        <Field label="Commencement">
          <input
            type="date"
            required
            value={form.commencementDate}
            onChange={(event) => update('commencementDate', event.target.value)}
          />
        </Field>

        <Field label="Expiration" error={dateError}>
          <input
            type="date"
            required
            aria-invalid={dateError ? 'true' : undefined}
            value={form.expirationDate}
            onChange={(event) => update('expirationDate', event.target.value)}
          />
        </Field>

        <Field label={`Base rent (${currency})`}>
          <input
            required
            inputMode="decimal"
            value={form.baseRent}
            onChange={(event) => update('baseRent', event.target.value)}
          />
        </Field>

        <Field label="Rent basis">
          <select
            value={form.baseRentBasis}
            onChange={(event) => update('baseRentBasis', event.target.value)}
          >
            {rentBasisEnum.options.map((option) => (
              <option key={option} value={option}>
                {titleCase(option)}
              </option>
            ))}
          </select>
        </Field>

        <Field label="Escalation">
          <select
            value={form.escalationType}
            onChange={(event) => update('escalationType', event.target.value)}
          >
            <option value="none">None</option>
            <option value="fixed_percent">Fixed percentage, annually</option>
            <option value="fixed_amount">Fixed amount, annually</option>
            <option value="index">Index linked</option>
            <option value="market_reset">Reset to market</option>
          </select>
        </Field>

        {form.escalationType !== 'none' && (
          <Field
            label="Escalation rate or amount"
            hint="A decimal fraction for percentages, e.g. 0.03 for 3%."
          >
            <input
              inputMode="decimal"
              value={form.escalationRate}
              onChange={(event) => update('escalationRate', event.target.value)}
            />
          </Field>
        )}

        <Field label="Expense recovery">
          <select
            value={form.recoveryMethod}
            onChange={(event) => update('recoveryMethod', event.target.value)}
          >
            <option value="none">None</option>
            <option value="triple_net">Triple net</option>
            <option value="base_year">Base year</option>
            <option value="expense_stop">Expense stop</option>
            <option value="full_service_gross">Full service gross</option>
            <option value="fixed_amount">Fixed amount</option>
          </select>
        </Field>
      </div>

      <fieldset style={{ border: '1px solid var(--border)', borderRadius: 6, padding: 12 }}>
        <legend style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-muted)' }}>
          Rent steps
        </legend>
        <p className="field-hint" style={{ marginTop: 0 }}>
          A step states the contractual rate outright from its date onward, and resets the
          escalation clock so both mechanisms are never applied to the same period.
        </p>
        {form.steps.map((step, index) => (
          <div className="row" key={index} style={{ marginBottom: 8 }}>
            <input
              type="date"
              aria-label={`Step ${index + 1} start date`}
              value={step.startDate}
              onChange={(event) => {
                const steps = [...form.steps];
                steps[index] = { ...step, startDate: event.target.value };
                update('steps', steps);
              }}
              style={{ maxWidth: 170 }}
            />
            <input
              inputMode="decimal"
              aria-label={`Step ${index + 1} amount`}
              value={step.amount}
              onChange={(event) => {
                const steps = [...form.steps];
                steps[index] = { ...step, amount: event.target.value };
                update('steps', steps);
              }}
              style={{ maxWidth: 140 }}
            />
            <select
              aria-label={`Step ${index + 1} basis`}
              value={step.basis}
              onChange={(event) => {
                const steps = [...form.steps];
                steps[index] = { ...step, basis: event.target.value };
                update('steps', steps);
              }}
              style={{ maxWidth: 210 }}
            >
              {rentBasisEnum.options.map((option) => (
                <option key={option} value={option}>
                  {titleCase(option)}
                </option>
              ))}
            </select>
            <button
              type="button"
              className="danger"
              onClick={() =>
                update(
                  'steps',
                  form.steps.filter((_, i) => i !== index),
                )
              }
            >
              Remove
            </button>
          </div>
        ))}
        <button
          type="button"
          onClick={() =>
            update('steps', [
              ...form.steps,
              { startDate: '', amount: '', basis: form.baseRentBasis },
            ])
          }
        >
          Add a step
        </button>
      </fieldset>

      <div className="row end" style={{ marginTop: 16 }}>
        <button type="button" onClick={onCancel}>
          Cancel
        </button>
        <button type="submit" className="primary" disabled={save.pending || Boolean(dateError)}>
          {save.pending ? 'Saving…' : 'Save lease'}
        </button>
      </div>
    </form>
  );
}

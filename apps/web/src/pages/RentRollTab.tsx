import { useEffect, useMemo, useState } from 'react';
import { leaseStatusEnum, rentBasisEnum } from '@cre/domain-models';
import { api, type Lease, type Space, type Tenant } from '../api.js';
import { EmptyState, ErrorMessage, Field, Loading, StatusBadge } from '../components.js';
import { formatCurrency, formatDate, formatNumber, titleCase } from '../format.js';
import { useMutation, useResource, useUnsavedChangesWarning } from '../hooks.js';
import { useSession } from '../session.js';
import { useModelContext } from './ModelWorkspace.js';
import { PasteRentRoll } from '../components/PasteRentRoll.js';

/**
 * The rent roll.
 *
 * Leases are edited one at a time in a form rather than in free-floating grid
 * cells: a lease is a coherent record whose dates, area and rent have to be
 * validated together, and a half-saved lease would produce a cash flow nobody
 * could defend. The grid stays the reading surface; the editor is the writing
 * surface.
 */
export function RentRollTab(): JSX.Element {
  const { model, property, reloadCashFlow } = useModelContext();
  const { can } = useSession();
  const [editing, setEditing] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [pasting, setPasting] = useState(false);

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

  const totals = useMemo(() => {
    const rows = leases.data?.leases ?? [];
    return {
      count: rows.length,
      area: rows.reduce((acc, lease) => acc + Number(lease.area), 0),
    };
  }, [leases.data]);

  if (leases.loading) return <Loading label="Loading the rent roll" />;

  return (
    <>
      <ErrorMessage error={leases.error} />

      <div className="card">
        <div className="row" style={{ marginBottom: 12 }}>
          <h2 style={{ margin: 0 }}>Leases</h2>
          <span className="badge">
            {totals.count} lease{totals.count === 1 ? '' : 's'} · {formatNumber(totals.area, 0)}{' '}
            {model.area_unit}
          </span>
          <div className="spacer" />
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

        {leases.data && leases.data.leases.length === 0 ? (
          <EmptyState title="No leases yet">
            Add a lease, or import a rent roll from a spreadsheet. Space that never carries a lease
            is absorbed speculatively on the market leasing assumptions.
          </EmptyState>
        ) : (
          <div className="table-scroll" tabIndex={0}>
            <table>
              <caption className="visually-hidden">Leases on this model</caption>
              <thead>
                <tr>
                  <th scope="col">Lease</th>
                  <th scope="col">Tenant</th>
                  <th scope="col">Suite</th>
                  <th scope="col">Status</th>
                  <th scope="col" className="numeric">
                    Area
                  </th>
                  <th scope="col">Commences</th>
                  <th scope="col">Expires</th>
                  <th scope="col" className="numeric">
                    Base rent
                  </th>
                  <th scope="col">Basis</th>
                  <th scope="col" className="numeric">
                    Steps
                  </th>
                  {editable && <th scope="col">Actions</th>}
                </tr>
              </thead>
              <tbody>
                {leases.data?.leases.map((lease) => (
                  <tr key={lease.id}>
                    <th scope="row">{lease.code}</th>
                    <td>{lease.tenant_name}</td>
                    <td>{lease.space_codes.join(', ') || '—'}</td>
                    <td>
                      <StatusBadge status={lease.status} />
                    </td>
                    <td className="numeric">{formatNumber(lease.area, 0)}</td>
                    <td>{formatDate(lease.commencement_date)}</td>
                    <td>{formatDate(lease.expiration_date)}</td>
                    <td className="numeric">
                      {formatCurrency(lease.base_rent, model.currency, { decimals: 2 })}
                    </td>
                    <td>{titleCase(lease.base_rent_basis)}</td>
                    <td className="numeric">{lease.rent_steps.length || '—'}</td>
                    {editable && (
                      <td>
                        <button
                          type="button"
                          className="subtle"
                          onClick={() => {
                            setEditing(lease.code);
                            setCreating(false);
                          }}
                        >
                          Edit
                        </button>
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
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
      <ErrorMessage error={save.error} />

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

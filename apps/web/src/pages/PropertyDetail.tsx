import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { modelClassificationEnum } from '@cre/domain-models';
import { api, type Model, type Property, type Space } from '../api.js';
import {
  EmptyState,
  ErrorMessage,
  Field,
  FavouriteButton,
  Loading,
  StatusBadge,
} from '../components.js';
import { formatDate, formatNumber, titleCase } from '../format.js';
import { useMutation, useResource } from '../hooks.js';
import { recordRecent } from '../recents.js';
import { useSession } from '../session.js';

export function PropertyDetailPage(): JSX.Element {
  const { propertyId } = useParams<{ propertyId: string }>();
  const { can, session } = useSession();
  const [creatingModel, setCreatingModel] = useState(false);

  const property = useResource<{ property: Property; spaces: Space[] }>(
    propertyId ? `/properties/${propertyId}` : null,
  );
  const models = useResource<{ models: Model[] }>(
    propertyId ? `/models?propertyId=${propertyId}` : null,
  );

  const record = property.data?.property;
  const recordId = record?.id;
  useEffect(() => {
    if (!record || !session?.user.id || !session.organizationId) return;
    recordRecent(session.user.id, session.organizationId, {
      entityType: 'property',
      entityId: record.id,
      name: record.name,
      context: record.market,
    });
    // Deliberately keyed on the id alone: recorded once per visit, not on
    // every render this record's other fields happen to reflow through.
  }, [recordId, session?.user.id, session?.organizationId]);

  if (property.loading) return <Loading label="Loading property" />;
  if (property.error) return <ErrorMessage error={property.error} />;
  if (!property.data || !record)
    return <EmptyState title="Not found">That property does not exist.</EmptyState>;

  const { spaces } = property.data;
  const spaceArea = spaces
    .filter((space) => !space.is_non_revenue)
    .reduce((acc, space) => acc + Number(space.area), 0);

  return (
    <>
      <div className="page-title">
        <div>
          <h1>
            <FavouriteButton entityType="property" entityId={record.id} name={record.name} />
            {record.name}
          </h1>
          <p>
            {titleCase(record.property_type)}
            {record.property_subtype ? ` · ${record.property_subtype}` : ''}
            {record.city
              ? ` · ${record.city}${record.state_region ? `, ${record.state_region}` : ''}`
              : ''}
          </p>
        </div>
        {can('model:write') && (
          <button type="button" className="primary" onClick={() => setCreatingModel((v) => !v)}>
            {creatingModel ? 'Cancel' : 'New model'}
          </button>
        )}
      </div>

      <dl className="metric-grid" style={{ marginBottom: 16 }}>
        <div className="metric">
          <dt>Rentable area</dt>
          <dd>
            {formatNumber(record.rentable_area, 0)}
            <div className="metric-note">{record.area_unit}</div>
          </dd>
        </div>
        <div className="metric">
          <dt>Space list total</dt>
          <dd>
            {formatNumber(spaceArea, 0)}
            <div className="metric-note">
              {spaces.length} space{spaces.length === 1 ? '' : 's'} — this is the recovery
              denominator
            </div>
          </dd>
        </div>
        <div className="metric">
          <dt>Units</dt>
          <dd>{record.unit_count || '—'}</dd>
        </div>
        <div className="metric">
          <dt>Year built</dt>
          <dd>{record.year_built ?? '—'}</dd>
        </div>
        <div className="metric">
          <dt>Market</dt>
          <dd style={{ fontSize: 15 }}>
            {record.market ?? '—'}
            <div className="metric-note">{record.submarket ?? ''}</div>
          </dd>
        </div>
      </dl>

      {creatingModel && propertyId && (
        <NewModelForm
          propertyId={propertyId}
          onCreated={() => {
            setCreatingModel(false);
            models.reload();
          }}
        />
      )}

      <div className="card">
        <h2>Models</h2>
        <ErrorMessage error={models.error} />
        {models.loading && <Loading label="Loading models" />}
        {models.data && models.data.models.length === 0 && (
          <EmptyState title="No models yet">
            A model holds one scenario for this property: its forecast, leases, assumptions and
            results. Create one to begin underwriting.
          </EmptyState>
        )}
        {models.data && models.data.models.length > 0 && (
          <div className="table-scroll" tabIndex={0}>
            <table>
              <caption className="visually-hidden">Models for this property</caption>
              <thead>
                <tr>
                  <th scope="col">Model</th>
                  <th scope="col">Classification</th>
                  <th scope="col">Status</th>
                  <th scope="col">Valuation date</th>
                  <th scope="col" className="numeric">
                    Forecast
                  </th>
                  <th scope="col" className="numeric">
                    Discount rate
                  </th>
                  <th scope="col" className="numeric">
                    Exit cap
                  </th>
                </tr>
              </thead>
              <tbody>
                {models.data.models.map((model) => (
                  <tr key={model.id}>
                    <th scope="row" style={{ fontWeight: 600 }}>
                      <Link to={`/models/${model.id}`}>{model.name}</Link>
                    </th>
                    <td>{titleCase(model.classification)}</td>
                    <td>
                      <StatusBadge status={model.status} />
                    </td>
                    <td>{formatDate(model.valuation_date)}</td>
                    <td className="numeric">{model.forecast_months} mo</td>
                    <td className="numeric">
                      {model.discount_rate
                        ? `${(Number(model.discount_rate) * 100).toFixed(2)}%`
                        : '—'}
                    </td>
                    <td className="numeric">
                      {model.terminal_cap_rate
                        ? `${(Number(model.terminal_cap_rate) * 100).toFixed(2)}%`
                        : '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className="card">
        <h2>Physical structure</h2>
        {spaces.length === 0 ? (
          <EmptyState title="No spaces defined">
            Spaces are the source of truth for rentable area, occupancy and the recovery
            denominator. Add them before entering leases.
          </EmptyState>
        ) : (
          <div className="table-scroll" tabIndex={0}>
            <table>
              <caption className="visually-hidden">Spaces</caption>
              <thead>
                <tr>
                  <th scope="col">Code</th>
                  <th scope="col">Floor</th>
                  <th scope="col">Type</th>
                  <th scope="col" className="numeric">
                    Area
                  </th>
                  <th scope="col" className="numeric">
                    Units
                  </th>
                  <th scope="col">Revenue producing</th>
                </tr>
              </thead>
              <tbody>
                {spaces.map((space) => (
                  <tr key={space.id}>
                    <th scope="row">{space.code}</th>
                    <td>{space.floor ?? '—'}</td>
                    <td>{titleCase(space.space_type)}</td>
                    <td className="numeric">{formatNumber(space.area, 0)}</td>
                    <td className="numeric">{space.unit_count || '—'}</td>
                    <td>{space.is_non_revenue ? 'No' : 'Yes'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </>
  );
}

function NewModelForm({
  propertyId,
  onCreated,
}: {
  propertyId: string;
  onCreated: () => void;
}): JSX.Element {
  const [form, setForm] = useState({
    name: '',
    classification: 'acquisition',
    valuationDate: new Date().toISOString().slice(0, 10),
    forecastStartDate: `${new Date().getFullYear() + 1}-01-01`,
    forecastMonths: '84',
    discountRate: '0.08',
    terminalCapRate: '0.065',
    saleMonth: '60',
    saleCostPercent: '0.01',
  });

  const create = useMutation(async () =>
    api.post<{ model: Model }>('/models', {
      propertyId,
      name: form.name,
      classification: form.classification,
      valuationDate: form.valuationDate,
      forecastStartDate: form.forecastStartDate,
      forecastMonths: Number(form.forecastMonths),
      discountRate: form.discountRate,
      terminalCapRate: form.terminalCapRate,
      saleMonth: Number(form.saleMonth),
      saleCostPercent: form.saleCostPercent,
      terminalNoiBasis: 'forward_12',
    }),
  );

  async function submit(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    if (await create.run()) onCreated();
  }

  return (
    <form className="card" onSubmit={submit}>
      <h2>New model</h2>
      <ErrorMessage error={create.error} />
      <div className="form-grid">
        <Field label="Model name">
          <input
            required
            value={form.name}
            onChange={(event) => setForm({ ...form, name: event.target.value })}
          />
        </Field>
        <Field label="Classification">
          <select
            value={form.classification}
            onChange={(event) => setForm({ ...form, classification: event.target.value })}
          >
            {modelClassificationEnum.options.map((option) => (
              <option key={option} value={option}>
                {titleCase(option)}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Valuation date">
          <input
            type="date"
            required
            value={form.valuationDate}
            onChange={(event) => setForm({ ...form, valuationDate: event.target.value })}
          />
        </Field>
        <Field label="Forecast start" hint="Coerced to the first of the month.">
          <input
            type="date"
            required
            value={form.forecastStartDate}
            onChange={(event) => setForm({ ...form, forecastStartDate: event.target.value })}
          />
        </Field>
        <Field
          label="Forecast months"
          hint="Run at least 12 months past the sale so a forward NOI is available."
        >
          <input
            inputMode="numeric"
            required
            value={form.forecastMonths}
            onChange={(event) => setForm({ ...form, forecastMonths: event.target.value })}
          />
        </Field>
        <Field label="Discount rate" hint="Annual effective rate as a decimal, e.g. 0.08.">
          <input
            inputMode="decimal"
            value={form.discountRate}
            onChange={(event) => setForm({ ...form, discountRate: event.target.value })}
          />
        </Field>
        <Field label="Exit capitalization rate" hint="Decimal, e.g. 0.065.">
          <input
            inputMode="decimal"
            value={form.terminalCapRate}
            onChange={(event) => setForm({ ...form, terminalCapRate: event.target.value })}
          />
        </Field>
        <Field label="Sale month">
          <input
            inputMode="numeric"
            value={form.saleMonth}
            onChange={(event) => setForm({ ...form, saleMonth: event.target.value })}
          />
        </Field>
        <Field label="Costs of sale" hint="Fraction of the gross sale price.">
          <input
            inputMode="decimal"
            value={form.saleCostPercent}
            onChange={(event) => setForm({ ...form, saleCostPercent: event.target.value })}
          />
        </Field>
      </div>
      <div className="row end">
        <button type="submit" className="primary" disabled={create.pending}>
          {create.pending ? 'Creating…' : 'Create model'}
        </button>
      </div>
    </form>
  );
}

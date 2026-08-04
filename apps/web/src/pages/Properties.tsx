import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { propertyTypeEnum } from '@cre/domain-models';
import { api, type Property } from '../api.js';
import { EmptyState, ErrorMessage, Field, Loading, StatusBadge } from '../components.js';
import { formatCurrency, formatNumber, titleCase } from '../format.js';
import { useMutation, useResource } from '../hooks.js';
import { useSession } from '../session.js';

export function PropertiesPage(): JSX.Element {
  const { can } = useSession();
  const [search, setSearch] = useState('');
  const [type, setType] = useState('');
  const [creating, setCreating] = useState(false);

  const query = new URLSearchParams();
  if (search.trim()) query.set('search', search.trim());
  if (type) query.set('propertyType', type);
  const suffix = query.toString() ? `?${query}` : '';

  const { data, loading, error, reload } = useResource<{
    properties: Property[];
    total: number;
  }>(`/properties${suffix}`);

  return (
    <>
      <div className="page-title">
        <div>
          <h1>Properties</h1>
          <p>{data ? `${data.total} propert${data.total === 1 ? 'y' : 'ies'}` : 'Loading…'}</p>
        </div>
        {can('property:write') && (
          <button type="button" className="primary" onClick={() => setCreating((value) => !value)}>
            {creating ? 'Cancel' : 'New property'}
          </button>
        )}
      </div>

      {creating && (
        <NewPropertyForm
          onCreated={() => {
            setCreating(false);
            reload();
          }}
        />
      )}

      <div className="card">
        <div className="row">
          <div style={{ flex: '1 1 240px' }}>
            <label htmlFor="prop-search">Search</label>
            <input
              id="prop-search"
              type="search"
              placeholder="Name or city"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
            />
          </div>
          <div style={{ flex: '0 1 200px' }}>
            <label htmlFor="prop-type">Property type</label>
            <select id="prop-type" value={type} onChange={(event) => setType(event.target.value)}>
              <option value="">All types</option>
              {propertyTypeEnum.options.map((option) => (
                <option key={option} value={option}>
                  {titleCase(option)}
                </option>
              ))}
            </select>
          </div>
        </div>
      </div>

      <ErrorMessage error={error} />
      {loading && <Loading label="Loading properties" />}

      {data && data.properties.length === 0 && !loading && (
        <EmptyState title="No properties match">
          {search || type
            ? 'Adjust the search or type filter to see more.'
            : 'Create a property to start underwriting, or seed the demonstration data.'}
        </EmptyState>
      )}

      {data && data.properties.length > 0 && (
        <div className="card">
          <div className="table-scroll" tabIndex={0}>
            <table>
              <caption className="visually-hidden">Properties in this organization</caption>
              <thead>
                <tr>
                  <th scope="col">Property</th>
                  <th scope="col">Type</th>
                  <th scope="col">Market</th>
                  <th scope="col" className="numeric">
                    Rentable area
                  </th>
                  <th scope="col" className="numeric">
                    Units
                  </th>
                  <th scope="col" className="numeric">
                    Acquisition price
                  </th>
                  <th scope="col">Tags</th>
                </tr>
              </thead>
              <tbody>
                {data.properties.map((property) => (
                  <tr key={property.id}>
                    <th scope="row" style={{ fontWeight: 600 }}>
                      <Link to={`/properties/${property.id}`}>{property.name}</Link>
                      {property.city && (
                        <div style={{ color: 'var(--text-muted)', fontWeight: 400, fontSize: 12 }}>
                          {property.city}
                          {property.state_region ? `, ${property.state_region}` : ''}
                        </div>
                      )}
                    </th>
                    <td>
                      <StatusBadge status={property.property_type} />
                    </td>
                    <td>{property.market ?? '—'}</td>
                    <td className="numeric">{formatNumber(property.rentable_area, 0)}</td>
                    <td className="numeric">{property.unit_count || '—'}</td>
                    <td className="numeric">
                      {formatCurrency(property.acquisition_price, property.currency, {
                        compact: true,
                      })}
                    </td>
                    <td>
                      {property.tags.map((tag) => (
                        <span key={tag} className="badge" style={{ marginRight: 4 }}>
                          {tag}
                        </span>
                      ))}
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

function NewPropertyForm({ onCreated }: { onCreated: () => void }): JSX.Element {
  const navigate = useNavigate();
  const [form, setForm] = useState({
    name: '',
    propertyType: 'office',
    city: '',
    stateRegion: '',
    market: '',
    rentableArea: '',
    unitCount: '0',
  });

  const create = useMutation(async () =>
    api.post<{ property: Property }>('/properties', {
      name: form.name,
      propertyType: form.propertyType,
      city: form.city || null,
      stateRegion: form.stateRegion || null,
      market: form.market || null,
      rentableArea: form.rentableArea || null,
      unitCount: Number(form.unitCount) || 0,
    }),
  );

  async function submit(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    const result = await create.run();
    if (result) {
      onCreated();
      navigate(`/properties/${result.property.id}`);
    }
  }

  return (
    <form className="card" onSubmit={submit}>
      <h2>New property</h2>
      <ErrorMessage error={create.error} />
      <div className="form-grid">
        <Field label="Name">
          <input
            required
            maxLength={200}
            value={form.name}
            onChange={(event) => setForm({ ...form, name: event.target.value })}
          />
        </Field>
        <Field label="Property type">
          <select
            value={form.propertyType}
            onChange={(event) => setForm({ ...form, propertyType: event.target.value })}
          >
            {propertyTypeEnum.options.map((option) => (
              <option key={option} value={option}>
                {titleCase(option)}
              </option>
            ))}
          </select>
        </Field>
        <Field label="City">
          <input
            value={form.city}
            onChange={(event) => setForm({ ...form, city: event.target.value })}
          />
        </Field>
        <Field label="State or region">
          <input
            value={form.stateRegion}
            onChange={(event) => setForm({ ...form, stateRegion: event.target.value })}
          />
        </Field>
        <Field label="Market">
          <input
            value={form.market}
            onChange={(event) => setForm({ ...form, market: event.target.value })}
          />
        </Field>
        <Field label="Rentable area" hint="Total rentable area in the property's area unit.">
          <input
            inputMode="decimal"
            value={form.rentableArea}
            onChange={(event) => setForm({ ...form, rentableArea: event.target.value })}
          />
        </Field>
        <Field label="Units" hint="Residential, storage or parking units, where applicable.">
          <input
            inputMode="numeric"
            value={form.unitCount}
            onChange={(event) => setForm({ ...form, unitCount: event.target.value })}
          />
        </Field>
      </div>
      <div className="row end">
        <button type="submit" className="primary" disabled={create.pending}>
          {create.pending ? 'Creating…' : 'Create property'}
        </button>
      </div>
    </form>
  );
}

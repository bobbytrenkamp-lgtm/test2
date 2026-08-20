import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { modelClassificationEnum, propertyTypeEnum } from '@cre/domain-models';
import { api, type Model, type Property } from '../api.js';
import { EmptyState, ErrorMessage, Field } from '../components.js';
import { numericFieldProblem, titleCase } from '../format.js';
import { useMutation } from '../hooks.js';
import { useSession } from '../session.js';

/**
 * New Underwriting: the guided start of a real acquisition underwrite.
 *
 * Before this, starting one meant two separate screens with nothing routing
 * an analyst from the first to the second — create a property, land on its
 * detail page, then remember to also create a model there, then click
 * through to it. This is one form, one atomic `POST /underwriting` (so a
 * failure partway through never leaves a property with no model), and one
 * landing spot: the new model's own Assumptions tab, ready to start
 * entering the deal.
 *
 * The fields here are exactly `propertyBody`'s and `modelAssumptions`'
 * required fields, plus the handful of optional ones already surfaced on
 * the two standalone forms this replaces (`Properties.tsx`'s
 * `NewPropertyForm`, `PropertyDetail.tsx`'s `NewModelForm`) — nothing new
 * invented, and nothing skipped that an analyst already expects to set at
 * creation time.
 */
export function NewUnderwritingPage(): JSX.Element {
  const { can } = useSession();
  const navigate = useNavigate();

  const [form, setForm] = useState({
    // Property
    name: '',
    propertyType: 'office',
    city: '',
    stateRegion: '',
    market: '',
    rentableArea: '',
    unitCount: '0',
    // Model
    modelName: 'Acquisition underwriting',
    classification: 'acquisition',
    valuationDate: new Date().toISOString().slice(0, 10),
    forecastStartDate: `${new Date().getFullYear() + 1}-01-01`,
    forecastMonths: '84',
    discountRate: '0.08',
    terminalCapRate: '0.065',
    saleMonth: '60',
    saleCostPercent: '0.01',
    acquisitionPrice: '',
  });

  const set = (key: keyof typeof form, value: string): void =>
    setForm((current) => ({ ...current, [key]: value }));

  const create = useMutation(async () =>
    api.post<{ property: Property; model: Model }>('/underwriting', {
      property: {
        name: form.name,
        propertyType: form.propertyType,
        city: form.city || null,
        stateRegion: form.stateRegion || null,
        market: form.market || null,
        rentableArea: form.rentableArea || null,
        unitCount: Number(form.unitCount) || 0,
      },
      model: {
        name: form.modelName,
        classification: form.classification,
        valuationDate: form.valuationDate,
        forecastStartDate: form.forecastStartDate,
        forecastMonths: Number(form.forecastMonths),
        discountRate: form.discountRate || null,
        terminalCapRate: form.terminalCapRate || null,
        saleMonth: Number(form.saleMonth) || null,
        saleCostPercent: form.saleCostPercent,
        acquisitionPrice: form.acquisitionPrice || null,
        terminalNoiBasis: 'forward_12',
      },
    }),
  );

  const [showProblems, setShowProblems] = useState(false);
  const problems = {
    name: form.name.trim() ? undefined : 'Name is required.',
    modelName: form.modelName.trim() ? undefined : 'Model name is required.',
    valuationDate: form.valuationDate ? undefined : 'Valuation date is required.',
    forecastStartDate: form.forecastStartDate ? undefined : 'Forecast start is required.',
    // Everything below used to feed `Number(value) || 0` (or `|| null`)
    // straight into the request — a typo silently became 0 or was dropped,
    // with nothing telling the person who typed it what happened.
    rentableArea: numericFieldProblem(form.rentableArea, { label: 'Rentable area', min: 0 }),
    unitCount: numericFieldProblem(form.unitCount, { label: 'Units', min: 0 }),
    forecastMonths: numericFieldProblem(form.forecastMonths, {
      label: 'Forecast months',
      required: true,
      min: 1,
    }),
    acquisitionPrice: numericFieldProblem(form.acquisitionPrice, {
      label: 'Acquisition price',
      min: 0,
    }),
    discountRate: numericFieldProblem(form.discountRate, { label: 'Discount rate', min: 0 }),
    terminalCapRate: numericFieldProblem(form.terminalCapRate, {
      label: 'Exit capitalization rate',
      min: 0,
    }),
    saleMonth: numericFieldProblem(form.saleMonth, { label: 'Sale month', min: 1 }),
    saleCostPercent: numericFieldProblem(form.saleCostPercent, {
      label: 'Costs of sale',
      required: true,
      min: 0,
    }),
  };

  async function submit(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    if (Object.values(problems).some(Boolean)) {
      setShowProblems(true);
      return;
    }
    const result = await create.run();
    if (result) navigate(`/models/${result.model.id}/assumptions`);
  }

  if (!can('property:write') || !can('model:write')) {
    return (
      <EmptyState title="You cannot start a new underwriting">
        Creating a property and a model needs both the property and model write capabilities. Ask an
        organization owner or manager to grant them, or ask them to start this one for you.
      </EmptyState>
    );
  }

  return (
    <>
      <div className="page-title">
        <div>
          <h1>New underwriting</h1>
          <p>
            Creates the property and its first model together, then opens the model's own
            assumptions so you can start entering the deal.
          </p>
        </div>
      </div>

      <form className="card" onSubmit={submit} noValidate>
        <ErrorMessage error={create.error} />

        <h2 style={{ marginTop: 0 }}>The property</h2>
        <div className="form-grid">
          <Field label="Name" {...(showProblems && problems.name ? { error: problems.name } : {})}>
            <input
              maxLength={200}
              value={form.name}
              onChange={(event) => set('name', event.target.value)}
            />
          </Field>
          <Field label="Property type">
            <select
              value={form.propertyType}
              onChange={(event) => set('propertyType', event.target.value)}
            >
              {propertyTypeEnum.options.map((option) => (
                <option key={option} value={option}>
                  {titleCase(option)}
                </option>
              ))}
            </select>
          </Field>
          <Field label="City">
            <input value={form.city} onChange={(event) => set('city', event.target.value)} />
          </Field>
          <Field label="State or region">
            <input
              value={form.stateRegion}
              onChange={(event) => set('stateRegion', event.target.value)}
            />
          </Field>
          <Field label="Market">
            <input value={form.market} onChange={(event) => set('market', event.target.value)} />
          </Field>
          <Field
            label="Rentable area"
            hint="Total rentable area in the property's area unit."
            {...(showProblems && problems.rentableArea ? { error: problems.rentableArea } : {})}
          >
            <input
              inputMode="decimal"
              value={form.rentableArea}
              onChange={(event) => set('rentableArea', event.target.value)}
            />
          </Field>
          <Field
            label="Units"
            hint="Residential, storage or parking units, where applicable."
            {...(showProblems && problems.unitCount ? { error: problems.unitCount } : {})}
          >
            <input
              inputMode="numeric"
              value={form.unitCount}
              onChange={(event) => set('unitCount', event.target.value)}
            />
          </Field>
        </div>

        <h2>The first model</h2>
        <div className="form-grid">
          <Field
            label="Model name"
            {...(showProblems && problems.modelName ? { error: problems.modelName } : {})}
          >
            <input
              maxLength={200}
              value={form.modelName}
              onChange={(event) => set('modelName', event.target.value)}
            />
          </Field>
          <Field label="Classification">
            <select
              value={form.classification}
              onChange={(event) => set('classification', event.target.value)}
            >
              {modelClassificationEnum.options.map((option) => (
                <option key={option} value={option}>
                  {titleCase(option)}
                </option>
              ))}
            </select>
          </Field>
          <Field
            label="Valuation date"
            {...(showProblems && problems.valuationDate ? { error: problems.valuationDate } : {})}
          >
            <input
              type="date"
              value={form.valuationDate}
              onChange={(event) => set('valuationDate', event.target.value)}
            />
          </Field>
          <Field
            label="Forecast start"
            hint="Coerced to the first of the month."
            {...(showProblems && problems.forecastStartDate
              ? { error: problems.forecastStartDate }
              : {})}
          >
            <input
              type="date"
              value={form.forecastStartDate}
              onChange={(event) => set('forecastStartDate', event.target.value)}
            />
          </Field>
          <Field
            label="Forecast months"
            hint="Run at least 12 months past the sale so a forward NOI is available."
            {...(showProblems && problems.forecastMonths ? { error: problems.forecastMonths } : {})}
          >
            <input
              inputMode="numeric"
              value={form.forecastMonths}
              onChange={(event) => set('forecastMonths', event.target.value)}
            />
          </Field>
          <Field
            label="Acquisition price"
            hint="Optional. Used as the going-in basis for returns."
            {...(showProblems && problems.acquisitionPrice
              ? { error: problems.acquisitionPrice }
              : {})}
          >
            <input
              inputMode="decimal"
              value={form.acquisitionPrice}
              onChange={(event) => set('acquisitionPrice', event.target.value)}
            />
          </Field>
          <Field
            label="Discount rate"
            hint="Annual effective rate as a decimal, e.g. 0.08."
            {...(showProblems && problems.discountRate ? { error: problems.discountRate } : {})}
          >
            <input
              inputMode="decimal"
              value={form.discountRate}
              onChange={(event) => set('discountRate', event.target.value)}
            />
          </Field>
          <Field
            label="Exit capitalization rate"
            hint="Decimal, e.g. 0.065."
            {...(showProblems && problems.terminalCapRate
              ? { error: problems.terminalCapRate }
              : {})}
          >
            <input
              inputMode="decimal"
              value={form.terminalCapRate}
              onChange={(event) => set('terminalCapRate', event.target.value)}
            />
          </Field>
          <Field
            label="Sale month"
            {...(showProblems && problems.saleMonth ? { error: problems.saleMonth } : {})}
          >
            <input
              inputMode="numeric"
              value={form.saleMonth}
              onChange={(event) => set('saleMonth', event.target.value)}
            />
          </Field>
          <Field
            label="Costs of sale"
            hint="Fraction of the gross sale price."
            {...(showProblems && problems.saleCostPercent
              ? { error: problems.saleCostPercent }
              : {})}
          >
            <input
              inputMode="decimal"
              value={form.saleCostPercent}
              onChange={(event) => set('saleCostPercent', event.target.value)}
            />
          </Field>
        </div>

        <div className="row end">
          <button type="submit" className="primary" disabled={create.pending}>
            {create.pending ? 'Creating…' : 'Start underwriting'}
          </button>
        </div>
      </form>
    </>
  );
}

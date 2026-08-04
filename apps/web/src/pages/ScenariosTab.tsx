import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, type Model } from '../api.js';
import { ErrorMessage, Field, Loading } from '../components.js';
import { formatCurrency, formatMultiple, formatPercent, titleCase } from '../format.js';
import { useMutation } from '../hooks.js';
import { useSession } from '../session.js';
import { useModelContext } from './ModelWorkspace.js';

const VARIABLES = [
  { value: 'terminalCapRate', label: 'Exit capitalization rate', kind: 'rate' },
  { value: 'discountRate', label: 'Discount rate', kind: 'rate' },
  { value: 'generalVacancyRate', label: 'General vacancy', kind: 'rate' },
  { value: 'creditLossRate', label: 'Credit loss', kind: 'rate' },
  { value: 'saleCostPercent', label: 'Costs of sale', kind: 'rate' },
  { value: 'directCapRate', label: 'Direct capitalization rate', kind: 'rate' },
  { value: 'acquisitionPrice', label: 'Purchase price', kind: 'currency' },
  { value: 'saleMonth', label: 'Sale month', kind: 'count' },
] as const;

const METRICS = [
  { value: 'dcfValue', label: 'Discounted cash-flow value', kind: 'currency' },
  { value: 'unleveredIrr', label: 'Unlevered IRR', kind: 'percent' },
  { value: 'leveredIrr', label: 'Levered IRR', kind: 'percent' },
  { value: 'equityMultiple', label: 'Equity multiple', kind: 'multiple' },
  { value: 'year1Noi', label: 'Year 1 net operating income', kind: 'currency' },
] as const;

interface SensitivityResponse {
  engineVersion: string;
  metric: string;
  rows: { variable: string; values: string[] };
  columns: { variable: string; values: string[] } | null;
  grid: string[][];
}

/**
 * Sensitivity analysis and model cloning.
 *
 * Every cell in the grid is a complete engine run against a modified copy of
 * the model input, not an interpolation. That is slower than approximating,
 * and it is the only way the grid tells the truth when an assumption moves a
 * lease-level outcome rather than a single line.
 */
export function ScenariosTab(): JSX.Element {
  const { model, cashFlow } = useModelContext();
  const { can } = useSession();
  const navigate = useNavigate();

  const [rowVariable, setRowVariable] = useState<string>('terminalCapRate');
  const [rowValues, setRowValues] = useState('0.055, 0.06, 0.065, 0.07, 0.075');
  const [columnVariable, setColumnVariable] = useState<string>('discountRate');
  const [useColumns, setUseColumns] = useState(true);
  const [columnValues, setColumnValues] = useState('0.07, 0.075, 0.08, 0.085');
  const [metric, setMetric] = useState<string>('dcfValue');
  const [result, setResult] = useState<SensitivityResponse | null>(null);

  const run = useMutation(async () => {
    const response = await api.post<SensitivityResponse>(`/models/${model.id}/sensitivity`, {
      rows: { variable: rowVariable, values: parseList(rowValues) },
      columns: useColumns ? { variable: columnVariable, values: parseList(columnValues) } : null,
      metric,
    });
    setResult(response);
    return response;
  });

  const clone = useMutation(async (name: string) =>
    api.post<{ model: Model }>(`/models/${model.id}/clone`, { name }),
  );

  const metricSpec = METRICS.find((entry) => entry.value === metric);
  const format = (value: string): string => {
    if (value === '') return 'Not available';
    switch (metricSpec?.kind) {
      case 'percent':
        return formatPercent(value);
      case 'multiple':
        return formatMultiple(value);
      default:
        return formatCurrency(value, cashFlow?.currency ?? model.currency, { compact: true });
    }
  };

  return (
    <>
      <div className="card">
        <h2>Clone this model</h2>
        <p className="field-hint" style={{ marginTop: 0 }}>
          A clone copies only the scenario-scoped rows: leases, assumptions, capital, debt and
          curves. The property, its buildings and its spaces are shared, so an upside case costs a
          handful of rows rather than a duplicate of the asset.
        </p>
        <ErrorMessage error={clone.error} />
        <CloneForm
          disabled={!can('model:write')}
          pending={clone.pending}
          onClone={async (name) => {
            const created = await clone.run(name);
            if (created) navigate(`/models/${created.model.id}`);
          }}
        />
      </div>

      <div className="card">
        <h2>Sensitivity analysis</h2>
        <ErrorMessage error={run.error} />
        <div className="form-grid">
          <Field label="Row variable">
            <select value={rowVariable} onChange={(event) => setRowVariable(event.target.value)}>
              {VARIABLES.map((variable) => (
                <option key={variable.value} value={variable.value}>
                  {variable.label}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Row values" hint="Comma separated, up to 15.">
            <input value={rowValues} onChange={(event) => setRowValues(event.target.value)} />
          </Field>
          <Field label="Second dimension">
            <select
              value={useColumns ? 'two' : 'one'}
              onChange={(event) => setUseColumns(event.target.value === 'two')}
            >
              <option value="one">One-way table</option>
              <option value="two">Two-way table</option>
            </select>
          </Field>
          {useColumns && (
            <>
              <Field label="Column variable">
                <select
                  value={columnVariable}
                  onChange={(event) => setColumnVariable(event.target.value)}
                >
                  {VARIABLES.map((variable) => (
                    <option key={variable.value} value={variable.value}>
                      {variable.label}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Column values" hint="Comma separated, up to 15.">
                <input
                  value={columnValues}
                  onChange={(event) => setColumnValues(event.target.value)}
                />
              </Field>
            </>
          )}
          <Field label="Metric">
            <select value={metric} onChange={(event) => setMetric(event.target.value)}>
              {METRICS.map((entry) => (
                <option key={entry.value} value={entry.value}>
                  {entry.label}
                </option>
              ))}
            </select>
          </Field>
        </div>
        <div className="row end">
          <button
            type="button"
            className="primary"
            onClick={() => void run.run()}
            disabled={run.pending || !can('model:calculate')}
          >
            {run.pending ? 'Running…' : 'Run sensitivity'}
          </button>
        </div>

        {run.pending && <Loading label="Running one full calculation per cell" />}

        {result && !run.pending && (
          <div style={{ marginTop: 16 }}>
            <div className="table-scroll">
              <table className="freeze-first">
                <caption className="visually-hidden">
                  {metricSpec?.label} sensitivity to {titleCase(result.rows.variable)}
                  {result.columns ? ` and ${titleCase(result.columns.variable)}` : ''}
                </caption>
                <thead>
                  <tr>
                    <th scope="col">
                      {VARIABLES.find((v) => v.value === result.rows.variable)?.label ??
                        titleCase(result.rows.variable)}
                    </th>
                    {(result.columns?.values ?? ['Result']).map((value) => (
                      <th key={value} scope="col" className="numeric">
                        {result.columns ? value : 'Result'}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {result.rows.values.map((rowValue, rowIndex) => (
                    <tr key={rowValue}>
                      <th scope="row">{rowValue}</th>
                      {(result.grid[rowIndex] ?? []).map((cell, cellIndex) => (
                        <td key={cellIndex} className="numeric">
                          {format(cell)}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="field-hint">
              {result.rows.values.length * (result.columns?.values.length ?? 1)} full engine runs,
              engine {result.engineVersion}. Column headers are the{' '}
              {result.columns
                ? (
                    VARIABLES.find((v) => v.value === result.columns?.variable)?.label ?? ''
                  ).toLowerCase()
                : 'single'}{' '}
              values tested.
            </p>
          </div>
        )}
      </div>
    </>
  );
}

function CloneForm({
  disabled,
  pending,
  onClone,
}: {
  disabled: boolean;
  pending: boolean;
  onClone: (name: string) => Promise<void>;
}): JSX.Element {
  const [name, setName] = useState('');
  return (
    <form
      className="row"
      onSubmit={(event) => {
        event.preventDefault();
        if (name.trim()) void onClone(name.trim());
      }}
    >
      <div style={{ flex: '1 1 280px' }}>
        <label htmlFor="clone-name">New model name</label>
        <input
          id="clone-name"
          value={name}
          placeholder="Downside case"
          onChange={(event) => setName(event.target.value)}
          disabled={disabled}
        />
      </div>
      <button
        type="submit"
        disabled={disabled || pending || !name.trim()}
        style={{ marginTop: 18 }}
      >
        {pending ? 'Cloning…' : 'Clone'}
      </button>
    </form>
  );
}

function parseList(value: string): string[] {
  return value
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry !== '');
}

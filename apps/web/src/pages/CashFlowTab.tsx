import { useEffect, useState } from 'react';
import type { CashFlowLine } from '@cre/domain-models';
import { api, type TraceResponse } from '../api.js';
import { BarChart, EmptyState, Loading } from '../components.js';
import { formatCurrency, formatMonth, formatPercent, isNegative } from '../format.js';
import { useLocalState } from '../hooks.js';
import { useModelContext } from './ModelWorkspace.js';

/**
 * The cash-flow statement.
 *
 * Line items run down, periods run across, the line column is frozen, and any
 * figure can be clicked to open the calculation inspector, which reads the
 * engine's trace for that value rather than re-deriving it in the browser.
 */

interface LineSpec {
  key: CashFlowLine;
  label: string;
  emphasis?: boolean;
  subtotal?: boolean;
  indent?: boolean;
}

const LINES: LineSpec[] = [
  { key: 'potentialBaseRent', label: 'Potential base rent' },
  { key: 'absorptionAndTurnoverVacancy', label: 'Absorption and turnover vacancy', indent: true },
  { key: 'contractualBaseRent', label: 'Contractual base rent', subtotal: true },
  { key: 'freeRent', label: 'Free rent and abatements', indent: true },
  { key: 'scheduledBaseRent', label: 'Scheduled base rent', subtotal: true },
  { key: 'percentageRent', label: 'Percentage rent' },
  { key: 'expenseRecoveries', label: 'Expense recoveries' },
  { key: 'otherLeaseRevenue', label: 'Other lease revenue' },
  { key: 'otherPropertyRevenue', label: 'Other property revenue' },
  { key: 'grossPotentialRevenue', label: 'Gross potential revenue', subtotal: true },
  { key: 'generalVacancy', label: 'General vacancy', indent: true },
  { key: 'creditLoss', label: 'Credit loss', indent: true },
  { key: 'effectiveGrossRevenue', label: 'Effective gross revenue', emphasis: true },
  { key: 'operatingExpenses', label: 'Operating expenses' },
  { key: 'netOperatingIncome', label: 'Net operating income', emphasis: true },
  { key: 'tenantImprovements', label: 'Tenant improvements', indent: true },
  { key: 'leasingCommissions', label: 'Leasing commissions', indent: true },
  { key: 'capitalExpenditures', label: 'Capital expenditures', indent: true },
  { key: 'unleveredCashFlow', label: 'Unlevered cash flow', emphasis: true },
  { key: 'debtProceeds', label: 'Debt proceeds' },
  { key: 'interestExpense', label: 'Interest expense', indent: true },
  { key: 'principalAmortization', label: 'Principal amortization', indent: true },
  { key: 'financingFees', label: 'Financing fees', indent: true },
  { key: 'grossSaleProceeds', label: 'Gross sale proceeds' },
  { key: 'sellingCosts', label: 'Costs of sale', indent: true },
  { key: 'debtPayoff', label: 'Debt payoff', indent: true },
  { key: 'leveredCashFlow', label: 'Levered cash flow', emphasis: true },
];

export function CashFlowTab(): JSX.Element {
  const { cashFlow, cashFlowError, calculate, calculating, model } = useModelContext();
  const [granularity, setGranularity] = useLocalState<'annual' | 'monthly'>(
    'cre.cashflow.granularity',
    'annual',
  );
  const [inspect, setInspect] = useState<{ line: string; period: number; label: string } | null>(
    null,
  );

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
            {calculating ? 'Calculating…' : 'Run the calculation'}
          </button>
        }
      >
        {cashFlowError}
      </EmptyState>
    );
  }
  if (!cashFlow) return <Loading label="Loading cash flow" />;

  const currency = cashFlow.currency;
  const isAnnual = granularity === 'annual';
  const columns = isAnnual
    ? cashFlow.annual.map((row) => ({
        key: String(row.fiscalYear),
        label: row.months === 12 ? `FY${row.fiscalYear}` : `FY${row.fiscalYear} (${row.months}m)`,
      }))
    : cashFlow.periods.map((period) => ({
        key: String(period.index),
        label: formatMonth(period.startDate),
      }));

  const valueAt = (line: CashFlowLine, index: number): string =>
    isAnnual
      ? (cashFlow.annual[index]?.lines[line] ?? '0')
      : (cashFlow.monthly[line]?.[index] ?? '0');

  const noiByYear = cashFlow.annual.map((row) => Number(row.lines.netOperatingIncome));
  const occupancyByYear = cashFlow.annual.map((row) => {
    const indices = cashFlow.periods
      .map((period, index) => ({ period, index }))
      .filter(({ period }) => period.fiscalYear === row.fiscalYear);
    if (indices.length === 0) return 0;
    const total = indices.reduce(
      (acc, { index }) => acc + Number(cashFlow.occupancy[index]?.physicalOccupancyPercent ?? 0),
      0,
    );
    return total / indices.length;
  });

  return (
    <>
      <div className="card">
        <div className="row" style={{ marginBottom: 12 }}>
          <div role="group" aria-label="Granularity" className="row">
            <button
              type="button"
              className={isAnnual ? 'primary' : ''}
              aria-pressed={isAnnual}
              onClick={() => setGranularity('annual')}
            >
              Annual
            </button>
            <button
              type="button"
              className={!isAnnual ? 'primary' : ''}
              aria-pressed={!isAnnual}
              onClick={() => setGranularity('monthly')}
            >
              Monthly
            </button>
          </div>
          <div className="spacer" />
          <span style={{ color: 'var(--text-muted)', fontSize: 12 }}>
            Engine {cashFlow.engineVersion} · {columns.length} periods · select any figure to see
            how it was calculated
          </span>
        </div>

        <div className="table-scroll" tabIndex={0}>
          <table className="freeze-first">
            <caption className="visually-hidden">
              {isAnnual ? 'Annual' : 'Monthly'} cash flow for {model.name}. Amounts in {currency};
              deductions are negative.
            </caption>
            <thead>
              <tr>
                <th scope="col">Line item</th>
                {columns.map((column) => (
                  <th key={column.key} scope="col" className="numeric">
                    {column.label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {LINES.map((line) => (
                <tr
                  key={line.key}
                  className={`${line.emphasis ? 'emphasis' : ''} ${line.subtotal ? 'subtotal' : ''}`}
                >
                  <th scope="row" style={{ paddingLeft: line.indent ? 24 : undefined }}>
                    {line.label}
                  </th>
                  {columns.map((column, index) => {
                    const raw = valueAt(line.key, index);
                    return (
                      <td
                        key={column.key}
                        className={`numeric ${isNegative(raw) ? 'negative' : ''}`}
                      >
                        <button
                          type="button"
                          className="cell-button"
                          onClick={() =>
                            setInspect({
                              line: line.key,
                              period: isAnnual
                                ? (cashFlow.periods.find(
                                    (period) => String(period.fiscalYear) === column.key,
                                  )?.index ?? 1)
                                : Number(column.key),
                              label: `${line.label}, ${column.label}`,
                            })
                          }
                          aria-label={`Explain ${line.label} for ${column.label}: ${formatCurrency(raw, currency)}`}
                        >
                          {formatCurrency(raw, currency)}
                        </button>
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div className="card">
        <h2>Net operating income by year</h2>
        <BarChart
          title="Net operating income by fiscal year"
          labels={cashFlow.annual.map((row) => `FY${row.fiscalYear}`)}
          values={noiByYear}
          formatValue={(value) => formatCurrency(value, currency, { compact: true })}
        />
      </div>

      <div className="card">
        <h2>Physical occupancy by year</h2>
        <BarChart
          title="Average physical occupancy by fiscal year"
          labels={cashFlow.annual.map((row) => `FY${row.fiscalYear}`)}
          values={occupancyByYear}
          formatValue={(value) => formatPercent(value, 1)}
        />
      </div>

      {inspect && (
        <CalculationInspector
          modelId={model.id}
          line={inspect.line}
          period={inspect.period}
          label={inspect.label}
          onClose={() => setInspect(null)}
        />
      )}
    </>
  );
}

/**
 * Calculation inspector.
 *
 * Reads the engine trace stored with the calculation run. Nothing is
 * recomputed here: what the panel shows is exactly what the engine recorded
 * while producing the number, including which assumption it came from.
 */
function CalculationInspector({
  modelId,
  line,
  period,
  label,
  onClose,
}: {
  modelId: string;
  line: string;
  period: number;
  label: string;
  onClose: () => void;
}): JSX.Element {
  const [state, setState] = useState<{
    loading: boolean;
    entries: TraceResponse['entries'];
    error: string | null;
  }>({ loading: true, entries: [], error: null });

  useEffect(() => {
    const query = new URLSearchParams({ periodIndex: String(period), limit: '40' });
    // Line-specific trace targets exist for the figures with a documented
    // derivation; the rest fall back to every trace entry for the period.
    const targetByLine: Record<string, string> = {
      expenseRecoveries: 'occurrence:',
      scheduledBaseRent: 'occurrence:',
      contractualBaseRent: 'occurrence:',
      potentialBaseRent: 'occurrence:',
      grossSaleProceeds: 'valuation:',
      sellingCosts: 'valuation:',
      netDispositionProceeds: 'valuation:',
    };
    const target = targetByLine[line];
    if (target) query.set('target', target);

    let cancelled = false;
    setState({ loading: true, entries: [], error: null });
    api
      .get<TraceResponse>(`/models/${modelId}/trace?${query}`)
      .then((response) => {
        if (!cancelled) setState({ loading: false, entries: response.entries, error: null });
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        setState({
          loading: false,
          entries: [],
          error:
            error instanceof Error
              ? error.message
              : 'The trace for this calculation could not be loaded.',
        });
      });
    return () => {
      cancelled = true;
    };
  }, [modelId, line, period]);

  return (
    <aside className="inspector" role="dialog" aria-label={`How ${label} was calculated`}>
      <div className="row">
        <h2 style={{ flex: 1 }}>How this was calculated</h2>
        <button type="button" onClick={onClose} aria-label="Close the calculation inspector">
          Close
        </button>
      </div>
      <p style={{ color: 'var(--text-muted)' }}>{label}</p>

      {state.loading && <Loading label="Loading the calculation trace" />}
      {state.error && (
        <div className="message warning">
          {state.error} Re-run the calculation to record a trace, then try again.
        </div>
      )}
      {!state.loading && !state.error && state.entries.length === 0 && (
        <div className="message info">
          No trace entries were recorded for this figure. Subtotals are sums of the lines above
          them; open a component line to see its derivation.
        </div>
      )}

      {state.entries.map((entry, index) => (
        <div className="trace-entry" key={`${entry.target}-${index}`}>
          <div className="row" style={{ marginBottom: 6 }}>
            <span className="badge accent">{entry.formula}</span>
            <span className="spacer" />
            <code>v{entry.formulaVersion}</code>
          </div>
          <p style={{ marginTop: 0 }}>{entry.description}</p>
          <dl>
            {Object.entries(entry.inputs).map(([key, value]) => (
              <div key={key} style={{ display: 'contents' }}>
                <dt>{key}</dt>
                <dd>{value === '' ? '—' : value}</dd>
              </div>
            ))}
            <dt>Result</dt>
            <dd>
              <strong>{entry.result}</strong>
            </dd>
            <dt>Sources</dt>
            <dd>
              <code>{entry.sources.join(', ')}</code>
            </dd>
            {entry.rounding && (
              <>
                <dt>Rounding</dt>
                <dd>{entry.rounding}</dd>
              </>
            )}
          </dl>
        </div>
      ))}
    </aside>
  );
}

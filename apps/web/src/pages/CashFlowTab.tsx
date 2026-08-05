import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
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

/**
 * Fixed width of a period column, in pixels.
 *
 * Fixed rather than measured because virtualisation needs to know where a
 * column is without rendering it. The value is applied by the same constant
 * that does the arithmetic, so the two cannot drift.
 */
const COLUMN_WIDTH = 104;

/** Below this many columns, everything is rendered and nothing is measured. */
const VIRTUALISE_ABOVE = 24;

/**
 * Columns rendered beyond each edge of the viewport.
 *
 * Enough that a scroll of a screen's width never shows an empty gap before
 * React has re-rendered, and small enough that the saving is real.
 */
const OVERSCAN = 6;

/**
 * Which columns are worth putting in the DOM.
 *
 * A ten-year monthly forecast is 121 columns across 27 line items, and every
 * figure is a button so it can be opened in the inspector: 3,240 interactive
 * elements. Measured with `pnpm profile:grid`, switching to that view took a
 * median of 429 ms — well past the point an interaction stops feeling
 * immediate — against 163 ms for the annual view's 270 cells.
 *
 * Below `VIRTUALISE_ABOVE` columns this returns everything, so the annual view
 * and every small model keep exactly the behaviour they had.
 */
function useVisibleColumns(
  total: number,
  scroller: React.RefObject<HTMLDivElement>,
): { from: number; to: number } {
  const [range, setRange] = useState({ from: 0, to: total });

  const measure = useCallback(() => {
    const element = scroller.current;
    if (!element || total <= VIRTUALISE_ABOVE) {
      setRange({ from: 0, to: total });
      return;
    }
    // The first column is frozen and always rendered, so the scrollable region
    // starts after it.
    const scrolled = Math.max(0, element.scrollLeft - COLUMN_WIDTH);
    const first = Math.max(0, Math.floor(scrolled / COLUMN_WIDTH) - OVERSCAN);
    const visible = Math.ceil(element.clientWidth / COLUMN_WIDTH) + OVERSCAN * 2;
    setRange({ from: first, to: Math.min(total, first + visible) });
  }, [scroller, total]);

  // Before paint, so the first frame is already correct rather than showing
  // every column once and then collapsing.
  useLayoutEffect(measure, [measure]);

  useEffect(() => {
    const element = scroller.current;
    if (!element) return;
    element.addEventListener('scroll', measure, { passive: true });
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => {
      element.removeEventListener('scroll', measure);
      observer.disconnect();
    };
  }, [measure, scroller]);

  return range;
}

export function CashFlowTab(): JSX.Element {
  const { cashFlow, cashFlowError, calculate, calculating, model } = useModelContext();
  const [granularity, setGranularity] = useLocalState<'annual' | 'monthly'>(
    'cre.cashflow.granularity',
    'annual',
  );
  const [inspect, setInspect] = useState<{ line: string; period: number; label: string } | null>(
    null,
  );
  const scroller = useRef<HTMLDivElement>(null);
  // Counted before the early returns below, because a hook cannot be called
  // conditionally. Zero while the cash flow is still loading, which is the
  // right answer: there is nothing to show yet.
  const totalColumns = cashFlow
    ? granularity === 'annual'
      ? cashFlow.annual.length
      : cashFlow.periods.length
    : 0;
  const visibleRange = useVisibleColumns(totalColumns, scroller);

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

  // Only the columns near the viewport are put in the DOM; the rest are
  // represented by a spacer of the width they would have occupied, so the
  // scrollbar and the frozen first column behave exactly as before.
  const { from, to } = visibleRange;
  const visible = columns.slice(from, to);
  const leadingWidth = from * COLUMN_WIDTH;
  const trailingWidth = Math.max(0, columns.length - to) * COLUMN_WIDTH;

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

        <div className="table-scroll" tabIndex={0} ref={scroller}>
          {/*
            `aria-colcount` reports the real width of the table even though only
            part of it is in the DOM, and every rendered cell carries its true
            `aria-colindex`. Without those a screen reader would be told the
            forecast is thirty months long when it is a hundred and twenty.
          */}
          <table className="freeze-first" aria-colcount={columns.length + 1}>
            <caption className="visually-hidden">
              {isAnnual ? 'Annual' : 'Monthly'} cash flow for {model.name}. Amounts in {currency};
              deductions are negative.
            </caption>
            <thead>
              <tr>
                <th scope="col" aria-colindex={1}>
                  Line item
                </th>
                {leadingWidth > 0 && <th aria-hidden="true" style={{ width: leadingWidth }} />}
                {visible.map((column, offset) => (
                  <th
                    key={column.key}
                    scope="col"
                    className="numeric"
                    aria-colindex={from + offset + 2}
                    style={{ width: COLUMN_WIDTH, minWidth: COLUMN_WIDTH }}
                  >
                    {column.label}
                  </th>
                ))}
                {trailingWidth > 0 && <th aria-hidden="true" style={{ width: trailingWidth }} />}
              </tr>
            </thead>
            <tbody>
              {LINES.map((line) => (
                <tr
                  key={line.key}
                  className={`${line.emphasis ? 'emphasis' : ''} ${line.subtotal ? 'subtotal' : ''}`}
                >
                  <th
                    scope="row"
                    aria-colindex={1}
                    style={{ paddingLeft: line.indent ? 24 : undefined }}
                  >
                    {line.label}
                  </th>
                  {leadingWidth > 0 && <td aria-hidden="true" style={{ width: leadingWidth }} />}
                  {visible.map((column, offset) => {
                    const index = from + offset;
                    const raw = valueAt(line.key, index);
                    return (
                      <td
                        key={column.key}
                        aria-colindex={index + 2}
                        className={`numeric ${isNegative(raw) ? 'negative' : ''}`}
                        style={{ width: COLUMN_WIDTH, minWidth: COLUMN_WIDTH }}
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
                  {trailingWidth > 0 && <td aria-hidden="true" style={{ width: trailingWidth }} />}
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

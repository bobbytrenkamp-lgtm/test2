import { EmptyState, Loading } from '../components.js';
import { formatCurrency, formatMonth, formatMultiple, formatPercent, titleCase } from '../format.js';
import { useModelContext } from './ModelWorkspace.js';

/**
 * Returns, valuation conclusions, debt schedules and partner distributions.
 *
 * A metric that the model lacks the inputs for reads "Not available" rather
 * than zero: a missing purchase price should not silently become a 0% return.
 */
export function ReturnsTab(): JSX.Element {
  const { cashFlow, cashFlowError, calculate, calculating, model } = useModelContext();

  if (cashFlowError) {
    return (
      <EmptyState
        title="Not calculated yet"
        action={
          <button type="button" className="primary" onClick={() => void calculate(true)} disabled={calculating}>
            Run the calculation
          </button>
        }
      >
        {cashFlowError}
      </EmptyState>
    );
  }
  if (!cashFlow) return <Loading label="Loading returns" />;

  const { returns, valuations, debtSchedules, waterfall, currency, areaUnit } = cashFlow;

  return (
    <>
      <div className="card">
        <h2>Return metrics</h2>
        <dl className="metric-grid">
          <Metric label="Unlevered IRR" value={formatPercent(returns.unleveredIrr)} note="Annual effective" />
          <Metric label="Levered IRR" value={formatPercent(returns.leveredIrr)} note="Annual effective" />
          <Metric label="Equity multiple" value={formatMultiple(returns.equityMultiple)} />
          <Metric
            label="Net present value"
            value={formatCurrency(returns.netPresentValue, currency, { compact: true })}
            note="Unlevered, at the model discount rate"
          />
          <Metric label="Going-in cap rate" value={formatPercent(returns.goingInCapRate)} />
          <Metric label="Exit cap rate" value={formatPercent(returns.exitCapRate)} />
          <Metric label="Yield on cost" value={formatPercent(returns.yieldOnCost)} />
          <Metric label="Minimum DSCR" value={formatFixed(returns.minimumDscr)} />
          <Metric label="Year 1 debt yield" value={formatPercent(returns.debtYieldYear1)} />
          <Metric label="Loan to value" value={formatPercent(returns.loanToValue)} note="At closing" />
          <Metric label="Breakeven occupancy" value={formatPercent(returns.breakevenOccupancy)} />
          <Metric
            label={`Value per ${areaUnit}`}
            value={formatCurrency(returns.valuePerArea, currency, { decimals: 2 })}
          />
        </dl>
        <p className="field-hint">
          XIRR on actual dates: unlevered {formatPercent(returns.unleveredXirr)}, levered{' '}
          {formatPercent(returns.leveredXirr)}. XIRR uses actual day counts on a 365-day year, so it
          differs slightly from the monthly IRR above.
        </p>
      </div>

      <div className="card">
        <h2>Valuation conclusions</h2>
        {valuations.length === 0 ? (
          <div className="message warning">
            No valuation method produced a result. Check that a discount rate and an exit
            capitalization rate (or a gross sale price override) are set.
          </div>
        ) : (
          valuations.map((valuation) => (
            <div key={valuation.method} style={{ marginBottom: 20 }}>
              <div className="row" style={{ marginBottom: 8 }}>
                <h3 style={{ margin: 0 }}>
                  {valuation.method === 'dcf' ? 'Discounted cash flow' : 'Direct capitalization'}
                </h3>
                <span className="badge accent">
                  {formatCurrency(valuation.value, currency)}
                </span>
              </div>
              <div className="table-scroll" style={{ maxHeight: 320 }}>
                <table>
                  <caption className="visually-hidden">
                    {valuation.method} inputs and intermediate results
                  </caption>
                  <thead>
                    <tr>
                      <th scope="col">Input or result</th>
                      <th scope="col" className="numeric">
                        Value
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {Object.entries(valuation.detail).map(([key, value]) => (
                      <tr key={key}>
                        <th scope="row">{titleCase(key)}</th>
                        <td className="numeric">{value}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          ))
        )}
      </div>

      {debtSchedules.length > 0 && (
        <div className="card">
          <h2>Debt schedules</h2>
          {debtSchedules.map((schedule) => {
            const active = schedule.rows.filter(
              (row) =>
                Number(row.beginningBalance) !== 0 ||
                Number(row.draws) !== 0 ||
                Number(row.endingBalance) !== 0,
            );
            return (
              <div key={schedule.facilityId} style={{ marginBottom: 20 }}>
                <div className="row" style={{ marginBottom: 8 }}>
                  <h3 style={{ margin: 0 }}>{schedule.facilityName}</h3>
                  {schedule.covenantBreaches.length > 0 && (
                    <span className="badge negative">
                      {schedule.covenantBreaches.length} covenant breach
                      {schedule.covenantBreaches.length === 1 ? '' : 'es'}
                    </span>
                  )}
                </div>
                {schedule.covenantBreaches.length > 0 && (
                  <div className="message warning">
                    First breach: {titleCase(schedule.covenantBreaches[0]?.covenant ?? '')} in month{' '}
                    {schedule.covenantBreaches[0]?.periodIndex} — value{' '}
                    {Number(schedule.covenantBreaches[0]?.value).toFixed(4)} against a limit of{' '}
                    {Number(schedule.covenantBreaches[0]?.limit).toFixed(4)}.
                  </div>
                )}
                <div className="table-scroll" style={{ maxHeight: 380 }}>
                  <table>
                    <caption className="visually-hidden">{schedule.facilityName} schedule</caption>
                    <thead>
                      <tr>
                        <th scope="col">Month</th>
                        <th scope="col" className="numeric">Opening</th>
                        <th scope="col" className="numeric">Draws</th>
                        <th scope="col" className="numeric">Cash interest</th>
                        <th scope="col" className="numeric">Capitalized</th>
                        <th scope="col" className="numeric">Principal</th>
                        <th scope="col" className="numeric">Fees</th>
                        <th scope="col" className="numeric">Closing</th>
                        <th scope="col" className="numeric">Rate</th>
                        <th scope="col" className="numeric">DSCR</th>
                      </tr>
                    </thead>
                    <tbody>
                      {active.map((row) => (
                        <tr key={row.periodIndex}>
                          <th scope="row">
                            {formatMonth(cashFlow.periods[row.periodIndex - 1]?.startDate)}
                          </th>
                          <td className="numeric">{formatCurrency(row.beginningBalance, currency)}</td>
                          <td className="numeric">{formatCurrency(row.draws, currency)}</td>
                          <td className="numeric">{formatCurrency(row.cashInterest, currency)}</td>
                          <td className="numeric">{formatCurrency(row.capitalizedInterest, currency)}</td>
                          <td className="numeric">{formatCurrency(row.principal, currency)}</td>
                          <td className="numeric">{formatCurrency(row.fees, currency)}</td>
                          <td className="numeric">{formatCurrency(row.endingBalance, currency)}</td>
                          <td className="numeric">{formatPercent(row.appliedRate, 3)}</td>
                          <td className="numeric">{formatFixed(row.dscr)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {waterfall.length > 0 && (
        <div className="card">
          <h2>Partner distributions</h2>
          <p className="field-hint" style={{ marginTop: 0 }}>
            Preferred-return and IRR-hurdle tiers accrue on unreturned capital and are satisfied
            when that balance is paid to zero. Amounts by tier show where each partner's cash came
            from.
          </p>
          <div className="table-scroll">
            <table>
              <caption className="visually-hidden">Partner-level distributions and returns</caption>
              <thead>
                <tr>
                  <th scope="col">Partner</th>
                  <th scope="col" className="numeric">Contributions</th>
                  <th scope="col" className="numeric">Distributions</th>
                  <th scope="col" className="numeric">Profit</th>
                  <th scope="col" className="numeric">IRR</th>
                  <th scope="col" className="numeric">Multiple</th>
                  {waterfall[0]?.byTier.map((tier) => (
                    <th key={tier.tierId} scope="col" className="numeric">
                      {tier.tierName}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {waterfall.map((partner) => (
                  <tr key={partner.partnerId}>
                    <th scope="row">{partner.partnerName}</th>
                    <td className="numeric">{formatCurrency(partner.contributions, currency)}</td>
                    <td className="numeric">{formatCurrency(partner.distributions, currency)}</td>
                    <td className="numeric">{formatCurrency(partner.profit, currency)}</td>
                    <td className="numeric">{formatPercent(partner.irr)}</td>
                    <td className="numeric">{formatMultiple(partner.equityMultiple)}</td>
                    {partner.byTier.map((tier) => (
                      <td key={tier.tierId} className="numeric">
                        {formatCurrency(tier.amount, currency)}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {debtSchedules.length === 0 && waterfall.length === 0 && (
        <div className="message info">
          This model has no debt facilities and no partnership structure, so the returns above are
          unlevered and undistributed. Add a facility on the Assumptions tab to model leverage.
        </div>
      )}

      <p className="field-hint">
        Calculated by engine {cashFlow.engineVersion} for {model.name}.
      </p>
    </>
  );
}

function Metric({
  label,
  value,
  note,
}: {
  label: string;
  value: string;
  note?: string;
}): JSX.Element {
  return (
    <div className="metric">
      <dt>{label}</dt>
      <dd>{value === '—' ? <span style={{ fontSize: 14, fontWeight: 500 }}>Not available</span> : value}</dd>
      {note && <div className="metric-note">{note}</div>}
    </div>
  );
}

function formatFixed(value: string | null | undefined, decimals = 2): string {
  if (value === null || value === undefined || value === '') return '—';
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric.toFixed(decimals) : '—';
}

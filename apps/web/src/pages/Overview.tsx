import { useState } from 'react';
import { Link } from 'react-router-dom';
import type { PortfolioSummary, Property } from '../api.js';
import { BarChart, EmptyState, ErrorMessage, Loading, StatusBadge } from '../components.js';
import { formatCurrency, formatDateTime, formatMultiple, formatNumber, formatPercent, titleCase } from '../format.js';
import { useResource } from '../hooks.js';

/** Organization dashboard. */
export function DashboardPage(): JSX.Element {
  const properties = useResource<{ properties: Property[]; total: number }>('/properties?limit=200');
  const portfolios = useResource<{ portfolios: PortfolioSummary[] }>('/portfolios');

  if (properties.loading) return <Loading label="Loading dashboard" />;

  const rows = properties.data?.properties ?? [];
  const byType = new Map<string, number>();
  for (const property of rows) {
    byType.set(property.property_type, (byType.get(property.property_type) ?? 0) + 1);
  }
  const totalArea = rows.reduce((acc, property) => acc + Number(property.rentable_area ?? 0), 0);
  const totalBasis = rows.reduce((acc, property) => acc + Number(property.acquisition_price ?? 0), 0);

  return (
    <>
      <div className="page-title">
        <div>
          <h1>Dashboard</h1>
          <p>Portfolio and asset overview for the organization you are signed in to.</p>
        </div>
      </div>

      <ErrorMessage error={properties.error} />

      {rows.length === 0 ? (
        <EmptyState
          title="Nothing here yet"
          action={
            <Link className="button" to="/properties">
              Go to properties
            </Link>
          }
        >
          Create a property, or run <code>pnpm db:seed</code> to load the fictional demonstration
          portfolio.
        </EmptyState>
      ) : (
        <>
          <dl className="metric-grid" style={{ marginBottom: 16 }}>
            <div className="metric">
              <dt>Properties</dt>
              <dd>{properties.data?.total ?? rows.length}</dd>
            </div>
            <div className="metric">
              <dt>Rentable area</dt>
              <dd>{formatNumber(totalArea, 0)}</dd>
              <div className="metric-note">Across all assets</div>
            </div>
            <div className="metric">
              <dt>Acquisition basis</dt>
              <dd>{formatCurrency(totalBasis, 'USD', { compact: true })}</dd>
              <div className="metric-note">Sum of stated purchase prices</div>
            </div>
            <div className="metric">
              <dt>Portfolios</dt>
              <dd>{portfolios.data?.portfolios.length ?? 0}</dd>
            </div>
          </dl>

          <div className="card">
            <h2>Assets by property type</h2>
            <BarChart
              title="Number of properties by type"
              labels={[...byType.keys()].map(titleCase)}
              values={[...byType.values()]}
              formatValue={(value) => String(Math.round(value))}
            />
          </div>

          <div className="card">
            <h2>Recently updated properties</h2>
            <div className="table-scroll" style={{ maxHeight: 400 }}>
              <table>
                <caption className="visually-hidden">Properties</caption>
                <thead>
                  <tr>
                    <th scope="col">Property</th>
                    <th scope="col">Type</th>
                    <th scope="col">Market</th>
                    <th scope="col" className="numeric">
                      Area
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {rows.slice(0, 12).map((property) => (
                    <tr key={property.id}>
                      <th scope="row">
                        <Link to={`/properties/${property.id}`}>{property.name}</Link>
                      </th>
                      <td>
                        <StatusBadge status={property.property_type} />
                      </td>
                      <td>{property.market ?? '—'}</td>
                      <td className="numeric">{formatNumber(property.rentable_area, 0)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}
    </>
  );
}

interface AggregateResponse {
  portfolio: { id: string; name: string };
  aggregate: {
    propertyCount: number;
    grossAssetValue: string;
    netAssetValue: string;
    totalDebt: string;
    totalRentableArea: string;
    year1NetOperatingIncome: string;
    weightedGoingInCapRate: string | null;
    weightedDiscountRate: string | null;
    physicalOccupancy: string | null;
    loanToValue: string | null;
    portfolioUnleveredIrr: string | null;
    portfolioLeveredIrr: string | null;
    portfolioEquityMultiple: string | null;
    byPropertyType: Array<{ key: string; value: string; share: string }>;
    byMarket: Array<{ key: string; value: string; share: string }>;
    tenantConcentration: Array<{ tenantName: string; annualRent: string; share: string }>;
    leaseExpirationByYear: Array<{ fiscalYear: number; expiringArea: string; expiringRent: string }>;
    debtMaturityByYear: Array<{ fiscalYear: number; balance: string }>;
  };
  included: Array<{ propertyId: string; propertyName: string; ownershipPercent: string }>;
  excluded: Array<{ propertyId: string; propertyName: string; reason: string }>;
}

export function PortfoliosPage(): JSX.Element {
  const portfolios = useResource<{ portfolios: PortfolioSummary[] }>('/portfolios');
  const [selected, setSelected] = useState<string | null>(null);
  const aggregate = useResource<AggregateResponse>(
    selected ? `/portfolios/${selected}/aggregate` : null,
  );

  return (
    <>
      <div className="page-title">
        <div>
          <h1>Portfolios</h1>
          <p>
            Roll-ups are ownership-weighted. Rates are rebuilt from portfolio numerators and
            denominators, and the portfolio IRR is solved from combined cash flows rather than
            averaged from property returns.
          </p>
        </div>
      </div>

      <ErrorMessage error={portfolios.error} />
      {portfolios.loading && <Loading label="Loading portfolios" />}

      {portfolios.data && portfolios.data.portfolios.length === 0 && (
        <EmptyState title="No portfolios">
          Create a portfolio to group assets for reporting and aggregation.
        </EmptyState>
      )}

      {portfolios.data && portfolios.data.portfolios.length > 0 && (
        <div className="card">
          <div className="table-scroll">
            <table>
              <caption className="visually-hidden">Portfolios</caption>
              <thead>
                <tr>
                  <th scope="col">Portfolio</th>
                  <th scope="col">Strategy</th>
                  <th scope="col" className="numeric">
                    Properties
                  </th>
                  <th scope="col">Aggregate</th>
                </tr>
              </thead>
              <tbody>
                {portfolios.data.portfolios.map((portfolio) => (
                  <tr key={portfolio.id}>
                    <th scope="row">{portfolio.name}</th>
                    <td>{portfolio.strategy ?? '—'}</td>
                    <td className="numeric">{portfolio.property_count}</td>
                    <td>
                      <button
                        type="button"
                        className="subtle"
                        onClick={() => setSelected(portfolio.id)}
                      >
                        Roll up
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {selected && aggregate.loading && <Loading label="Aggregating the portfolio" />}
      {selected && aggregate.error && (
        <div className="message warning">
          {aggregate.error.message}
          {Array.isArray((aggregate.error.details as { excluded?: unknown[] })?.excluded) && (
            <ul>
              {((aggregate.error.details as { excluded: Array<{ propertyName: string; reason: string }> })
                .excluded ?? []).map((entry, index) => (
                <li key={index}>
                  {entry.propertyName}: {entry.reason}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {aggregate.data && (
        <>
          <div className="card">
            <h2>{aggregate.data.portfolio.name}</h2>
            <dl className="metric-grid">
              <div className="metric">
                <dt>Gross asset value</dt>
                <dd>{formatCurrency(aggregate.data.aggregate.grossAssetValue, 'USD', { compact: true })}</dd>
                <div className="metric-note">{aggregate.data.aggregate.propertyCount} assets</div>
              </div>
              <div className="metric">
                <dt>Net asset value</dt>
                <dd>{formatCurrency(aggregate.data.aggregate.netAssetValue, 'USD', { compact: true })}</dd>
              </div>
              <div className="metric">
                <dt>Debt</dt>
                <dd>{formatCurrency(aggregate.data.aggregate.totalDebt, 'USD', { compact: true })}</dd>
                <div className="metric-note">
                  LTV {formatPercent(aggregate.data.aggregate.loanToValue)}
                </div>
              </div>
              <div className="metric">
                <dt>Year 1 NOI</dt>
                <dd>
                  {formatCurrency(aggregate.data.aggregate.year1NetOperatingIncome, 'USD', {
                    compact: true,
                  })}
                </dd>
              </div>
              <div className="metric">
                <dt>Going-in cap rate</dt>
                <dd>{formatPercent(aggregate.data.aggregate.weightedGoingInCapRate)}</dd>
                <div className="metric-note">NOI over value, not an average</div>
              </div>
              <div className="metric">
                <dt>Physical occupancy</dt>
                <dd>{formatPercent(aggregate.data.aggregate.physicalOccupancy)}</dd>
              </div>
              <div className="metric">
                <dt>Portfolio unlevered IRR</dt>
                <dd>{formatPercent(aggregate.data.aggregate.portfolioUnleveredIrr)}</dd>
                <div className="metric-note">From combined cash flows</div>
              </div>
              <div className="metric">
                <dt>Portfolio equity multiple</dt>
                <dd>{formatMultiple(aggregate.data.aggregate.portfolioEquityMultiple)}</dd>
              </div>
            </dl>

            {aggregate.data.excluded.length > 0 && (
              <div className="message warning">
                {aggregate.data.excluded.length} propert
                {aggregate.data.excluded.length === 1 ? 'y was' : 'ies were'} excluded from this
                roll-up and counted as nothing rather than as zero:
                <ul>
                  {aggregate.data.excluded.map((entry) => (
                    <li key={entry.propertyId}>
                      {entry.propertyName} — {entry.reason}
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>

          <div className="card">
            <h2>Allocation by property type</h2>
            <BarChart
              title="Gross asset value by property type"
              labels={aggregate.data.aggregate.byPropertyType.map((entry) => titleCase(entry.key))}
              values={aggregate.data.aggregate.byPropertyType.map((entry) => Number(entry.value))}
              formatValue={(value) => formatCurrency(value, 'USD', { compact: true })}
            />
          </div>

          {aggregate.data.aggregate.leaseExpirationByYear.length > 0 && (
            <div className="card">
              <h2>Lease expiration exposure</h2>
              <BarChart
                title="Expiring rent by fiscal year"
                labels={aggregate.data.aggregate.leaseExpirationByYear.map((entry) =>
                  String(entry.fiscalYear),
                )}
                values={aggregate.data.aggregate.leaseExpirationByYear.map((entry) =>
                  Number(entry.expiringRent),
                )}
                formatValue={(value) => formatCurrency(value, 'USD', { compact: true })}
              />
            </div>
          )}

          {aggregate.data.aggregate.tenantConcentration.length > 0 && (
            <div className="card">
              <h2>Tenant concentration</h2>
              <div className="table-scroll" style={{ maxHeight: 320 }}>
                <table>
                  <caption className="visually-hidden">Tenant concentration by year-one rent</caption>
                  <thead>
                    <tr>
                      <th scope="col">Tenant</th>
                      <th scope="col" className="numeric">
                        Year 1 base rent
                      </th>
                      <th scope="col" className="numeric">
                        Share
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {aggregate.data.aggregate.tenantConcentration.map((entry) => (
                      <tr key={entry.tenantName}>
                        <th scope="row">{entry.tenantName}</th>
                        <td className="numeric">{formatCurrency(entry.annualRent, 'USD')}</td>
                        <td className="numeric">{formatPercent(entry.share)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </>
      )}
    </>
  );
}

export function JobsPage(): JSX.Element {
  const jobs = useResource<{
    jobs: Array<{
      id: string;
      kind: string;
      status: string;
      attempts: number;
      max_attempts: number;
      error_message: string | null;
      created_at: string;
      completed_at: string | null;
    }>;
  }>('/jobs');

  return (
    <>
      <div className="page-title">
        <div>
          <h1>Tasks and jobs</h1>
          <p>Background work: queued calculations, scenario batches, exports and roll-ups.</p>
        </div>
        <button type="button" onClick={jobs.reload}>
          Refresh
        </button>
      </div>

      <ErrorMessage error={jobs.error} />
      {jobs.loading && <Loading label="Loading jobs" />}

      {jobs.data && jobs.data.jobs.length === 0 ? (
        <EmptyState title="No background jobs">
          Calculations run synchronously unless you queue them. Scenario batches and large exports
          are always queued.
        </EmptyState>
      ) : (
        jobs.data && (
          <div className="card">
            <div className="table-scroll">
              <table>
                <caption className="visually-hidden">Background jobs</caption>
                <thead>
                  <tr>
                    <th scope="col">Kind</th>
                    <th scope="col">Status</th>
                    <th scope="col" className="numeric">
                      Attempts
                    </th>
                    <th scope="col">Queued</th>
                    <th scope="col">Completed</th>
                    <th scope="col">Error</th>
                  </tr>
                </thead>
                <tbody>
                  {jobs.data.jobs.map((job) => (
                    <tr key={job.id}>
                      <th scope="row">{titleCase(job.kind)}</th>
                      <td>
                        <span
                          className={`badge ${
                            job.status === 'succeeded'
                              ? 'positive'
                              : job.status === 'failed'
                                ? 'negative'
                                : ''
                          }`}
                        >
                          {titleCase(job.status)}
                        </span>
                      </td>
                      <td className="numeric">
                        {job.attempts}/{job.max_attempts}
                      </td>
                      <td>{formatDateTime(job.created_at)}</td>
                      <td>{job.completed_at ? formatDateTime(job.completed_at) : '—'}</td>
                      <td style={{ whiteSpace: 'normal', maxWidth: '24rem' }}>
                        {job.error_message ?? '—'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )
      )}
    </>
  );
}

export function AuditPage(): JSX.Element {
  const audit = useResource<{
    entries: Array<{
      id: string;
      action: string;
      entity_type: string;
      entity_id: string | null;
      occurred_at: string;
      user_name: string | null;
      user_email: string | null;
      new_value: unknown;
    }>;
  }>('/audit?limit=200');

  return (
    <>
      <div className="page-title">
        <div>
          <h1>Audit history</h1>
          <p>
            Append-only record of who changed what, and when. Tenant financial detail is never
            written here wholesale; only the fields a change touched are recorded.
          </p>
        </div>
        <a className="button" href="/api/v1/audit/export" download>
          Export as NDJSON
        </a>
      </div>

      <ErrorMessage error={audit.error} />
      {audit.loading && <Loading label="Loading audit history" />}

      {audit.data && audit.data.entries.length === 0 ? (
        <EmptyState title="Nothing recorded yet">
          Audit entries appear as models, properties and leases are created and changed.
        </EmptyState>
      ) : (
        audit.data && (
          <div className="card">
            <div className="table-scroll">
              <table>
                <caption className="visually-hidden">Audit log</caption>
                <thead>
                  <tr>
                    <th scope="col">When</th>
                    <th scope="col">Who</th>
                    <th scope="col">Action</th>
                    <th scope="col">Entity</th>
                    <th scope="col">Change</th>
                  </tr>
                </thead>
                <tbody>
                  {audit.data.entries.map((entry) => (
                    <tr key={entry.id}>
                      <td>{formatDateTime(entry.occurred_at)}</td>
                      <td>{entry.user_name ?? entry.user_email ?? 'System'}</td>
                      <th scope="row">{entry.action}</th>
                      <td>
                        {titleCase(entry.entity_type)}
                        {entry.entity_id ? ` · ${entry.entity_id.slice(0, 12)}` : ''}
                      </td>
                      <td style={{ whiteSpace: 'normal', maxWidth: '28rem' }}>
                        {entry.new_value ? JSON.stringify(entry.new_value).slice(0, 160) : '—'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )
      )}
    </>
  );
}

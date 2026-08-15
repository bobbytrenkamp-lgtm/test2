import { useState } from 'react';
import { Link } from 'react-router-dom';
import type { PortfolioSummary, Property } from '../api.js';
import {
  BarChart,
  EmptyState,
  ErrorMessage,
  FavouriteButton,
  Loading,
  StatusBadge,
} from '../components.js';
import { useFavourites } from '../favourites.js';
import {
  formatCurrency,
  formatDate,
  formatDateTime,
  formatMultiple,
  formatNumber,
  formatPercent,
  titleCase,
} from '../format.js';
import { useResource } from '../hooks.js';
import { describeTarget } from './ProvenanceTab.js';
import { readRecents, type Recent } from '../recents.js';
import { useSession } from '../session.js';

/** Organization dashboard. */
export function DashboardPage(): JSX.Element {
  const properties = useResource<{ properties: Property[]; total: number }>(
    '/properties?limit=200',
  );
  const portfolios = useResource<{ portfolios: PortfolioSummary[] }>('/portfolios');

  if (properties.loading) return <Loading label="Loading dashboard" />;

  const rows = properties.data?.properties ?? [];
  const byType = new Map<string, number>();
  for (const property of rows) {
    byType.set(property.property_type, (byType.get(property.property_type) ?? 0) + 1);
  }
  const totalArea = rows.reduce((acc, property) => acc + Number(property.rentable_area ?? 0), 0);
  const totalBasis = rows.reduce(
    (acc, property) => acc + Number(property.acquisition_price ?? 0),
    0,
  );

  return (
    <>
      <div className="page-title">
        <div>
          <h1>Dashboard</h1>
          <p>Portfolio and asset overview for the organization you are signed in to.</p>
        </div>
      </div>

      <ErrorMessage error={properties.error} />

      {rows.length > 0 && <PendingDecisions />}
      {rows.length > 0 && <PinnedAndRecent />}

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
              <dd>
                {formatNumber(totalArea, 0)}
                <div className="metric-note">Across all assets</div>
              </dd>
            </div>
            <div className="metric">
              <dt>Acquisition basis</dt>
              <dd>
                {formatCurrency(totalBasis, 'USD', { compact: true })}
                <div className="metric-note">Sum of stated purchase prices</div>
              </dd>
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
            <div className="table-scroll" tabIndex={0} style={{ maxHeight: 400 }}>
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

interface PendingProposal {
  id: string;
  model_id: string;
  property_id: string;
  property_name: string;
  model_name: string;
  target: string;
  source_name: string;
  created_at: string;
}

/**
 * The other direction from `ProvenanceTab`'s per-model list: what needs
 * deciding across the whole organization, without already knowing which
 * model to open first. Read-only — deciding still only happens on a model's
 * own Provenance tab, which every row here links straight to. Self-hiding
 * when nothing is pending, the same as `PinnedAndRecent` below.
 */
function PendingDecisions(): JSX.Element | null {
  const { session } = useSession();
  const pending = useResource<{ proposals: PendingProposal[] }>(
    session?.organizationId
      ? `/organizations/${session.organizationId}/assumption-proposals/pending`
      : null,
  );

  const proposals = pending.data?.proposals ?? [];
  if (pending.loading || proposals.length === 0) return null;

  const shown = proposals.slice(0, 8);

  return (
    <div className="card" style={{ marginBottom: 16 }}>
      <div className="row" style={{ marginBottom: 8 }}>
        <h2 style={{ margin: 0 }}>Assumption decisions waiting</h2>
        <span className="badge warning">{proposals.length}</span>
      </div>
      <p className="field-hint" style={{ marginTop: 0 }}>
        Something outside these models has a view on one of their assumptions, and nobody has said
        yet whether to use it. Oldest first.
      </p>
      <ul className="pinned-list">
        {shown.map((proposal) => (
          <li key={proposal.id}>
            {/* A rotor lists every control on the page by its accessible
                name, and several pending proposals commonly land on the same
                model at once (a source reporting more than one assumption),
                which would otherwise leave two links both named "Harborview
                Tower · Valuation - 31 December 2026" with nothing to tell
                them apart. The visible text stays the short property/model
                pair; aria-label carries the one thing that actually
                distinguishes this row from a sibling on the same model. */}
            <Link
              to={`/models/${proposal.model_id}/provenance`}
              aria-label={`${proposal.property_name} · ${proposal.model_name}: ${describeTarget(proposal.target)} from ${proposal.source_name}`}
            >
              {proposal.property_name} · {proposal.model_name}
            </Link>
            <span className="field-hint">
              {' '}
              · {describeTarget(proposal.target)} from {proposal.source_name}, proposed{' '}
              {formatDateTime(proposal.created_at)}
            </span>
          </li>
        ))}
      </ul>
      {proposals.length > shown.length && (
        <p className="field-hint" style={{ marginBottom: 0 }}>
          +{proposals.length - shown.length} more waiting.
        </p>
      )}
    </div>
  );
}

/**
 * The two ways back to what somebody was actually doing, side by side.
 *
 * Deliberately kept as one glance rather than two separate cards: a favourite
 * is a decision and a recent is a trace of activity, and a reader comparing
 * them is exactly the point — "the thing I pinned last month" against "the
 * thing I opened ten minutes ago" is a useful contrast, not a redundant one.
 */
function PinnedAndRecent(): JSX.Element | null {
  const { session } = useSession();
  const { favourites, loading } = useFavourites();
  const recents: Recent[] =
    session?.user.id && session.organizationId
      ? readRecents(session.user.id, session.organizationId)
      : [];

  if (loading || (favourites.length === 0 && recents.length === 0)) return null;

  return (
    <div className="card" style={{ marginBottom: 16 }}>
      <div className="pinned-recent-grid">
        <div>
          <h2>Favourites</h2>
          {favourites.length === 0 ? (
            <p className="field-hint">
              Pin a property or model with the star beside its name to keep it here.
            </p>
          ) : (
            <ul className="pinned-list">
              {favourites.map((entry) => (
                <li key={`${entry.entity_type}-${entry.entity_id}`}>
                  <FavouriteButton
                    entityType={entry.entity_type}
                    entityId={entry.entity_id}
                    name={entry.name}
                  />
                  <Link
                    to={
                      entry.entity_type === 'property'
                        ? `/properties/${entry.entity_id}`
                        : `/models/${entry.entity_id}`
                    }
                  >
                    {entry.name}
                  </Link>
                  {entry.context && <span className="field-hint"> · {entry.context}</span>}
                </li>
              ))}
            </ul>
          )}
        </div>
        <div>
          <h2>Recently viewed</h2>
          {recents.length === 0 ? (
            <p className="field-hint">
              Properties and models you open appear here, on this device.
            </p>
          ) : (
            <ul className="pinned-list">
              {recents.map((entry) => (
                <li key={`${entry.entityType}-${entry.entityId}`}>
                  <Link
                    to={
                      entry.entityType === 'property'
                        ? `/properties/${entry.entityId}`
                        : `/models/${entry.entityId}`
                    }
                  >
                    {entry.name}
                  </Link>
                  {entry.context && <span className="field-hint"> · {entry.context}</span>}
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
      <p className="field-hint" style={{ marginTop: 12, marginBottom: 0 }}>
        Recently viewed is kept on this device only, so it can be different on your laptop and your
        desk machine; favourites follow you to wherever you sign in.
      </p>
    </div>
  );
}

interface TenantExposureResponse {
  portfolio: { id: string; name: string };
  tenants: Array<{
    tenantId: string;
    tenantName: string;
    parentCompany: string | null;
    industry: string | null;
    creditRating: string | null;
    isAnchor: boolean;
    annualBaseRent: string;
    occupiedArea: string;
    shareOfRent: string;
    shareOfArea: string;
    properties: Array<{ propertyId: string; propertyName: string }>;
    leaseCount: number;
    earliestExpiration: string | null;
  }>;
  totalAnnualBaseRent: string;
  totalOccupiedArea: string;
  propertyCount: number;
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
    leaseExpirationByYear: Array<{
      fiscalYear: number;
      expiringArea: string;
      expiringRent: string;
    }>;
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
  // Only fetched once the roll-up itself has succeeded: a portfolio with no
  // calculated property has nothing to aggregate and nothing to attribute to
  // a tenant either, and the same excluded-property message already covers it.
  const tenantExposure = useResource<TenantExposureResponse>(
    selected && aggregate.data ? `/portfolios/${selected}/tenant-exposure` : null,
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
          <div className="table-scroll" tabIndex={0}>
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
              {(
                (
                  aggregate.error.details as {
                    excluded: Array<{ propertyName: string; reason: string }>;
                  }
                ).excluded ?? []
              ).map((entry, index) => (
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
                <dd>
                  {formatCurrency(aggregate.data.aggregate.grossAssetValue, 'USD', {
                    compact: true,
                  })}
                  <div className="metric-note">{aggregate.data.aggregate.propertyCount} assets</div>
                </dd>
              </div>
              <div className="metric">
                <dt>Net asset value</dt>
                <dd>
                  {formatCurrency(aggregate.data.aggregate.netAssetValue, 'USD', { compact: true })}
                </dd>
              </div>
              <div className="metric">
                <dt>Debt</dt>
                <dd>
                  {formatCurrency(aggregate.data.aggregate.totalDebt, 'USD', { compact: true })}
                  <div className="metric-note">
                    LTV {formatPercent(aggregate.data.aggregate.loanToValue)}
                  </div>
                </dd>
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
                <dd>
                  {formatPercent(aggregate.data.aggregate.weightedGoingInCapRate)}
                  <div className="metric-note">NOI over value, not an average</div>
                </dd>
              </div>
              <div className="metric">
                <dt>Physical occupancy</dt>
                <dd>{formatPercent(aggregate.data.aggregate.physicalOccupancy)}</dd>
              </div>
              <div className="metric">
                <dt>Portfolio unlevered IRR</dt>
                <dd>
                  {formatPercent(aggregate.data.aggregate.portfolioUnleveredIrr)}
                  <div className="metric-note">From combined cash flows</div>
                </dd>
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
              <div className="table-scroll" tabIndex={0} style={{ maxHeight: 320 }}>
                <table>
                  <caption className="visually-hidden">
                    Tenant concentration by year-one rent
                  </caption>
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

          <TenantExposurePanel exposure={tenantExposure.data} loading={tenantExposure.loading} />
        </>
      )}
    </>
  );
}

/**
 * The full picture behind the "Tenant concentration" glance above: not the
 * top 20 by name, but every tenant matched by id, every property they
 * occupy, and the credit profile a reviewer actually asks about.
 *
 * A national tenant that is 8% of one asset and 8% of three others is 25%+ of
 * the portfolio's income, and that fact is invisible from any single
 * property's own rent roll — which is the reason this exists as a roll-up
 * rather than something to read off six separate screens.
 */
function TenantExposurePanel({
  exposure,
  loading,
}: {
  exposure: TenantExposureResponse | null;
  loading: boolean;
}): JSX.Element | null {
  if (loading) return <Loading label="Rolling up tenant exposure" />;
  if (!exposure || exposure.tenants.length === 0) return null;

  return (
    <div className="card">
      <h2>Tenant exposure across the portfolio</h2>
      <p className="field-hint" style={{ marginTop: 0 }}>
        Matched by tenant, not by name, and summed across every property in{' '}
        {exposure.portfolio.name}. A rollover branch the engine generated because a lease has not
        renewed yet counts as that tenant, weighted by their probability of staying; a branch
        representing whoever eventually re-lets the space if they do not is not a tenant and is left
        out.
      </p>
      <div className="table-scroll" tabIndex={0} style={{ maxHeight: 420 }}>
        <table>
          <caption className="visually-hidden">
            Tenant exposure across {exposure.propertyCount} propert
            {exposure.propertyCount === 1 ? 'y' : 'ies'}
          </caption>
          <thead>
            <tr>
              <th scope="col">Tenant</th>
              <th scope="col">Properties</th>
              <th scope="col" className="numeric">
                Leases
              </th>
              <th scope="col" className="numeric">
                Occupied area
              </th>
              <th scope="col" className="numeric">
                Year 1 base rent
              </th>
              <th scope="col" className="numeric">
                Share of rent
              </th>
              <th scope="col">Credit rating</th>
              <th scope="col">Earliest expiration</th>
            </tr>
          </thead>
          <tbody>
            {exposure.tenants.map((tenant) => (
              <tr key={tenant.tenantId}>
                <th scope="row">
                  {tenant.tenantName}
                  {tenant.isAnchor && (
                    <span className="badge accent" style={{ marginLeft: 6 }}>
                      Anchor
                    </span>
                  )}
                  {tenant.parentCompany && <div className="field-hint">{tenant.parentCompany}</div>}
                </th>
                <td>
                  {tenant.properties.map((property) => (
                    <div key={property.propertyId}>
                      <Link to={`/properties/${property.propertyId}`}>{property.propertyName}</Link>
                    </div>
                  ))}
                </td>
                <td className="numeric">{tenant.leaseCount}</td>
                <td className="numeric">{formatNumber(tenant.occupiedArea, 0)}</td>
                <td className="numeric">{formatCurrency(tenant.annualBaseRent, 'USD')}</td>
                <td className="numeric">
                  <strong>{formatPercent(tenant.shareOfRent)}</strong>
                </td>
                <td>{tenant.creditRating ?? '—'}</td>
                <td>{formatDate(tenant.earliestExpiration)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
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

  // Faults sit beside the job queue because they answer the same question — is
  // anything wrong right now — and a separate screen is one nobody opens.
  const { can } = useSession();
  const errors = useResource<{
    groups: Array<{
      fingerprint: string;
      method: string;
      route: string;
      error_name: string;
      message: string;
      occurrences: number;
      last_seen: string;
    }>;
    sinceHours: number;
  }>(can('audit:read') ? '/operations/errors?sinceHours=168' : null);

  return (
    <>
      <div className="page-title">
        <div>
          {/* Named for what it is. "Tasks" now means the asset-management
              board, and a screen of queued calculations is not that. */}
          <h1>Background jobs</h1>
          <p>Queued calculations, scenario batches, exports and roll-ups.</p>
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
            <div className="table-scroll" tabIndex={0}>
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

      {can('audit:read') && (
        <div className="card">
          <h2>Recorded faults</h2>
          <p className="field-hint" style={{ marginTop: 0 }}>
            Unhandled server failures from the last seven days, grouped so one route failing
            repeatedly reads as one problem. Scoped to this organization only. The store holds no
            request bodies, query values or session tokens — reproducing a fault needs the model,
            which is still behind the permissions it always had.
          </p>
          <ErrorMessage error={errors.error} />
          {errors.loading && <Loading label="Loading recorded faults" />}
          {errors.data && errors.data.groups.length === 0 ? (
            <EmptyState title="Nothing has failed">
              No unhandled server error has been recorded in the last seven days.
            </EmptyState>
          ) : (
            errors.data && (
              <div className="table-scroll" tabIndex={0} style={{ maxHeight: 360 }}>
                <table>
                  <caption className="visually-hidden">Recorded server faults</caption>
                  <thead>
                    <tr>
                      <th scope="col">Route</th>
                      <th scope="col">Fault</th>
                      <th scope="col" className="numeric">
                        Occurrences
                      </th>
                      <th scope="col">Last seen</th>
                    </tr>
                  </thead>
                  <tbody>
                    {errors.data.groups.map((group) => (
                      <tr key={group.fingerprint}>
                        <th scope="row">
                          {group.method} {group.route}
                        </th>
                        <td style={{ whiteSpace: 'normal', maxWidth: '28rem' }}>
                          <strong>{group.error_name}</strong>
                          <div className="field-hint">{group.message}</div>
                        </td>
                        <td className="numeric">{group.occurrences}</td>
                        <td>{formatDateTime(group.last_seen)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )
          )}
        </div>
      )}
    </>
  );
}

interface AuditEntry {
  id: string;
  action: string;
  entity_type: string;
  entity_id: string | null;
  occurred_at: string;
  user_name: string | null;
  user_email: string | null;
  new_value: unknown;
}

const AUDIT_PAGE_SIZE = 100;

export function AuditPage(): JSX.Element {
  // Pages accumulate rather than replacing one another: reading a history is a
  // scroll, not a slideshow, and losing the rows above to see the ones below
  // makes comparing two entries impossible.
  const [loaded, setLoaded] = useState<AuditEntry[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);

  const audit = useResource<{ entries: AuditEntry[]; nextCursor: string | null }>(
    `/audit?limit=${AUDIT_PAGE_SIZE}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`,
    [cursor],
  );

  // The cursor is where the last page stopped, not a position, so pages never
  // shift under a reader while new entries are being written above them.
  const entries = cursor
    ? [...loaded, ...(audit.data?.entries ?? [])]
    : (audit.data?.entries ?? []);
  const nextCursor = audit.data?.nextCursor ?? null;

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

      {audit.data && entries.length === 0 ? (
        <EmptyState title="Nothing recorded yet">
          Audit entries appear as models, properties and leases are created and changed.
        </EmptyState>
      ) : (
        audit.data && (
          <div className="card">
            <div className="table-scroll" tabIndex={0}>
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
                  {entries.map((entry) => (
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
            <div className="row" style={{ marginTop: 12 }}>
              <span className="field-hint">
                {entries.length} entr{entries.length === 1 ? 'y' : 'ies'} shown
                {nextCursor ? '' : ' · the whole history'}
              </span>
              <div className="spacer" />
              {nextCursor && (
                <button
                  type="button"
                  onClick={() => {
                    setLoaded(entries);
                    setCursor(nextCursor);
                  }}
                  disabled={audit.loading}
                >
                  {audit.loading ? 'Loading…' : 'Load older entries'}
                </button>
              )}
            </div>
          </div>
        )
      )}
    </>
  );
}

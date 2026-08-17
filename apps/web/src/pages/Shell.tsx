import { NavLink, Outlet, useLocation } from 'react-router-dom';
import type { Capability } from '@cre/domain-models';
import { useSession } from '../session.js';
import { Loading } from '../components.js';
import { SignInPage } from './SignIn.js';
import { CommandPalette } from '../components/CommandPalette.js';
import { CreateOrganizationForm } from '../components/CreateOrganizationForm.js';
import { useResource } from '../hooks.js';

/**
 * `capability` hides an item for a role that could not act on it anyway —
 * used sparingly, only for a link whose entire purpose is a write action
 * (matching the button-level gating `Properties.tsx`'s "New property" and
 * `PropertyDetail.tsx`'s "New model" already do), not for every read-only
 * destination in this list.
 */
const NAV: Array<{ to: string; label: string; end?: boolean; capability?: Capability }> = [
  { to: '/', label: 'Dashboard', end: true },
  { to: '/underwriting/new', label: 'New underwriting', capability: 'model:write' },
  { to: '/properties', label: 'Properties' },
  { to: '/portfolios', label: 'Portfolios' },
  { to: '/funds', label: 'Funds' },
  { to: '/tasks', label: 'Tasks' },
  { to: '/organization', label: 'Organization' },
  { to: '/jobs', label: 'Background jobs' },
  { to: '/audit', label: 'Audit history' },
];

/**
 * Routes reachable without an organization selected. An invitation link
 * targets a specific organization the recipient has not joined yet, so it
 * cannot sit behind the "select an organization" gate every other screen
 * does.
 */
const ORGANIZATION_OPTIONAL_PATHS = new Set(['/accept-invitation']);

export function Shell(): JSX.Element {
  const { session, loading, signOut, switchOrganization, can } = useSession();
  const location = useLocation();
  // Fetched from the public, unauthenticated health check rather than a
  // protected route, so establishing what a support conversation needs never
  // depends on the session actually being valid.
  const version = useResource<{ appVersion: string; engineVersion: string }>('/health');

  if (loading) return <Loading label="Restoring your session" />;
  if (!session) return <SignInPage />;

  const organization = session.organizations.find(
    (entry) => entry.organization_id === session.organizationId,
  );

  return (
    <div className="app-shell">
      <a className="skip-link" href="#main">
        Skip to main content
      </a>

      <div className="app-brand">
        <div>
          CREOS Underwrite
          <div style={{ fontSize: '0.65em', fontWeight: 400, color: 'var(--text-muted)' }}>
            Part of CREOS Enterprise
          </div>
        </div>
      </div>

      <header className="app-header">
        <div className="row">
          {session.organizations.length > 0 && (
            <>
              <label htmlFor="org-select" className="visually-hidden">
                Active organization
              </label>
              <select
                id="org-select"
                value={session.organizationId ?? ''}
                onChange={(event) => void switchOrganization(event.target.value)}
                style={{ width: 'auto', minWidth: 220 }}
              >
                {!session.organizationId && <option value="">Select an organization…</option>}
                {session.organizations.map((entry) => (
                  <option key={entry.organization_id} value={entry.organization_id}>
                    {entry.name}
                  </option>
                ))}
              </select>
            </>
          )}
          {organization && (
            <span className="badge accent">{organization.role.replace(/_/g, ' ')}</span>
          )}
        </div>

        <div className="row">
          <NavLink to="/security" style={{ color: 'var(--text-muted)' }}>
            {session.user.name}
          </NavLink>
          <button type="button" onClick={() => void signOut()}>
            Sign out
          </button>
        </div>
      </header>

      <nav className="app-nav" aria-label="Primary">
        {NAV.filter((item) => !item.capability || can(item.capability)).map((item) => (
          <NavLink key={item.to} to={item.to} end={item.end}>
            {item.label}
          </NavLink>
        ))}
        {version.data && (
          <div
            className="field-hint"
            style={{ marginTop: 'var(--space-4)', paddingLeft: 'var(--space-3)' }}
          >
            App {version.data.appVersion} · Engine {version.data.engineVersion}
          </div>
        )}
      </nav>

      <CommandPalette />

      <main className="app-main" id="main" tabIndex={-1}>
        {session.organizationId || ORGANIZATION_OPTIONAL_PATHS.has(location.pathname) ? (
          <Outlet />
        ) : session.organizations.length === 0 ? (
          <CreateOrganizationForm />
        ) : (
          <div className="message warning">
            Select an organization to continue. Every screen is scoped to the organization you have
            selected.
          </div>
        )}
      </main>
    </div>
  );
}

import { useState } from 'react';
import type { Role } from '@cre/domain-models';
import { api } from '../api.js';
import { EmptyState, ErrorMessage, Field, Loading, Metric, StatusBadge } from '../components.js';
import { formatDateTime, formatNumber, formatPercent, titleCase } from '../format.js';
import { useMutation, useResource } from '../hooks.js';
import { useSession } from '../session.js';

/**
 * Organization admin: one screen for what was previously reachable only
 * through separate, unlinked API calls — who belongs to this organization,
 * what they may do, and what plan governs what they can use. See
 * `docs/commercial-gap-analysis.md` Phase A item 3.
 *
 * Deliberately does not include audit export (a separate screen already
 * does that) or plan/status changes (no self-serve or admin route exists
 * yet for that — see item 6's "what remains"). Data export (below) is the
 * organization-level counterpart to audit export: everything the
 * organization owns, in one download, independent of staying a customer.
 */

interface Member {
  user_id: string;
  email: string;
  name: string;
  role: Role;
  created_at: string;
}

/** Every role a membership may hold, in the same order the server checks
 *  capabilities from — most privileged first, so the dropdown reads as a
 *  ladder rather than an arbitrary list. */
const ROLES: Role[] = [
  'organization_owner',
  'administrator',
  'portfolio_manager',
  'asset_manager',
  'acquisitions',
  'valuation',
  'analyst',
  'reviewer',
  'read_only',
];

export function OrganizationPage(): JSX.Element {
  const { session, can } = useSession();
  const orgId = session?.organizationId ?? null;
  const canManageMembers = can('member:manage');
  const canInvite = can('organization:invite');
  const canExport = can('organization:manage');

  // The list route itself requires `member:manage`, so a caller without it
  // never issues the request rather than displaying a 403 to every analyst
  // who opens this screen out of curiosity.
  const members = useResource<{ members: Member[] }>(
    orgId && canManageMembers ? `/organizations/${orgId}/members` : null,
  );

  const changeRole = useMutation(async (userId: string, role: Role) => {
    await api.patch(`/organizations/${orgId}/members/${userId}`, { role });
  });
  const remove = useMutation(async (userId: string) => {
    await api.delete(`/organizations/${orgId}/members/${userId}`);
  });

  const [inviteEmail, setInviteEmail] = useState('');
  const [inviteRole, setInviteRole] = useState<Role>('analyst');
  const [invited, setInvited] = useState<{ email: string; role: Role; token?: string } | null>(
    null,
  );
  const invite = useMutation(async (email: string, role: Role) => {
    const response = await api.post<{ id: string; token?: string }>(
      `/organizations/${orgId}/invitations`,
      { email, role },
    );
    setInvited({ email, role, token: response.token });
    setInviteEmail('');
    return response;
  });

  const organization = session?.organizations.find((entry) => entry.organization_id === orgId);
  const entitlements = session?.entitlements ?? null;

  return (
    <>
      <div className="page-title">
        <div>
          <h1>Organization</h1>
          <p>
            {organization?.name ?? 'Members, roles and plan'} — signed in as{' '}
            {organization?.role ? titleCase(organization.role) : 'member'}.
          </p>
        </div>
      </div>

      {entitlements && (
        <div className="card">
          <div className="row" style={{ marginBottom: 8 }}>
            <h2 style={{ margin: 0 }}>Plan</h2>
            <StatusBadge status={entitlements.status} />
          </div>
          <dl className="metric-grid">
            <Metric label="Plan" value={titleCase(entitlements.plan)} />
            {entitlements.status === 'trial' && entitlements.trialEndsAt && (
              <Metric label="Trial ends" value={formatDateTime(entitlements.trialEndsAt)} />
            )}
            {entitlements.maxUsers !== null && (
              <Metric label="Seat limit" value={String(entitlements.maxUsers)} />
            )}
            {entitlements.maxProperties !== null && (
              <Metric label="Property limit" value={String(entitlements.maxProperties)} />
            )}
          </dl>
          <p className="field-hint" style={{ marginBottom: 0 }}>
            {entitlements.status === 'trial'
              ? 'Every feature is available during the trial, regardless of plan.'
              : entitlements.status === 'suspended' || entitlements.status === 'cancelled'
                ? 'This organization has no active plan. Contact your account owner to restore access.'
                : `This plan includes: ${
                    entitlements.features.length > 0
                      ? entitlements.features.map(titleCase).join(', ')
                      : 'the features included with excel export, on every plan'
                  }.`}
          </p>
        </div>
      )}

      {canManageMembers && (
        <div className="card">
          <h2 style={{ marginTop: 0 }}>Members</h2>
          <ErrorMessage error={members.error} />
          <ErrorMessage error={changeRole.error} />
          <ErrorMessage error={remove.error} />
          {members.loading && <Loading label="Loading members" />}

          {members.data && (
            <div className="table-scroll" tabIndex={0}>
              <table>
                <caption className="visually-hidden">Organization members</caption>
                <thead>
                  <tr>
                    <th scope="col">Name</th>
                    <th scope="col">Email</th>
                    <th scope="col">Role</th>
                    <th scope="col">Joined</th>
                    {canManageMembers && <th scope="col">Actions</th>}
                  </tr>
                </thead>
                <tbody>
                  {members.data.members.map((member) => (
                    <tr key={member.user_id}>
                      <td>{member.name}</td>
                      <td>{member.email}</td>
                      <td>
                        {canManageMembers ? (
                          <>
                            <label htmlFor={`role-${member.user_id}`} className="visually-hidden">
                              Role for {member.name}
                            </label>
                            <select
                              id={`role-${member.user_id}`}
                              aria-label={`Role for ${member.name}`}
                              value={member.role}
                              disabled={changeRole.pending}
                              onChange={async (event) => {
                                if (
                                  await changeRole.run(member.user_id, event.target.value as Role)
                                )
                                  members.reload();
                              }}
                            >
                              {ROLES.map((role) => (
                                <option key={role} value={role}>
                                  {titleCase(role)}
                                </option>
                              ))}
                            </select>
                          </>
                        ) : (
                          titleCase(member.role)
                        )}
                      </td>
                      <td>{formatDateTime(member.created_at)}</td>
                      {canManageMembers && (
                        <td>
                          <button
                            type="button"
                            aria-label={`Remove ${member.name}`}
                            disabled={remove.pending}
                            onClick={async () => {
                              if (
                                window.confirm(`Remove "${member.name}" from this organization?`) &&
                                (await remove.run(member.user_id))
                              ) {
                                members.reload();
                              }
                            }}
                          >
                            Remove
                          </button>
                        </td>
                      )}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {orgId && can('model:write') && (
        <>
          <TemplateLibraryCard
            orgId={orgId}
            segment="growth-curve-templates"
            title="Growth curve library"
            description="Named rate paths any model in this organization can start a growth curve from. A model keeps its own copy once applied — editing or removing an entry here never changes a model that already used it."
            emptyBody="Every model still enters its own growth curves by hand until this library has something in it."
            newItemSkeleton={{ name: '', defaultRate: '0', byYear: [] }}
            columns={[
              {
                key: 'default_rate',
                label: 'Default rate',
                numeric: true,
                format: (value) => formatPercent(value as string),
              },
              {
                key: 'by_year',
                label: 'Overrides',
                numeric: true,
                format: (value) => String((value as unknown[] | null)?.length ?? 0),
              },
            ]}
          />
          <TemplateLibraryCard
            orgId={orgId}
            segment="market-leasing-profile-templates"
            title="Market leasing profile library"
            description="A firm's standard renewal probability, downtime, free rent, TI and LC assumptions, reusable across every model in this organization. Applying one seeds a new profile's fields; the model owns its own copy from that point, exactly like the growth curve library above."
            emptyBody="Every model still enters its own market leasing assumptions by hand until this library has something in it."
            newItemSkeleton={{
              name: '',
              marketRent: '0',
              marketRentBasis: 'per_area_per_year',
              renewalProbability: '0.65',
              downtimeMonths: 6,
              newFreeRentMonths: 3,
              newTiPerArea: '0',
              renewalTiPerArea: '0',
            }}
            columns={[
              {
                key: 'market_rent',
                label: 'Market rent',
                numeric: true,
                format: (value) => formatNumber(value as string),
              },
              {
                key: 'renewal_probability',
                label: 'Renewal probability',
                numeric: true,
                format: (value) => formatPercent(value as string),
              },
              {
                key: 'downtime_months',
                label: 'Downtime',
                numeric: true,
                format: (value) => formatNumber(value as string),
              },
            ]}
          />
          <TemplateLibraryCard
            orgId={orgId}
            segment="operating-expense-templates"
            title="Operating expense library"
            description="A firm's normal tax, insurance, utilities, management fee, repairs and CAM assumptions, reusable across every model in this organization. Applying one seeds a new expense's fields; the model owns its own copy from that point, exactly like the libraries above."
            emptyBody="Every model still enters its own operating expenses by hand until this library has something in it."
            newItemSkeleton={{
              name: '',
              category: 'operating',
              method: 'fixed_annual',
              amount: '0',
              recoverableShare: '0',
              variableShare: '0',
              isCapitalized: false,
            }}
            columns={[
              { key: 'category', label: 'Category' },
              {
                key: 'method',
                label: 'Method',
                format: (value) => String(value).replace(/_/g, ' '),
              },
              {
                key: 'amount',
                label: 'Amount',
                numeric: true,
                format: (value) => formatNumber(value as string),
              },
              {
                key: 'recoverable_share',
                label: 'Recoverable',
                numeric: true,
                format: (value) => formatPercent(value as string),
              },
              {
                key: 'variable_share',
                label: 'Variable',
                numeric: true,
                format: (value) => formatPercent(value as string),
              },
            ]}
          />
          <TemplateLibraryCard
            orgId={orgId}
            segment="debt-facility-templates"
            title="Debt facility library"
            description="A lender's standard rate type, fees, covenants and amortization shape, reusable across every model in this organization. Commitment, funding date and term are deal-specific and always need to be set per model — applying a template still seeds them with placeholder values the analyst is expected to change, exactly like every other field a model owns its own copy of from that point."
            emptyBody="Every model still enters its own debt facilities by hand until this library has something in it."
            newItemSkeleton={{
              name: '',
              type: 'permanent',
              commitment: '0',
              rateType: 'fixed',
              fixedRate: '0',
              termMonths: 120,
            }}
            columns={[
              { key: 'type', label: 'Type', format: (value) => titleCase(value as string) },
              {
                key: 'rate_type',
                label: 'Rate type',
                format: (value) => titleCase(value as string),
              },
              {
                key: 'fixed_rate',
                label: 'Fixed rate',
                numeric: true,
                format: (value) => formatPercent(value as string),
              },
              {
                key: 'term_months',
                label: 'Term',
                numeric: true,
                format: (value) => formatNumber(value as string),
              },
            ]}
          />
        </>
      )}

      {canInvite && (
        <div className="card">
          <h2 style={{ marginTop: 0 }}>Invite someone</h2>
          <p className="field-hint">
            No mail provider is connected in this environment, so the invitation link is shown here
            to copy and send yourself.
          </p>
          <ErrorMessage error={invite.error} />
          <form
            className="row"
            style={{ alignItems: 'flex-end' }}
            onSubmit={async (event) => {
              event.preventDefault();
              if (await invite.run(inviteEmail, inviteRole)) members.reload();
            }}
          >
            <Field label="Email">
              <input
                type="email"
                required
                value={inviteEmail}
                onChange={(event) => setInviteEmail(event.target.value)}
              />
            </Field>
            <Field label="Role">
              <select
                value={inviteRole}
                onChange={(event) => setInviteRole(event.target.value as Role)}
              >
                {ROLES.map((role) => (
                  <option key={role} value={role}>
                    {titleCase(role)}
                  </option>
                ))}
              </select>
            </Field>
            <button type="submit" className="primary" disabled={invite.pending}>
              {invite.pending ? 'Sending…' : 'Invite'}
            </button>
          </form>

          {invited && (
            <div className="message info" role="status" style={{ marginTop: 12 }}>
              Invited <strong>{invited.email}</strong> as {titleCase(invited.role)}.
              {invited.token && (
                <>
                  {' '}
                  Share this link:{' '}
                  <code>{`${window.location.origin}/accept-invitation?token=${invited.token}`}</code>
                </>
              )}
            </div>
          )}
        </div>
      )}

      {canExport && (
        <div className="card">
          <h2 style={{ marginTop: 0 }}>Data export</h2>
          <p className="field-hint">
            Every property and model this organization owns, as one downloadable, documented JSON
            file — independent of staying a customer of this platform.
          </p>
          <a className="button" href={`/api/v1/organizations/${orgId}/export`} download>
            Export everything
          </a>
        </div>
      )}
    </>
  );
}

interface TemplateColumn {
  key: string;
  label: string;
  numeric?: boolean;
  format?: (value: unknown) => string;
}

/** camelCases a row read back from the API, so the JSON draft an analyst
 *  edits matches the camelCase body every write route already expects. */
function toCamel(row: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row)) {
    out[key.replace(/_([a-z])/g, (_, letter: string) => letter.toUpperCase())] = value;
  }
  return out;
}

/**
 * An organization-scoped, code-addressable assumption library: growth
 * curves, market leasing profiles, and every reusable template family after
 * them share this exact shape (`docs/commercial-gap-analysis.md` item 13).
 * A firm's standard assumption is entered once here; a model's own "Start
 * from library" picker (`AssumptionsTab.tsx`) seeds a new row's fields from
 * it, and from that point the model owns its own copy, exactly like every
 * other assumption in this schema. Editing or deleting a library entry
 * never changes a model that already started from it — this card only ever
 * calls the organization-scoped `/organizations/:id/${segment}` routes,
 * never anything under `/models/:id/...`.
 */
function TemplateLibraryCard({
  orgId,
  segment,
  title,
  description,
  emptyBody,
  columns,
  newItemSkeleton,
}: {
  orgId: string;
  segment: string;
  title: string;
  description: string;
  emptyBody: string;
  columns: TemplateColumn[];
  newItemSkeleton: Record<string, unknown>;
}): JSX.Element {
  const templates = useResource<{ templates: Array<Record<string, unknown>> }>(
    `/organizations/${orgId}/${segment}`,
  );
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [parseError, setParseError] = useState<string | null>(null);

  const save = useMutation(async (code: string, body: Record<string, unknown>) =>
    api.put(`/organizations/${orgId}/${segment}/${encodeURIComponent(code)}`, body),
  );
  const remove = useMutation(async (code: string) =>
    api.delete(`/organizations/${orgId}/${segment}/${encodeURIComponent(code)}`),
  );

  function beginEdit(template: Record<string, unknown> | null): void {
    setParseError(null);
    if (template) {
      const {
        id: _id,
        organization_id: _organizationId,
        created_by: _createdBy,
        created_at: _createdAt,
        updated_at: _updatedAt,
        code: _code,
        ...rest
      } = template;
      setEditing(String(template.code));
      setDraft(JSON.stringify(toCamel(rest), null, 2));
    } else {
      setEditing('');
      setDraft(JSON.stringify({ code: '', ...newItemSkeleton }, null, 2));
    }
  }

  async function submit(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    let body: Record<string, unknown>;
    try {
      body = JSON.parse(draft) as Record<string, unknown>;
    } catch {
      setParseError('That is not valid JSON. Check for a missing comma or quote.');
      return;
    }
    const code = editing || String(body.code ?? '');
    if (!code) {
      setParseError(
        'A "code" is required. It is what a model’s "Start from library" picker shows.',
      );
      return;
    }
    if (await save.run(code, body)) {
      setEditing(null);
      templates.reload();
    }
  }

  return (
    <div className="card">
      <div className="row" style={{ marginBottom: 8 }}>
        <h2 style={{ margin: 0 }}>{title}</h2>
        <span className="badge">{templates.data?.templates.length ?? 0}</span>
        <div className="spacer" />
        <button type="button" aria-label={`Add to ${title}`} onClick={() => beginEdit(null)}>
          Add
        </button>
      </div>
      <p className="field-hint" style={{ marginTop: 0 }}>
        {description}
      </p>

      <ErrorMessage error={templates.error} />
      {templates.loading && <Loading label={`Loading ${title.toLowerCase()}`} />}

      {templates.data && templates.data.templates.length === 0 ? (
        <EmptyState
          title="No templates yet"
          action={
            <button
              type="button"
              className="primary"
              aria-label={`Add the first entry to ${title}`}
              onClick={() => beginEdit(null)}
            >
              Add the first one
            </button>
          }
        >
          {emptyBody}
        </EmptyState>
      ) : (
        templates.data && (
          <div className="table-scroll" tabIndex={0}>
            <table>
              <caption className="visually-hidden">{title}</caption>
              <thead>
                <tr>
                  <th scope="col">Code</th>
                  <th scope="col">Name</th>
                  {columns.map((column) => (
                    <th key={column.key} scope="col" className={column.numeric ? 'numeric' : ''}>
                      {column.label}
                    </th>
                  ))}
                  <th scope="col">Actions</th>
                </tr>
              </thead>
              <tbody>
                {templates.data.templates.map((template) => {
                  const code = String(template.code);
                  const name = String(template.name ?? code);
                  return (
                    <tr key={code}>
                      <th scope="row">{code}</th>
                      <td>{name}</td>
                      {columns.map((column) => (
                        <td key={column.key} className={column.numeric ? 'numeric' : ''}>
                          {column.format
                            ? column.format(template[column.key])
                            : String(template[column.key] ?? '—')}
                        </td>
                      ))}
                      <td>
                        <button
                          type="button"
                          className="subtle"
                          onClick={() => beginEdit(template)}
                        >
                          Edit
                        </button>
                        <button
                          type="button"
                          className="subtle"
                          disabled={remove.pending}
                          onClick={async () => {
                            if (
                              window.confirm(`Remove "${name}" from the library?`) &&
                              (await remove.run(code))
                            ) {
                              templates.reload();
                            }
                          }}
                        >
                          {remove.pending ? 'Removing…' : 'Delete'}
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )
      )}

      {editing !== null && (
        <form onSubmit={submit} style={{ marginTop: 12 }}>
          <ErrorMessage error={save.error} />
          <ErrorMessage error={remove.error} />
          <Field
            label={editing ? `Edit ${editing}` : 'New template'}
            error={parseError ?? undefined}
            hint={
              editing
                ? 'Field names use camelCase. The code itself cannot be changed here — delete and re-add to rename it.'
                : 'Field names use camelCase. "code" is the stable identifier a model’s library picker shows.'
            }
          >
            <textarea
              rows={10}
              value={draft}
              spellCheck={false}
              onChange={(event) => setDraft(event.target.value)}
              style={{ fontFamily: 'var(--font-mono)', fontSize: 12 }}
            />
          </Field>
          <div className="row">
            <button
              type="submit"
              className="primary"
              disabled={save.pending}
              aria-label={`${save.pending ? 'Saving' : 'Save'} ${title}`}
            >
              {save.pending ? 'Saving…' : 'Save'}
            </button>
            <button
              type="button"
              aria-label={`Cancel editing ${title}`}
              onClick={() => setEditing(null)}
            >
              Cancel
            </button>
          </div>
        </form>
      )}
    </div>
  );
}

import { useState } from 'react';
import type { Role } from '@cre/domain-models';
import { api } from '../api.js';
import { ErrorMessage, Field, Loading, Metric, StatusBadge } from '../components.js';
import { formatDateTime, titleCase } from '../format.js';
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
 * yet for that — see item 6's "what remains").
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
                                window.confirm(`Remove ${member.name} from this organization?`) &&
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
    </>
  );
}

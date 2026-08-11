import { randomBytes } from 'node:crypto';
import type { Role } from '@cre/domain-models';
import type { Sql } from '../client.js';
import { hashToken } from './auth.js';
import { ensureEntitlements } from './entitlements.js';

export interface OrganizationRow {
  id: string;
  name: string;
  slug: string;
  base_currency: string;
  area_unit: 'sqft' | 'sqm';
  created_at: Date;
}

export function slugify(name: string): string {
  return name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
}

/**
 * Creates an organization and makes the creator its owner in one transaction,
 * so an organization can never exist without someone able to administer it.
 */
export async function createOrganization(
  sql: Sql,
  input: { name: string; ownerId: string; baseCurrency?: string; areaUnit?: 'sqft' | 'sqm' },
): Promise<OrganizationRow> {
  return (await sql.begin(async (tx) => {
    const base = slugify(input.name) || 'organization';
    let slug = base;
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const clash =
        (await tx`SELECT 1 FROM organizations WHERE slug = ${slug}`) as unknown as unknown[];
      if (clash.length === 0) break;
      slug = `${base}-${randomBytes(3).toString('hex')}`;
    }

    const rows = (await tx`
      INSERT INTO organizations (name, slug, base_currency, area_unit)
      VALUES (${input.name.trim()}, ${slug}, ${input.baseCurrency ?? 'USD'}, ${input.areaUnit ?? 'sqft'})
      RETURNING id, name, slug, base_currency, area_unit, created_at
    `) as unknown as OrganizationRow[];
    const organization = rows[0] as OrganizationRow;

    await tx`
      INSERT INTO memberships (organization_id, user_id, role)
      VALUES (${organization.id}, ${input.ownerId}, 'organization_owner')
    `;
    // Every organization starts on a trial with full access, regardless of
    // the plan it will fall back to — see `canUseFeature` in
    // `@cre/domain-models`. Never briefly organization-without-entitlements,
    // since it runs in the same transaction as the organization itself.
    await ensureEntitlements(tx as unknown as Sql, organization.id);
    return organization;
  })) as OrganizationRow;
}

export async function getOrganization(sql: Sql, id: string): Promise<OrganizationRow | null> {
  const rows = (await sql`
    SELECT id, name, slug, base_currency, area_unit, created_at
    FROM organizations WHERE id = ${id} AND deleted_at IS NULL
  `) as unknown as OrganizationRow[];
  return rows[0] ?? null;
}

export async function listOrganizationMembers(
  sql: Sql,
  organizationId: string,
): Promise<Array<{ user_id: string; email: string; name: string; role: Role; created_at: Date }>> {
  return (await sql`
    SELECT m.user_id, u.email, u.name, m.role, m.created_at
    FROM memberships m
    JOIN users u ON u.id = m.user_id
    WHERE m.organization_id = ${organizationId}
    ORDER BY u.name
  `) as unknown as Array<{
    user_id: string;
    email: string;
    name: string;
    role: Role;
    created_at: Date;
  }>;
}

export async function setMemberRole(
  sql: Sql,
  organizationId: string,
  userId: string,
  role: Role,
): Promise<boolean> {
  return (await sql.begin(async (tx) => {
    // An organization must always retain at least one owner, otherwise nobody
    // can administer it again.
    if (role !== 'organization_owner') {
      const owners = (await tx`
        SELECT user_id FROM memberships
        WHERE organization_id = ${organizationId} AND role = 'organization_owner'
      `) as unknown as Array<{ user_id: string }>;
      if (owners.length === 1 && owners[0]?.user_id === userId) return false;
    }
    await tx`
      UPDATE memberships SET role = ${role}
      WHERE organization_id = ${organizationId} AND user_id = ${userId}
    `;
    return true;
  })) as boolean;
}

export async function removeMember(
  sql: Sql,
  organizationId: string,
  userId: string,
): Promise<boolean> {
  return (await sql.begin(async (tx) => {
    const owners = (await tx`
      SELECT user_id FROM memberships
      WHERE organization_id = ${organizationId} AND role = 'organization_owner'
    `) as unknown as Array<{ user_id: string }>;
    if (owners.length === 1 && owners[0]?.user_id === userId) return false;
    await tx`
      DELETE FROM memberships WHERE organization_id = ${organizationId} AND user_id = ${userId}
    `;
    return true;
  })) as boolean;
}

export async function createInvitation(
  sql: Sql,
  input: {
    organizationId: string;
    email: string;
    role: Role;
    invitedBy: string;
    ttlHours?: number;
  },
): Promise<{ token: string; id: string }> {
  const token = randomBytes(32).toString('base64url');
  const rows = (await sql`
    INSERT INTO organization_invitations (organization_id, email, role, token_hash, invited_by, expires_at)
    VALUES (
      ${input.organizationId}, ${input.email.trim().toLowerCase()}, ${input.role},
      ${hashToken(token)}, ${input.invitedBy},
      now() + (${input.ttlHours ?? 168} || ' hours')::interval
    )
    RETURNING id
  `) as unknown as Array<{ id: string }>;
  return { token, id: (rows[0] as { id: string }).id };
}

/**
 * Accepts an invitation for an existing user. Returns the organization joined,
 * or null when the token is unknown, expired or already used.
 */
export async function acceptInvitation(
  sql: Sql,
  token: string,
  userId: string,
): Promise<{ organizationId: string; role: Role } | null> {
  return (await sql.begin(async (tx) => {
    const rows = (await tx`
      SELECT id, organization_id, role FROM organization_invitations
      WHERE token_hash = ${hashToken(token)} AND accepted_at IS NULL AND expires_at > now()
      FOR UPDATE
    `) as unknown as Array<{ id: string; organization_id: string; role: Role }>;
    const invitation = rows[0];
    if (!invitation) return null;

    await tx`
      INSERT INTO memberships (organization_id, user_id, role)
      VALUES (${invitation.organization_id}, ${userId}, ${invitation.role})
      ON CONFLICT (organization_id, user_id) DO UPDATE SET role = EXCLUDED.role
    `;
    await tx`UPDATE organization_invitations SET accepted_at = now() WHERE id = ${invitation.id}`;
    return { organizationId: invitation.organization_id, role: invitation.role };
  })) as { organizationId: string; role: Role } | null;
}

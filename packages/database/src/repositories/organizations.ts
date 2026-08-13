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

export interface OrganizationExportExtras {
  budgetPeriods: unknown[];
  budgetEntries: unknown[];
  varianceCommentary: unknown[];
  documents: unknown[];
  modelVersions: unknown[];
  modelApprovals: unknown[];
  comments: unknown[];
  tasks: unknown[];
  portfolios: unknown[];
  portfolioProperties: unknown[];
  funds: unknown[];
  fundInvestors: unknown[];
  fundTransactions: unknown[];
  dashboards: unknown[];
  savedViews: unknown[];
  assumptionProposals: unknown[];
}

/**
 * Everything organization-owned the export document previously left out.
 *
 * Found by a thirteenth audit pass: `GET /organizations/:id/export` is
 * documented as "everything the organization owns," but only ever assembled
 * members, properties and models — budget history, uploaded documents, the
 * version/approval audit trail, comments, tasks, portfolios, and every LP
 * investor and transaction record a fund holds (among the most legally
 * sensitive data in the schema) were all silently absent, with nothing in
 * the response saying so. An organization relying on this for offboarding
 * would lose all of it.
 *
 * Every query here is scoped to `organizationId` directly where the table
 * carries that column, and by a subquery against this organization's own
 * properties/models/portfolios/funds where it does not — the same shape
 * `buildModelInput` and the rest of this file already use, never a second
 * organization's data by construction.
 */
export async function getOrganizationExportExtras(
  sql: Sql,
  organizationId: string,
): Promise<OrganizationExportExtras> {
  const [
    budgetPeriods,
    varianceCommentary,
    documents,
    modelVersions,
    modelApprovals,
    comments,
    tasks,
    portfolios,
    portfolioProperties,
    funds,
    fundInvestors,
    dashboards,
    savedViews,
    assumptionProposals,
  ] = await Promise.all([
    sql`
      SELECT id, property_id, model_id, kind, fiscal_year, label,
             approved_by, approved_at, created_at
      FROM budget_periods WHERE organization_id = ${organizationId}
    `,
    sql`
      SELECT c.id, c.property_id, c.fiscal_year, c.period_month, c.account_code,
             c.commentary, c.approved_text, c.author_id, c.approved_by, c.approved_at,
             c.created_at
      FROM variance_commentary c
      JOIN properties p ON p.id = c.property_id
      WHERE p.organization_id = ${organizationId}
    `,
    sql`
      SELECT id, property_id, model_id, filename, content_type, byte_size,
             checksum_sha256, storage_driver, scan_status, uploaded_by, created_at
      FROM documents WHERE organization_id = ${organizationId}
    `,
    sql`
      SELECT v.id, v.model_id, v.version_number, v.status, v.engine_version, v.label,
             v.notes, v.created_by, v.approved_by, v.approved_at, v.created_at
      FROM model_versions v
      JOIN models m ON m.id = v.model_id
      WHERE m.organization_id = ${organizationId}
    `,
    sql`
      SELECT a.id, a.model_id, a.model_version_id, a.from_status, a.to_status,
             a.decision, a.comment, a.actor_id, a.created_at
      FROM model_approvals a
      JOIN models m ON m.id = a.model_id
      WHERE m.organization_id = ${organizationId}
    `,
    sql`
      SELECT id, entity_type, entity_id, body, mentions, author_id, resolved_at,
             resolved_by, created_at
      FROM comments WHERE organization_id = ${organizationId}
    `,
    sql`
      SELECT id, title, description, status, due_date, property_id, model_id,
             assignee_id, created_by, created_at, completed_at
      FROM tasks WHERE organization_id = ${organizationId}
    `,
    sql`
      SELECT id, name, description, strategy, is_dynamic, filter_definition,
             created_at, updated_at
      FROM portfolios WHERE organization_id = ${organizationId} AND deleted_at IS NULL
    `,
    sql`
      SELECT pp.portfolio_id, pp.property_id, pp.ownership_percent, pp.added_at
      FROM portfolio_properties pp
      JOIN portfolios p ON p.id = pp.portfolio_id
      WHERE p.organization_id = ${organizationId}
    `,
    sql`
      SELECT id, name, vintage_year, committed_capital, currency, created_at, updated_at
      FROM funds WHERE organization_id = ${organizationId}
    `,
    sql`
      SELECT id, fund_id, code, name, investor_class, commitment, contact_email,
             notes, created_at, updated_at
      FROM fund_investors WHERE organization_id = ${organizationId}
    `,
    sql`
      SELECT id, organization_id, scope, scope_id, name, layout, owner_id, is_shared,
             created_at, updated_at
      FROM dashboards WHERE organization_id = ${organizationId}
    `,
    sql`
      SELECT id, user_id, surface, name, definition, is_shared, created_at
      FROM saved_views WHERE organization_id = ${organizationId}
    `,
    sql`
      SELECT id, model_id, target, value, source_kind, source_name, confidence,
             observed_at, status, decided_by, decided_at, created_at
      FROM assumption_proposals WHERE organization_id = ${organizationId}
    `,
  ]);

  // budget_entries and fund_transactions have no organization_id of their
  // own; scoping them requires the parent ids just fetched above.
  const budgetPeriodIds = (budgetPeriods as unknown as Array<{ id: string }>).map((r) => r.id);
  const fundInvestorIds = (fundInvestors as unknown as Array<{ id: string }>).map((r) => r.id);

  const [budgetEntries, fundTransactions] = await Promise.all([
    budgetPeriodIds.length === 0
      ? []
      : sql`
          SELECT id, budget_period_id, account_code, account_name, period_month, amount,
                 building_id, tenant_id, capital_item_id, department, commentary
          FROM budget_entries WHERE budget_period_id = ANY(${sql.array(budgetPeriodIds)}::uuid[])
        `,
    fundInvestorIds.length === 0
      ? []
      : sql`
          SELECT id, fund_id, investor_id, transaction_date, type, amount, reference,
                 notes, created_by, created_at
          FROM fund_transactions WHERE investor_id = ANY(${sql.array(fundInvestorIds)}::uuid[])
        `,
  ]);

  return {
    budgetPeriods: budgetPeriods as unknown[],
    budgetEntries: budgetEntries as unknown[],
    varianceCommentary: varianceCommentary as unknown[],
    documents: documents as unknown[],
    modelVersions: modelVersions as unknown[],
    modelApprovals: modelApprovals as unknown[],
    comments: comments as unknown[],
    tasks: tasks as unknown[],
    portfolios: portfolios as unknown[],
    portfolioProperties: portfolioProperties as unknown[],
    funds: funds as unknown[],
    fundInvestors: fundInvestors as unknown[],
    fundTransactions: fundTransactions as unknown[],
    dashboards: dashboards as unknown[],
    savedViews: savedViews as unknown[],
    assumptionProposals: assumptionProposals as unknown[],
  };
}

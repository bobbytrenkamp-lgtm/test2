import type { Sql } from '../client.js';

/**
 * Personal dashboard layouts.
 *
 * `dashboards` (migration 0004) has stood ready since this platform's first
 * release — `scope`, `layout` jsonb, `owner_id`, `is_shared` — designed for
 * more than this module writes: a dashboard shared across an organization,
 * or scoped to one portfolio/fund/property/model rather than the
 * organization as a whole. This is the personal, organization-scoped slice
 * of that design — one row per person per organization — because that is
 * the shape the dashboard screen actually has today. Widening it to a
 * shared or narrower-scoped dashboard is additive later, not a rewrite now.
 */

export interface DashboardRow {
  id: string;
  layout: unknown;
  updated_at: Date;
}

export async function getPersonalDashboard(
  sql: Sql,
  input: { organizationId: string; ownerId: string; scope: string },
): Promise<DashboardRow | null> {
  const rows = (await sql`
    SELECT id, layout, updated_at FROM dashboards
    WHERE organization_id = ${input.organizationId} AND scope = ${input.scope}
      AND owner_id = ${input.ownerId} AND scope_id IS NULL AND NOT is_shared
  `) as unknown as DashboardRow[];
  return rows[0] ?? null;
}

export async function savePersonalDashboard(
  sql: Sql,
  input: { organizationId: string; ownerId: string; scope: string; layout: unknown },
): Promise<DashboardRow> {
  const rows = (await sql`
    INSERT INTO dashboards (organization_id, scope, name, layout, owner_id)
    VALUES (${input.organizationId}, ${input.scope}, 'Personal', ${sql.json(input.layout as never)}, ${input.ownerId})
    ON CONFLICT (organization_id, scope, owner_id)
      WHERE scope_id IS NULL AND owner_id IS NOT NULL AND NOT is_shared
      DO UPDATE SET layout = EXCLUDED.layout, updated_at = now()
    RETURNING id, layout, updated_at
  `) as unknown as DashboardRow[];
  return rows[0] as DashboardRow;
}

export async function deletePersonalDashboard(
  sql: Sql,
  input: { organizationId: string; ownerId: string; scope: string },
): Promise<void> {
  await sql`
    DELETE FROM dashboards
    WHERE organization_id = ${input.organizationId} AND scope = ${input.scope}
      AND owner_id = ${input.ownerId} AND scope_id IS NULL AND NOT is_shared
  `;
}

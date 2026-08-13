import type { Sql } from '../client.js';

export interface GrowthCurveTemplateRow {
  id: string;
  organization_id: string;
  code: string;
  name: string;
  default_rate: string;
  by_year: Array<{ year: number; rate: string }>;
  created_by: string | null;
  created_at: Date;
  updated_at: Date;
}

const COLUMNS = `id, organization_id, code, name, default_rate, by_year, created_by, created_at, updated_at`;

export async function listGrowthCurveTemplates(
  sql: Sql,
  organizationId: string,
): Promise<GrowthCurveTemplateRow[]> {
  return (await sql`
    SELECT ${sql.unsafe(COLUMNS)} FROM growth_curve_templates
    WHERE organization_id = ${organizationId}
    ORDER BY code
  `) as unknown as GrowthCurveTemplateRow[];
}

export async function getGrowthCurveTemplateByCode(
  sql: Sql,
  organizationId: string,
  code: string,
): Promise<GrowthCurveTemplateRow | null> {
  const rows = (await sql`
    SELECT ${sql.unsafe(COLUMNS)} FROM growth_curve_templates
    WHERE organization_id = ${organizationId} AND code = ${code}
  `) as unknown as GrowthCurveTemplateRow[];
  return rows[0] ?? null;
}

/**
 * Creates or replaces the named template, the same code-addressable upsert
 * shape `upsertGrowthCurve` (a model's own collection) already uses — one
 * fewer id a caller has to carry, and one fewer way for a "create" and an
 * "update" path to drift apart.
 */
export async function upsertGrowthCurveTemplate(
  sql: Sql,
  input: {
    organizationId: string;
    code: string;
    name: string;
    defaultRate: string;
    byYear: Array<{ year: number; rate: string }>;
    createdBy: string;
  },
): Promise<GrowthCurveTemplateRow> {
  const rows = (await sql`
    INSERT INTO growth_curve_templates
      (organization_id, code, name, default_rate, by_year, created_by)
    VALUES (${input.organizationId}, ${input.code}, ${input.name}, ${input.defaultRate},
            ${sql.json(input.byYear as never)}, ${input.createdBy})
    ON CONFLICT (organization_id, code) DO UPDATE SET
      name = EXCLUDED.name,
      default_rate = EXCLUDED.default_rate,
      by_year = EXCLUDED.by_year,
      updated_at = now()
    RETURNING ${sql.unsafe(COLUMNS)}
  `) as unknown as GrowthCurveTemplateRow[];
  return rows[0] as GrowthCurveTemplateRow;
}

export async function deleteGrowthCurveTemplate(
  sql: Sql,
  organizationId: string,
  code: string,
): Promise<boolean> {
  const rows = (await sql`
    DELETE FROM growth_curve_templates
    WHERE organization_id = ${organizationId} AND code = ${code}
    RETURNING id
  `) as unknown as Array<{ id: string }>;
  return rows.length > 0;
}

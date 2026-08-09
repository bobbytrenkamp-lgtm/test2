import type { Sql } from '../client.js';

/**
 * Import sessions: one row per pasted extraction, grouping the proposals it
 * produced.
 *
 * Deliberately thin. Everything an analyst can actually decide about — is
 * this target changed, does this value apply, what does its evidence say —
 * lives on `assumption_proposals` already; a session exists only so a
 * provenance screen can answer "what did that Raleigh Industrial OM change"
 * without joining forty unrelated rows back together by hand. See
 * `docs/claude-assumption-import.md`.
 */
export interface ImportSessionRow {
  id: string;
  organization_id: string;
  model_id: string;
  source_system: string | null;
  source_skill: string | null;
  document_name: string | null;
  document_date: string | null;
  received_count: number;
  recognized_count: number;
  applied_count: number;
  kept_count: number;
  unresolved_count: number;
  unsupported_count: number;
  created_at: string;
  created_by: string | null;
}

const COLUMNS = `
  id, organization_id, model_id, source_system, source_skill, document_name,
  to_char(document_date, 'YYYY-MM-DD') AS document_date,
  received_count, recognized_count, applied_count, kept_count, unresolved_count, unsupported_count,
  to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS created_at,
  created_by
`;

export async function createImportSession(
  sql: Sql,
  input: {
    organizationId: string;
    modelId: string;
    sourceSystem: string | null;
    sourceSkill: string | null;
    documentName: string | null;
    documentDate: string | null;
    receivedCount: number;
    recognizedCount: number;
    appliedCount: number;
    keptCount: number;
    unresolvedCount: number;
    unsupportedCount: number;
    createdBy: string | null;
  },
): Promise<ImportSessionRow> {
  const rows = (await sql`
    INSERT INTO import_sessions (
      organization_id, model_id, source_system, source_skill, document_name, document_date,
      received_count, recognized_count, applied_count, kept_count, unresolved_count, unsupported_count,
      created_by
    ) VALUES (
      ${input.organizationId}, ${input.modelId}, ${input.sourceSystem}, ${input.sourceSkill},
      ${input.documentName}, ${input.documentDate}::date,
      ${input.receivedCount}, ${input.recognizedCount}, ${input.appliedCount}, ${input.keptCount},
      ${input.unresolvedCount}, ${input.unsupportedCount}, ${input.createdBy}
    )
    RETURNING ${sql.unsafe(COLUMNS)}
  `) as unknown as ImportSessionRow[];
  return rows[0] as ImportSessionRow;
}

export async function listImportSessions(
  sql: Sql,
  organizationId: string,
  modelId: string,
): Promise<ImportSessionRow[]> {
  return (await sql`
    SELECT ${sql.unsafe(COLUMNS)}
    FROM import_sessions
    WHERE organization_id = ${organizationId} AND model_id = ${modelId}
    ORDER BY created_at DESC
  `) as unknown as ImportSessionRow[];
}

export async function getImportSession(
  sql: Sql,
  organizationId: string,
  id: string,
): Promise<ImportSessionRow | null> {
  const rows = (await sql`
    SELECT ${sql.unsafe(COLUMNS)}
    FROM import_sessions
    WHERE id = ${id} AND organization_id = ${organizationId}
  `) as unknown as ImportSessionRow[];
  return rows[0] ?? null;
}

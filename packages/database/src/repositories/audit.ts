import type { Sql } from '../client.js';

/**
 * Audit log.
 *
 * Writes are append-only. `previous_value` and `new_value` are stored as JSON
 * so a field-level change history can be rendered without a bespoke table per
 * entity. Rent rolls and other tenant financial detail are never written here
 * wholesale: callers pass the changed fields only.
 */
export interface AuditEntry {
  organizationId: string | null;
  userId: string | null;
  action: string;
  entityType: string;
  entityId?: string | null;
  propertyId?: string | null;
  modelId?: string | null;
  previousValue?: unknown;
  newValue?: unknown;
  metadata?: Record<string, unknown>;
  ipAddress?: string | null;
}

export async function writeAudit(sql: Sql, entry: AuditEntry): Promise<void> {
  await sql`
    INSERT INTO audit_log (
      organization_id, user_id, action, entity_type, entity_id,
      property_id, model_id, previous_value, new_value, metadata, ip_address
    ) VALUES (
      ${entry.organizationId}, ${entry.userId}, ${entry.action}, ${entry.entityType},
      ${entry.entityId ?? null}, ${entry.propertyId ?? null}, ${entry.modelId ?? null},
      ${entry.previousValue === undefined ? null : sql.json(entry.previousValue as never)},
      ${entry.newValue === undefined ? null : sql.json(entry.newValue as never)},
      ${sql.json((entry.metadata ?? {}) as never)},
      ${entry.ipAddress ?? null}
    )
  `;
}

export interface AuditQuery {
  organizationId: string;
  modelId?: string;
  propertyId?: string;
  entityType?: string;
  limit?: number;
  /**
   * Where the previous page stopped, as `<occurred_at ISO>|<id>`.
   *
   * Keyset rather than offset: an audit log only ever grows, and OFFSET makes
   * PostgreSQL walk and discard every skipped row, so the hundredth page costs a
   * hundred times the first. Reading from where the last page stopped costs the
   * same every time.
   */
  cursor?: string | null;
  /**
   * Retained for callers that page by position. Ignored when `cursor` is given.
   * Prefer the cursor: offset cannot promise a stable page when rows are being
   * written while someone reads.
   */
  offset?: number;
}

export interface AuditPage {
  entries: AuditRow[];
  /** Pass back as `cursor` for the next page. Null when the end is reached. */
  nextCursor: string | null;
}

/** `occurred_at|id`, the pair the ordering is unique on. */
export function auditCursor(row: AuditRow): string {
  const occurred =
    row.occurred_at instanceof Date ? row.occurred_at.toISOString() : String(row.occurred_at);
  return `${occurred}|${row.id}`;
}

function parseCursor(cursor: string | null | undefined): { occurredAt: string; id: string } | null {
  if (!cursor) return null;
  const separator = cursor.lastIndexOf('|');
  if (separator <= 0) return null;
  const occurredAt = cursor.slice(0, separator);
  const id = cursor.slice(separator + 1);
  /*
   * A malformed cursor reads as "no cursor" rather than raising: cursors travel
   * in URLs, and a stale bookmark should show the first page, not an error page.
   *
   * Both halves are validated before they reach the query. The id is a bigint
   * sequence and the timestamp is parsed here, so a cursor that survives this
   * cannot make PostgreSQL fail a cast at run time — which is what an
   * unvalidated one did, turning a bad bookmark into a 500.
   */
  if (!occurredAt || !/^\d+$/.test(id)) return null;
  if (Number.isNaN(Date.parse(occurredAt))) return null;
  return { occurredAt, id };
}

export interface AuditRow {
  id: string;
  action: string;
  entity_type: string;
  entity_id: string | null;
  previous_value: unknown;
  new_value: unknown;
  metadata: Record<string, unknown>;
  occurred_at: Date;
  user_name: string | null;
  user_email: string | null;
}

/**
 * One page of audit history, newest first.
 *
 * The ordering is `(occurred_at DESC, id DESC)`, and the id is not decoration:
 * `occurred_at` alone is not unique, and two rows written in the same
 * millisecond would straddle a page boundary — shown twice, or skipped
 * entirely. On an audit log, a silently skipped row is the worst possible
 * defect.
 */
export async function listAuditPage(sql: Sql, query: AuditQuery): Promise<AuditPage> {
  const limit = Math.min(query.limit ?? 100, 500);
  const cursor = parseCursor(query.cursor);
  const offset = cursor ? 0 : (query.offset ?? 0);

  // One more than asked for, so the end of the history is known without a
  // second count query over a table that only grows.
  const rows = (await sql`
    SELECT a.id, a.action, a.entity_type, a.entity_id, a.previous_value, a.new_value,
           a.metadata, a.occurred_at, u.name AS user_name, u.email AS user_email
    FROM audit_log a
    LEFT JOIN users u ON u.id = a.user_id
    WHERE a.organization_id = ${query.organizationId}
      AND (${query.modelId ?? null}::uuid IS NULL OR a.model_id = ${query.modelId ?? null}::uuid)
      AND (${query.propertyId ?? null}::uuid IS NULL OR a.property_id = ${query.propertyId ?? null}::uuid)
      AND (${query.entityType ?? null}::text IS NULL OR a.entity_type = ${query.entityType ?? null}::text)
      AND (
        ${cursor?.occurredAt ?? null}::timestamptz IS NULL
        OR (a.occurred_at, a.id) < (${cursor?.occurredAt ?? null}::timestamptz, ${cursor?.id ?? null}::bigint)
      )
    ORDER BY a.occurred_at DESC, a.id DESC
    LIMIT ${limit + 1} OFFSET ${offset}
  `) as unknown as AuditRow[];

  const entries = rows.slice(0, limit);
  const last = entries[entries.length - 1];
  return {
    entries,
    nextCursor: rows.length > limit && last ? auditCursor(last) : null,
  };
}

/** The rows alone, for callers that read a bounded slice and do not page. */
export async function listAudit(sql: Sql, query: AuditQuery): Promise<AuditRow[]> {
  return (await listAuditPage(sql, query)).entries;
}

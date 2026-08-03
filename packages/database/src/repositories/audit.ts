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
  offset?: number;
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

export async function listAudit(sql: Sql, query: AuditQuery): Promise<AuditRow[]> {
  const limit = Math.min(query.limit ?? 100, 500);
  const offset = query.offset ?? 0;
  return (await sql`
    SELECT a.id, a.action, a.entity_type, a.entity_id, a.previous_value, a.new_value,
           a.metadata, a.occurred_at, u.name AS user_name, u.email AS user_email
    FROM audit_log a
    LEFT JOIN users u ON u.id = a.user_id
    WHERE a.organization_id = ${query.organizationId}
      AND (${query.modelId ?? null}::uuid IS NULL OR a.model_id = ${query.modelId ?? null}::uuid)
      AND (${query.propertyId ?? null}::uuid IS NULL OR a.property_id = ${query.propertyId ?? null}::uuid)
      AND (${query.entityType ?? null}::text IS NULL OR a.entity_type = ${query.entityType ?? null}::text)
    ORDER BY a.occurred_at DESC
    LIMIT ${limit} OFFSET ${offset}
  `) as unknown as AuditRow[];
}

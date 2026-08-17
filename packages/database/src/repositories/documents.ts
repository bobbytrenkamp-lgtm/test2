import type { Sql } from '../client.js';

/**
 * Uploaded documents.
 *
 * Every document anchors to a property — the same anchor `comments.ts`'s
 * `property` type checks against — and optionally, further, to one model
 * within that property. `storage_key` is opaque here too: this module reads
 * and writes it, but never interprets it — resolving it to actual bytes is
 * `apps/api/src/storage.ts`'s job alone.
 */

export interface DocumentRow {
  id: string;
  organization_id: string;
  property_id: string;
  model_id: string | null;
  filename: string;
  content_type: string;
  /** `bigint` — the driver returns it as a string to avoid precision loss. */
  byte_size: string;
  checksum_sha256: string;
  storage_key: string;
  storage_driver: string;
  scan_status: string;
  uploaded_by: string | null;
  uploaded_by_name: string | null;
  created_at: Date;
}

export interface CreateDocumentInput {
  organizationId: string;
  propertyId: string;
  modelId?: string | null;
  filename: string;
  contentType: string;
  byteSize: number;
  checksumSha256: string;
  storageKey: string;
  storageDriver: string;
  scanStatus: 'clean' | 'skipped';
  uploadedBy: string;
}

export async function createDocument(sql: Sql, input: CreateDocumentInput): Promise<DocumentRow> {
  const rows = (await sql`
    INSERT INTO documents (
      organization_id, property_id, model_id, filename, content_type, byte_size,
      checksum_sha256, storage_key, storage_driver, scan_status, uploaded_by
    ) VALUES (
      ${input.organizationId}, ${input.propertyId}, ${input.modelId ?? null}, ${input.filename},
      ${input.contentType}, ${input.byteSize}, ${input.checksumSha256}, ${input.storageKey},
      ${input.storageDriver}, ${input.scanStatus}, ${input.uploadedBy}
    )
    RETURNING *, NULL AS uploaded_by_name
  `) as unknown as DocumentRow[];
  return rows[0] as DocumentRow;
}

export async function listDocuments(
  sql: Sql,
  input: { organizationId: string; propertyId: string; modelId?: string },
): Promise<DocumentRow[]> {
  return (await sql`
    SELECT d.*, u.name AS uploaded_by_name
    FROM documents d
    LEFT JOIN users u ON u.id = d.uploaded_by
    WHERE d.organization_id = ${input.organizationId} AND d.property_id = ${input.propertyId}
      AND (${input.modelId ?? null}::uuid IS NULL OR d.model_id = ${input.modelId ?? null}::uuid)
    ORDER BY d.created_at DESC
  `) as unknown as DocumentRow[];
}

export async function getDocument(
  sql: Sql,
  organizationId: string,
  id: string,
): Promise<DocumentRow | null> {
  const rows = (await sql`
    SELECT d.*, u.name AS uploaded_by_name
    FROM documents d
    LEFT JOIN users u ON u.id = d.uploaded_by
    WHERE d.id = ${id} AND d.organization_id = ${organizationId}
  `) as unknown as DocumentRow[];
  return rows[0] ?? null;
}

/** Returns the deleted row (so its `storage_key` can be removed from disk), or `null`. */
export async function deleteDocument(
  sql: Sql,
  organizationId: string,
  id: string,
): Promise<DocumentRow | null> {
  const rows = (await sql`
    DELETE FROM documents WHERE id = ${id} AND organization_id = ${organizationId}
    RETURNING *
  `) as unknown as DocumentRow[];
  return rows[0] ?? null;
}

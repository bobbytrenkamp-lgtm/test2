import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  createDocument,
  deleteDocument,
  getDocument,
  getModel,
  getProperty,
  listDocuments,
  writeAudit,
} from '@cre/database';
import { badRequest, notFound, requireCapability, scanUpload } from '../context.js';

/**
 * Uploaded documents.
 *
 * `documents` (migration 0004) and `STORAGE_DRIVER` (`apps/api/src/env.ts`)
 * have existed since this platform's first release; nothing read or wrote
 * either until now. Every document anchors to a property, so "what is
 * attached to this asset" is always answerable from one place regardless of
 * which model, if any, a file is further scoped to.
 *
 * Content travels as base64 inside the JSON body, the same as every other
 * upload in this codebase (`imports.ts`'s rent-roll and workbook uploads,
 * `budgets.ts`'s actuals import) — not `multipart/form-data`, so no second
 * request-parsing path exists alongside the one every other route already
 * uses. The practical ceiling is the server's own `bodyLimit` (5MB, see
 * `server.ts`), not the larger figure `content`'s own schema would allow in
 * isolation; a deployment that needs bigger attachments raises both
 * together.
 */
export async function registerDocumentRoutes(app: FastifyInstance): Promise<void> {
  async function requireProperty(
    request: Parameters<typeof requireCapability>[0],
    capability: 'property:read' | 'property:write',
    propertyId: string,
  ): Promise<string> {
    const context = requireCapability(request, capability);
    const property = await getProperty(request.db, context.organizationId, propertyId);
    if (!property) throw notFound('That property does not exist in this organization.');
    return context.organizationId;
  }

  app.get('/documents', async (request) => {
    const query = z
      .object({
        propertyId: z.string().uuid(),
        modelId: z.string().uuid().optional(),
      })
      .parse(request.query);

    const organizationId = await requireProperty(request, 'property:read', query.propertyId);
    const documents = await listDocuments(request.db, { organizationId, ...query });
    return { documents };
  });

  app.post('/documents', async (request, reply) => {
    const body = z
      .object({
        propertyId: z.string().uuid(),
        modelId: z.string().uuid().optional(),
        filename: z.string().min(1).max(300),
        contentType: z.string().min(1).max(200),
        /**
         * Base64. Capped well under `bodyLimit` (5MB) so the JSON envelope
         * around it never pushes a request over that ceiling — a request
         * this schema alone would accept but Fastify would refuse first is
         * a confusing way to fail.
         */
        content: z
          .string()
          .min(1)
          .max(4 * 1024 * 1024),
      })
      .parse(request.body);

    const context = requireCapability(request, 'property:write');
    const property = await getProperty(request.db, context.organizationId, body.propertyId);
    if (!property) throw notFound('That property does not exist in this organization.');

    if (body.modelId) {
      const model = await getModel(request.db, context.organizationId, body.modelId);
      if (!model) throw notFound('That model does not exist in this organization.');
      if (model.property_id !== body.propertyId) {
        throw badRequest('That model does not belong to this property.');
      }
    }

    const raw = Buffer.from(body.content, 'base64');
    if (raw.byteLength === 0) throw badRequest('That file is empty.');
    // Scanned before anything is written to disk, the same as every other
    // upload path — an infected file throws before `storage.save` ever runs.
    const { scanned } = await scanUpload(request, raw);

    const stored = await request.storage.save(context.organizationId, raw);
    const document = await createDocument(request.db, {
      organizationId: context.organizationId,
      propertyId: body.propertyId,
      modelId: body.modelId,
      filename: body.filename,
      contentType: body.contentType,
      byteSize: stored.byteSize,
      checksumSha256: stored.checksumSha256,
      storageKey: stored.storageKey,
      storageDriver: stored.storageDriver,
      scanStatus: scanned ? 'clean' : 'skipped',
      uploadedBy: context.userId,
    });

    await writeAudit(request.db, {
      organizationId: context.organizationId,
      userId: context.userId,
      action: 'document.uploaded',
      entityType: 'document',
      entityId: document.id,
      propertyId: body.propertyId,
      modelId: body.modelId,
      newValue: { filename: body.filename, contentType: body.contentType, scanned },
      ipAddress: request.ip,
    });

    return reply.status(201).send({ document });
  });

  app.get('/documents/:id/download', async (request, reply) => {
    const context = requireCapability(request, 'property:read');
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);

    const document = await getDocument(request.db, context.organizationId, id);
    if (!document) throw notFound('That document does not exist.');

    const bytes = await request.storage.read(document.storage_key);
    reply.header('content-type', document.content_type);
    reply.header(
      'content-disposition',
      `attachment; filename="${document.filename.replace(/"/g, "'")}"`,
    );
    return reply.send(bytes);
  });

  app.delete('/documents/:id', async (request) => {
    const context = requireCapability(request, 'property:write');
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);

    const document = await deleteDocument(request.db, context.organizationId, id);
    if (!document) throw notFound('That document does not exist.');
    await request.storage.remove(document.storage_key);

    await writeAudit(request.db, {
      organizationId: context.organizationId,
      userId: context.userId,
      action: 'document.deleted',
      entityType: 'document',
      entityId: document.id,
      propertyId: document.property_id,
      modelId: document.model_id ?? undefined,
      newValue: { filename: document.filename },
      ipAddress: request.ip,
    });

    return { ok: true };
  });
}

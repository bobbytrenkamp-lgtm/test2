import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { listAudit, listAuditPage, listJobs } from '@cre/database';
import { requireCapability } from '../context.js';

export async function registerAuditRoutes(app: FastifyInstance): Promise<void> {
  app.get('/audit', async (request) => {
    const context = requireCapability(request, 'audit:read');
    const query = z
      .object({
        modelId: z.string().uuid().optional(),
        propertyId: z.string().uuid().optional(),
        entityType: z.string().max(60).optional(),
        limit: z.coerce.number().int().min(1).max(500).default(100),
        // Opaque to the caller: it is where the previous page stopped, not a
        // position, so nothing should be computed from it.
        cursor: z.string().max(120).optional(),
        // Kept working for callers that page by position. Ignored when a cursor
        // is supplied.
        offset: z.coerce.number().int().min(0).default(0),
      })
      .parse(request.query);

    const page = await listAuditPage(request.db, {
      organizationId: context.organizationId,
      ...query,
    });
    return {
      entries: page.entries,
      nextCursor: page.nextCursor,
      limit: query.limit,
      offset: query.offset,
    };
  });

  /**
   * Machine-readable audit export. Emitted as newline-delimited JSON so a large
   * history streams to a compliance archive without being held in memory as a
   * single document.
   */
  app.get('/audit/export', async (request, reply) => {
    const context = requireCapability(request, 'audit:read');
    const query = z
      .object({
        modelId: z.string().uuid().optional(),
        propertyId: z.string().uuid().optional(),
        limit: z.coerce.number().int().min(1).max(5000).default(1000),
      })
      .parse(request.query);

    const entries = await listAudit(request.db, {
      organizationId: context.organizationId,
      ...query,
    });
    reply.header('content-type', 'application/x-ndjson; charset=utf-8');
    reply.header('content-disposition', 'attachment; filename="audit-log.ndjson"');
    return entries.map((entry) => JSON.stringify(entry)).join('\n');
  });

  app.get('/jobs', async (request) => {
    const context = requireCapability(request, 'model:read');
    const query = z
      .object({ limit: z.coerce.number().int().min(1).max(200).default(50) })
      .parse(request.query);
    return { jobs: await listJobs(request.db, context.organizationId, query.limit) };
  });

  app.get('/jobs/:id', async (request) => {
    const context = requireCapability(request, 'model:read');
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const rows = (await request.db`
      SELECT id, kind, status, attempts, max_attempts, result, error_message, created_at, completed_at
      FROM jobs WHERE id = ${id} AND organization_id = ${context.organizationId}
    `) as unknown as Array<Record<string, unknown>>;
    return { job: rows[0] ?? null };
  });
}

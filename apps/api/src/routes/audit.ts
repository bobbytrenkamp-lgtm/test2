import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  findErrorEventByReference,
  listAudit,
  listAuditPage,
  listErrorEvents,
  listErrorGroups,
  listJobs,
} from '@cre/database';
import { notFound, requireCapability } from '../context.js';

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

  /**
   * Recorded server faults, grouped.
   *
   * Behind `audit:read` rather than a capability of its own: whoever is
   * entrusted with the record of who changed what is the same person entrusted
   * with the record of what broke, and inventing a permission nobody assigns
   * would leave this screen unreachable in practice.
   *
   * The store holds no request bodies, query values, headers or model figures —
   * see `error_events` in migration 0011 — so this returns everything it has.
   */
  app.get('/operations/errors', async (request) => {
    requireCapability(request, 'audit:read');
    const query = z
      .object({
        sinceHours: z.coerce
          .number()
          .int()
          .min(1)
          .max(24 * 90)
          .default(24 * 7),
        limit: z.coerce.number().int().min(1).max(200).default(50),
      })
      .parse(request.query);

    const since = new Date(Date.now() - query.sinceHours * 60 * 60 * 1000).toISOString();
    const groups = await listErrorGroups(request.db, { since, limit: query.limit });
    return { groups, since, sinceHours: query.sinceHours };
  });

  app.get('/operations/errors/:fingerprint', async (request) => {
    requireCapability(request, 'audit:read');
    const params = z.object({ fingerprint: z.string().min(8).max(64) }).parse(request.params);
    return { events: await listErrorEvents(request.db, params.fingerprint) };
  });

  /**
   * Resolves the reference a customer reads off an error banner
   * ("Reference: ERR-482910") back to the fault it names, for a support
   * conversation. The same capability as the rest of this file's operational
   * routes — whoever may read the audit log may read what broke.
   */
  app.get('/operations/errors/reference/:reference', async (request) => {
    requireCapability(request, 'audit:read');
    const params = z.object({ reference: z.string().min(1).max(60) }).parse(request.params);
    const event = await findErrorEventByReference(request.db, params.reference);
    if (!event) throw notFound('No recorded fault matches that reference.');
    return { event };
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

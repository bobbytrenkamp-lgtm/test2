import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  countUnreadNotifications,
  listNotifications,
  markAllNotificationsRead,
  markNotificationRead,
} from '@cre/database';
import { notFound, queryBoolean, requireCapability } from '../context.js';

/**
 * A personal feed of what involves you.
 *
 * `comments.mentions` has stored who was drawn into a discussion since
 * migration 0004, but the mention only ever surfaced inside the thread
 * itself -- nobody was told out of band. `notifications` (migration 0026) is
 * one row per person a comment mentioned; this is the feed and unread count
 * built on top of it.
 *
 * Gated on `property:read`, the one capability every role holds (`favourites.ts`
 * makes the same call, for the same reason): being told you were mentioned is
 * not a privilege tied to what you may edit or approve.
 */
export async function registerNotificationRoutes(app: FastifyInstance): Promise<void> {
  app.get('/notifications', async (request) => {
    const context = requireCapability(request, 'property:read');
    const query = z
      .object({
        unread: queryBoolean(false),
        limit: z.coerce.number().int().min(1).max(200).default(50),
      })
      .parse(request.query);

    const [notifications, unreadCount] = await Promise.all([
      listNotifications(request.db, {
        organizationId: context.organizationId,
        userId: context.userId,
        unreadOnly: query.unread,
        limit: query.limit,
      }),
      countUnreadNotifications(request.db, context.organizationId, context.userId),
    ]);
    return { notifications, unreadCount };
  });

  app.post('/notifications/:id/read', async (request) => {
    const context = requireCapability(request, 'property:read');
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);

    const found = await markNotificationRead(request.db, {
      id,
      organizationId: context.organizationId,
      userId: context.userId,
    });
    if (!found) throw notFound('That notification does not exist.');
    return { ok: true };
  });

  app.post('/notifications/read-all', async (request) => {
    const context = requireCapability(request, 'property:read');
    const marked = await markAllNotificationsRead(
      request.db,
      context.organizationId,
      context.userId,
    );
    return { marked };
  });
}

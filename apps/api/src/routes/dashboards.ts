import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  deletePersonalDashboard,
  getPersonalDashboard,
  savePersonalDashboard,
} from '@cre/database';
import { requireCapability } from '../context.js';

/**
 * Personal dashboard layouts.
 *
 * `dashboards` (migration 0004) has existed since this platform's first
 * release, designed but never wired to a route or a screen —
 * `docs/feature-status.md` recorded that honestly. This is the personal,
 * organization-scoped slice of it: which widgets a person sees on their own
 * dashboard, and in what order.
 *
 * Deliberately opaque here: this route validates `layout`'s *shape* (an
 * array of `{id, visible}` pairs) but not the specific widget ids inside
 * it — the widget registry is a web-app concern (`Overview.tsx`), and
 * duplicating it server-side would only give an old server a way to reject
 * a widget id a newer client already knows about. An id this deployment's
 * web app no longer recognises is simply not rendered; nothing about that
 * needs the server's opinion.
 *
 * Gated on `property:read`, the one capability every role holds
 * (`favourites.ts` makes the same call, for the same reason): arranging
 * your own dashboard is not a privilege tied to what you may edit.
 */
export async function registerDashboardRoutes(app: FastifyInstance): Promise<void> {
  const scopeQuery = z.object({ scope: z.literal('organization').default('organization') });

  app.get('/dashboards', async (request) => {
    const context = requireCapability(request, 'property:read');
    const { scope } = scopeQuery.parse(request.query);
    const dashboard = await getPersonalDashboard(request.db, {
      organizationId: context.organizationId,
      ownerId: context.userId,
      scope,
    });
    return { dashboard };
  });

  app.put('/dashboards', async (request) => {
    const context = requireCapability(request, 'property:read');
    const body = z
      .object({
        scope: z.literal('organization').default('organization'),
        layout: z
          .array(
            z.object({
              id: z.string().min(1).max(60),
              visible: z.boolean(),
            }),
          )
          .max(20),
      })
      .parse(request.body);

    const dashboard = await savePersonalDashboard(request.db, {
      organizationId: context.organizationId,
      ownerId: context.userId,
      scope: body.scope,
      layout: body.layout,
    });
    return { dashboard };
  });

  app.delete('/dashboards', async (request) => {
    const context = requireCapability(request, 'property:read');
    const { scope } = scopeQuery.parse(request.query);
    await deletePersonalDashboard(request.db, {
      organizationId: context.organizationId,
      ownerId: context.userId,
      scope,
    });
    return { ok: true };
  });
}

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { addFavourite, getModel, getProperty, listFavourites, removeFavourite } from '@cre/database';
import { notFound, requireCapability } from '../context.js';

/**
 * Pinned properties and models.
 *
 * Somebody who lives in this application works on six assets, not sixty. The
 * navigation is organised by what exists; this is organised by what they are
 * doing, which is the only ordering that saves anybody time.
 *
 * Gated on `property:read` — a read-only viewer has as much reason to keep a
 * shortlist as anybody, and pinning changes nothing anyone else can see.
 *
 * The recently-viewed list is deliberately **not** here. See
 * `apps/web/src/recents.ts` for why it lives in the browser instead.
 */
export async function registerFavouriteRoutes(app: FastifyInstance): Promise<void> {
  app.get('/favourites', async (request) => {
    const context = requireCapability(request, 'property:read');
    return { favourites: await listFavourites(request.db, context.userId, context.organizationId) };
  });

  const params = z.object({
    entityType: z.enum(['property', 'model']),
    entityId: z.string().uuid(),
  });

  app.put('/favourites/:entityType/:entityId', async (request) => {
    const context = requireCapability(request, 'property:read');
    const { entityType, entityId } = params.parse(request.params);

    /*
     * Checked against the caller's own organization before it is stored.
     *
     * Without this, anybody could pin any uuid and then read the name back off
     * their own dashboard — the read resolves the row by joining to the real
     * table, which is exactly what makes an unchecked write a way to confirm
     * that a model exists and what it is called.
     */
    const exists =
      entityType === 'property'
        ? await getProperty(request.db, context.organizationId, entityId)
        : await getModel(request.db, context.organizationId, entityId);
    if (!exists) throw notFound('That does not exist in this organization.');

    await addFavourite(request.db, {
      userId: context.userId,
      organizationId: context.organizationId,
      entityType,
      entityId,
    });
    return { ok: true };
  });

  app.delete('/favourites/:entityType/:entityId', async (request) => {
    const context = requireCapability(request, 'property:read');
    const { entityType, entityId } = params.parse(request.params);
    // Unpinning something that is not pinned is not an error: the control is a
    // toggle, and refusing would only ever confuse whoever clicked it twice.
    await removeFavourite(request.db, {
      userId: context.userId,
      organizationId: context.organizationId,
      entityType,
      entityId,
    });
    return { ok: true };
  });
}

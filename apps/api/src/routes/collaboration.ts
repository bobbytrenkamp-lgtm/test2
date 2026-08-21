import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { createMentionNotifications, writeAudit } from '@cre/database';
import { roleHasCapability } from '@cre/domain-models';
import { badRequest, forbidden, notFound, queryBoolean, requireCapability } from '../context.js';

/**
 * Comments on the things a model is made of.
 *
 * The approval workflow could move a model from review back to draft and record
 * that it happened, but not why. A rejection with no reason attached is a
 * decision nobody can act on: the analyst learns that someone disagreed, not
 * what to change. That is the gap this closes.
 *
 * A comment is anchored to an entity — a model, a lease, a budget period — so
 * it sits where the disagreement is rather than in a separate discussion nobody
 * reads alongside the numbers.
 *
 * Comments are **not** the audit log. The audit log records what the system
 * did, is append-only, and is written by the platform; a comment records what a
 * person thinks, is written by them, and can be resolved. Conflating the two
 * would make the audit log editable, which is the one thing it must never be.
 *
 * A mention creates a notification for each person named (`notifications.ts`
 * in `@cre/database`, registered as `registerNotificationRoutes` — see
 * `apps/api/src/routes/notifications.ts` for the personal feed built on top
 * of it) — the mention no longer only means something to someone who
 * happens to reopen this thread.
 */

/** What a comment can be attached to, and how to prove the caller may see it. */
const ANCHORS = {
  model: {
    capability: 'model:read',
    sql: (id: string, organizationId: string) =>
      [
        'SELECT id FROM models WHERE id = $1 AND organization_id = $2 AND deleted_at IS NULL',
        [id, organizationId],
      ] as const,
  },
  property: {
    capability: 'property:read',
    sql: (id: string, organizationId: string) =>
      [
        'SELECT id FROM properties WHERE id = $1 AND organization_id = $2 AND deleted_at IS NULL',
        [id, organizationId],
      ] as const,
  },
  budget_period: {
    capability: 'report:read',
    sql: (id: string, organizationId: string) =>
      [
        'SELECT id FROM budget_periods WHERE id = $1 AND organization_id = $2',
        [id, organizationId],
      ] as const,
  },
} as const;

type AnchorType = keyof typeof ANCHORS;

export async function registerCollaborationRoutes(app: FastifyInstance): Promise<void> {
  /**
   * Confirms the anchor exists in this organization before anything is read or
   * written against it.
   *
   * Without this, a comment could be attached to any identifier at all — and
   * `comments` has no foreign key to the thing it names, because the thing
   * varies. The check has to live here.
   */
  async function requireAnchor(
    request: Parameters<typeof requireCapability>[0],
    entityType: AnchorType,
    entityId: string,
  ): Promise<string> {
    const anchor = ANCHORS[entityType];
    const context = requireCapability(request, anchor.capability);
    const [text, values] = anchor.sql(entityId, context.organizationId);
    const rows = (await request.db.unsafe(
      text,
      values as unknown as string[],
    )) as unknown as unknown[];
    if (rows.length === 0) {
      throw notFound('That record does not exist in this organization.');
    }
    return context.organizationId;
  }

  /**
   * Who this caller may mention.
   *
   * Deliberately not the members list: that needs `member:manage`, which an
   * analyst does not have and should not need in order to draw a colleague into
   * a discussion. This returns the minimum a mention picker requires — an
   * identifier and a name — and not the email addresses or roles the
   * administrative list carries.
   */
  app.get('/comments/mentionable', async (request) => {
    const context = requireCapability(request, 'comment:write');
    const people = await request.db`
      SELECT m.user_id, u.name
      FROM memberships m
      JOIN users u ON u.id = m.user_id
      WHERE m.organization_id = ${context.organizationId} AND m.user_id <> ${context.userId}
      ORDER BY u.name
    `;
    return { people };
  });

  app.get('/comments', async (request) => {
    const query = z
      .object({
        entityType: z.enum(['model', 'property', 'budget_period']),
        entityId: z.string().uuid(),
        /** Resolved comments are hidden by default: the open ones are the work. */
        includeResolved: queryBoolean(false),
      })
      .parse(request.query);

    await requireAnchor(request, query.entityType, query.entityId);

    const comments = await request.db`
      SELECT c.id, c.body, c.mentions, c.created_at, c.resolved_at,
             c.author_id, author.name AS author_name, author.email AS author_email,
             resolver.name AS resolved_by_name
      FROM comments c
      LEFT JOIN users author ON author.id = c.author_id
      LEFT JOIN users resolver ON resolver.id = c.resolved_by
      WHERE c.entity_type = ${query.entityType} AND c.entity_id = ${query.entityId}
        AND (${query.includeResolved} OR c.resolved_at IS NULL)
      ORDER BY c.created_at DESC
    `;
    return { comments };
  });

  app.post('/comments', async (request, reply) => {
    const body = z
      .object({
        entityType: z.enum(['model', 'property', 'budget_period']),
        entityId: z.string().uuid(),
        body: z.string().min(1).max(5000),
        /** Users to draw in. Each must be a member of this organization. */
        mentions: z.array(z.string().uuid()).max(20).default([]),
      })
      .parse(request.body);

    const organizationId = await requireAnchor(request, body.entityType, body.entityId);
    // Seeing a model and commenting on it are different permissions: a
    // read-only member reads the review, they do not join it.
    const context = requireCapability(request, 'comment:write');

    /*
     * A mention has to name someone who can actually see what is being
     * discussed. Accepting an arbitrary identifier would let a comment claim to
     * have drawn in a person who will never be told, and — worse — leak the
     * existence of a user in another organization to anyone who guessed.
     */
    if (body.mentions.length > 0) {
      const members = (await request.db`
        SELECT user_id FROM memberships
        WHERE organization_id = ${organizationId} AND user_id = ANY(${body.mentions}::uuid[])
      `) as unknown as Array<{ user_id: string }>;
      const known = new Set(members.map((row) => row.user_id));
      const strangers = body.mentions.filter((id) => !known.has(id));
      if (strangers.length > 0) {
        throw badRequest(
          'A comment can only mention members of this organization. Nothing has been saved.',
          { unknownMentions: strangers },
        );
      }
    }

    const rows = (await request.db`
      INSERT INTO comments (organization_id, entity_type, entity_id, body, mentions, author_id)
      VALUES (${organizationId}, ${body.entityType}, ${body.entityId}, ${body.body},
              ${body.mentions}::uuid[], ${context.userId})
      RETURNING *
    `) as unknown as Array<Record<string, unknown>>;
    const comment = rows[0] as Record<string, unknown>;

    if (body.mentions.length > 0) {
      await createMentionNotifications(request.db, {
        organizationId,
        actorId: context.userId,
        commentId: comment.id as string,
        entityType: body.entityType,
        entityId: body.entityId,
        recipientIds: body.mentions,
      });
    }

    await writeAudit(request.db, {
      organizationId,
      userId: context.userId,
      action: 'comment.created',
      entityType: 'comment',
      entityId: comment.id as string,
      modelId: body.entityType === 'model' ? body.entityId : undefined,
      propertyId: body.entityType === 'property' ? body.entityId : undefined,
      // The body is deliberately not copied into the audit log. A comment can
      // be resolved and a person may reasonably expect that to mean something;
      // an append-only copy of every word would make resolution cosmetic.
      newValue: { entityType: body.entityType, mentions: body.mentions.length },
      ipAddress: request.ip,
    });

    return reply.status(201).send({ comment });
  });

  app.post('/comments/:id/resolve', async (request) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);

    const rows = (await request.db`
      SELECT id, organization_id, entity_type, entity_id, author_id, resolved_at
      FROM comments WHERE id = ${id}
    `) as unknown as Array<{
      id: string;
      organization_id: string;
      entity_type: string;
      entity_id: string;
      author_id: string | null;
      resolved_at: Date | null;
    }>;
    const comment = rows[0];
    if (!comment) throw notFound('That comment does not exist.');

    const context = requireCapability(request, 'comment:write');
    // Scoped by organization, and reported as absent rather than forbidden: a
    // 403 would confirm the identifier names a real comment somewhere else.
    if (comment.organization_id !== context.organizationId) {
      throw notFound('That comment does not exist.');
    }
    if (comment.resolved_at) {
      throw badRequest('That comment has already been resolved.');
    }

    /*
     * Only the author or someone who can approve work may resolve a comment.
     *
     * Anyone being able to close a reviewer's objection would make the review
     * decorative: the fastest way past a criticism would be to dismiss it.
     */
    const mayApprove = roleHasCapability(context.role, 'model:approve');
    if (comment.author_id !== context.userId && !mayApprove) {
      throw forbidden(
        'A comment can be resolved by whoever raised it, or by an organization owner. Reply to it instead.',
      );
    }

    const updated = (await request.db`
      UPDATE comments SET resolved_at = now(), resolved_by = ${context.userId}
      WHERE id = ${id} AND resolved_at IS NULL
      RETURNING *
    `) as unknown as Array<Record<string, unknown>>;

    // The precondition check above reads the row before this write, so two
    // requests racing each other both pass it and both reach this UPDATE;
    // only the one `resolved_at IS NULL` still matches actually resolves
    // anything. Without this guard, the loser fell through to an audit
    // entry crediting *them* with resolving a comment someone else had
    // already closed a moment earlier -- a false record in a log this
    // codebase otherwise treats as authoritative.
    if (updated.length === 0) {
      throw badRequest('That comment has already been resolved.');
    }

    await writeAudit(request.db, {
      organizationId: context.organizationId,
      userId: context.userId,
      action: 'comment.resolved',
      entityType: 'comment',
      entityId: id,
      modelId: comment.entity_type === 'model' ? comment.entity_id : undefined,
      ipAddress: request.ip,
    });

    return { comment: updated[0] };
  });
}

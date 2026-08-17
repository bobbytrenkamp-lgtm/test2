import type { Sql } from '../client.js';

/**
 * Mention notifications.
 *
 * One row per person a comment's `mentions` array drew in (see
 * `collaboration.ts`'s `POST /comments`). A comment can be read by anyone
 * with the anchor's own read capability; a notification is narrower still --
 * scoped to the one person it names, the same way `user_favourites` is
 * scoped to the one person who pinned something.
 */

export interface NotificationRow {
  id: string;
  comment_id: string;
  entity_type: string;
  entity_id: string;
  /** Where to send the reader: `null` when the anchor type has no page of its own. */
  href: string | null;
  excerpt: string;
  actor_id: string | null;
  actor_name: string | null;
  read_at: Date | null;
  created_at: Date;
}

/**
 * One notification per recipient, skipping the actor themselves -- a comment
 * whose `mentions` includes its own author (reachable only by calling the
 * API directly, since the picker excludes the caller) should not notify
 * anyone of their own comment.
 */
export async function createMentionNotifications(
  sql: Sql,
  input: {
    organizationId: string;
    actorId: string;
    commentId: string;
    entityType: string;
    entityId: string;
    recipientIds: string[];
  },
): Promise<void> {
  const recipients = input.recipientIds.filter((id) => id !== input.actorId);
  if (recipients.length === 0) return;
  await sql`
    INSERT INTO notifications (organization_id, recipient_id, actor_id, comment_id, entity_type, entity_id)
    SELECT ${input.organizationId}, recipient, ${input.actorId}, ${input.commentId},
           ${input.entityType}, ${input.entityId}
    FROM unnest(${recipients}::uuid[]) AS recipient
  `;
}

export async function listNotifications(
  sql: Sql,
  input: { organizationId: string; userId: string; unreadOnly?: boolean; limit?: number },
): Promise<NotificationRow[]> {
  return (await sql`
    SELECT n.id, n.comment_id, n.entity_type, n.entity_id,
           CASE n.entity_type
             WHEN 'model' THEN '/models/' || n.entity_id
             WHEN 'property' THEN '/properties/' || n.entity_id
             WHEN 'budget_period' THEN '/properties/' || bp.property_id
             ELSE NULL
           END AS href,
           left(c.body, 140) AS excerpt,
           n.actor_id, actor.name AS actor_name,
           n.read_at, n.created_at
    FROM notifications n
    JOIN comments c ON c.id = n.comment_id
    LEFT JOIN users actor ON actor.id = n.actor_id
    LEFT JOIN budget_periods bp ON n.entity_type = 'budget_period' AND bp.id = n.entity_id
    WHERE n.organization_id = ${input.organizationId} AND n.recipient_id = ${input.userId}
      AND (${!(input.unreadOnly ?? false)} OR n.read_at IS NULL)
    ORDER BY n.created_at DESC
    LIMIT ${input.limit ?? 50}
  `) as unknown as NotificationRow[];
}

export async function countUnreadNotifications(
  sql: Sql,
  organizationId: string,
  userId: string,
): Promise<number> {
  const rows = (await sql`
    SELECT count(*)::int AS count FROM notifications
    WHERE organization_id = ${organizationId} AND recipient_id = ${userId} AND read_at IS NULL
  `) as unknown as Array<{ count: number }>;
  return rows[0]?.count ?? 0;
}

/**
 * Idempotent: a second call against an already-read notification leaves its
 * `read_at` exactly where it was rather than advancing it, but still reports
 * `true` -- the caller asked "is this mine", not "did this just change".
 */
export async function markNotificationRead(
  sql: Sql,
  input: { id: string; organizationId: string; userId: string },
): Promise<boolean> {
  const rows = (await sql`
    UPDATE notifications SET read_at = COALESCE(read_at, now())
    WHERE id = ${input.id} AND organization_id = ${input.organizationId}
      AND recipient_id = ${input.userId}
    RETURNING id
  `) as unknown as Array<{ id: string }>;
  return rows.length > 0;
}

export async function markAllNotificationsRead(
  sql: Sql,
  organizationId: string,
  userId: string,
): Promise<number> {
  const rows = (await sql`
    UPDATE notifications SET read_at = now()
    WHERE organization_id = ${organizationId} AND recipient_id = ${userId} AND read_at IS NULL
    RETURNING id
  `) as unknown as Array<{ id: string }>;
  return rows.length;
}

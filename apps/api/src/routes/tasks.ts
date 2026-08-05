import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Sql } from '@cre/database';
import { writeAudit } from '@cre/database';
import { badRequest, notFound, queryBoolean, requireCapability } from '../context.js';

/**
 * Asset-management work items.
 *
 * A model records what a building is expected to do. It has never recorded what
 * anyone is supposed to *do about it* — chase the estoppel, re-forecast after
 * the anchor's notice, get the roof quote before the budget locks. That work has
 * been living in inboxes, which is where accountability goes to die: nobody
 * outside the thread can see what is outstanding, and nothing connects it to the
 * asset it concerns.
 *
 * A task is deliberately small. It has a title, a state, optionally a due date,
 * optionally somebody responsible, and optionally the property or model it is
 * about. It is not a project plan: no dependencies, no sub-tasks, no effort
 * estimates. Those belong in a tool built for them, and a half-built one here
 * would be worse than none.
 *
 * ## What "overdue" means
 *
 * Nothing here decides what day it is. `due_date` is a calendar date with no
 * timezone, and the server's date is not necessarily the reader's — an asset
 * manager in Auckland and one in Los Angeles disagree about "today" for
 * twenty-one hours of every day. So the overdue filter takes the caller's date
 * and says so, rather than quietly answering in UTC and being wrong for half the
 * organization.
 */

/** Terminal states. Reopening is allowed; real work comes back. */
const CLOSED = ['done', 'cancelled'] as const;

const statusEnum = z.enum(['open', 'in_progress', 'blocked', 'done', 'cancelled']);
type TaskStatus = z.infer<typeof statusEnum>;

const isClosed = (status: TaskStatus): boolean => (CLOSED as readonly string[]).includes(status);

/** A calendar date, no time and no zone — the same shape the column stores. */
const calendarDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'A date must be written as YYYY-MM-DD.');

export async function registerTaskRoutes(app: FastifyInstance): Promise<void> {
  /**
   * Confirms an optional link points at something in this organization.
   *
   * Returning 404 rather than 403 for a record in another organization is the
   * same reasoning used everywhere else here: a 403 would confirm the identifier
   * names a real property to anyone who guessed one.
   */
  async function requireLink(
    db: Sql,
    table: 'properties' | 'models',
    id: string,
    organizationId: string,
  ): Promise<void> {
    const rows = (await db.unsafe(
      `SELECT id FROM ${table} WHERE id = $1 AND organization_id = $2 AND deleted_at IS NULL`,
      [id, organizationId],
    )) as unknown as unknown[];
    if (rows.length === 0) {
      throw notFound('That record does not exist in this organization.');
    }
  }

  /**
   * Confirms an assignee is somebody who can actually see the work.
   *
   * Assigning to an arbitrary identifier would produce a task nobody is ever
   * told about while looking, on the board, exactly like one that is owned.
   */
  async function requireMember(db: Sql, userId: string, organizationId: string): Promise<void> {
    const rows = (await db`
      SELECT user_id FROM memberships
      WHERE organization_id = ${organizationId} AND user_id = ${userId}
    `) as unknown as unknown[];
    if (rows.length === 0) {
      throw badRequest('A task can only be assigned to a member of this organization.');
    }
  }

  app.get('/tasks', async (request) => {
    const query = z
      .object({
        status: statusEnum.optional(),
        assigneeId: z.string().uuid().optional(),
        propertyId: z.string().uuid().optional(),
        modelId: z.string().uuid().optional(),
        /** Only work that is still live. The default, because that is the board. */
        includeClosed: queryBoolean(false),
        /**
         * Only tasks due on or before this date and not yet closed.
         *
         * The caller supplies the date because only the caller knows what day it
         * is where they are.
         */
        overdueAsOf: calendarDate.optional(),
      })
      .parse(request.query);

    const context = requireCapability(request, 'property:read');

    const tasks = await request.db`
      SELECT t.id, t.title, t.description, t.status, t.due_date,
             t.property_id, p.name AS property_name,
             t.model_id, m.name AS model_name,
             t.assignee_id, assignee.name AS assignee_name,
             t.created_by, creator.name AS created_by_name,
             t.created_at, t.completed_at
      FROM tasks t
      LEFT JOIN properties p ON p.id = t.property_id
      LEFT JOIN models m ON m.id = t.model_id
      LEFT JOIN users assignee ON assignee.id = t.assignee_id
      LEFT JOIN users creator ON creator.id = t.created_by
      WHERE t.organization_id = ${context.organizationId}
        AND (${query.status ?? null}::text IS NULL OR t.status = ${query.status ?? null})
        AND (${query.assigneeId ?? null}::uuid IS NULL OR t.assignee_id = ${query.assigneeId ?? null})
        AND (${query.propertyId ?? null}::uuid IS NULL OR t.property_id = ${query.propertyId ?? null})
        AND (${query.modelId ?? null}::uuid IS NULL OR t.model_id = ${query.modelId ?? null})
        AND (${query.includeClosed} OR t.status <> ALL(${[...CLOSED]}::text[]))
        AND (${query.overdueAsOf ?? null}::date IS NULL
             OR (t.due_date IS NOT NULL
                 AND t.due_date <= ${query.overdueAsOf ?? null}::date
                 AND t.status <> ALL(${[...CLOSED]}::text[])))
      ORDER BY
        -- Live work first, then by when it is due. Undated work sorts last:
        -- having no date is not the same as being due first. NULLS LAST is
        -- PostgreSQL's default for ASC and is written out anyway, because the
        -- day someone reverses this to DESC the default flips with it.
        (t.status = ANY(${[...CLOSED]}::text[])),
        t.due_date ASC NULLS LAST,
        t.created_at ASC
    `;
    return { tasks };
  });

  app.post('/tasks', async (request, reply) => {
    const body = z
      .object({
        title: z.string().min(1).max(200),
        description: z.string().max(5000).optional(),
        status: statusEnum.default('open'),
        dueDate: calendarDate.optional(),
        propertyId: z.string().uuid().optional(),
        modelId: z.string().uuid().optional(),
        assigneeId: z.string().uuid().optional(),
      })
      .parse(request.body);

    const context = requireCapability(request, 'task:write');

    if (body.propertyId) {
      await requireLink(request.db, 'properties', body.propertyId, context.organizationId);
    }
    if (body.modelId) {
      await requireLink(request.db, 'models', body.modelId, context.organizationId);
    }
    if (body.assigneeId) {
      await requireMember(request.db, body.assigneeId, context.organizationId);
    }

    const rows = (await request.db`
      INSERT INTO tasks (
        organization_id, title, description, status, due_date,
        property_id, model_id, assignee_id, created_by, completed_at
      ) VALUES (
        ${context.organizationId}, ${body.title}, ${body.description ?? null},
        ${body.status}, ${body.dueDate ?? null},
        ${body.propertyId ?? null}, ${body.modelId ?? null},
        ${body.assigneeId ?? null}, ${context.userId},
        ${isClosed(body.status) ? new Date() : null}
      )
      RETURNING *
    `) as unknown as Array<Record<string, unknown>>;
    const task = rows[0] as Record<string, unknown>;

    await writeAudit(request.db, {
      organizationId: context.organizationId,
      userId: context.userId,
      action: 'task.created',
      entityType: 'task',
      entityId: task.id as string,
      propertyId: body.propertyId,
      modelId: body.modelId,
      newValue: { title: body.title, status: body.status, assigneeId: body.assigneeId ?? null },
      ipAddress: request.ip,
    });

    return reply.status(201).send({ task });
  });

  app.patch('/tasks/:id', async (request) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const body = z
      .object({
        title: z.string().min(1).max(200).optional(),
        description: z.string().max(5000).nullable().optional(),
        status: statusEnum.optional(),
        // Explicitly nullable: clearing a due date is a real thing to want, and
        // an absent key has to keep meaning "leave it alone".
        dueDate: calendarDate.nullable().optional(),
        assigneeId: z.string().uuid().nullable().optional(),
      })
      .parse(request.body);

    const context = requireCapability(request, 'task:write');

    const existing = (await request.db`
      SELECT id, organization_id, title, description, status, due_date,
             assignee_id, property_id, model_id, completed_at
      FROM tasks WHERE id = ${id}
    `) as unknown as Array<{
      id: string;
      organization_id: string;
      title: string;
      description: string | null;
      status: TaskStatus;
      due_date: string | null;
      assignee_id: string | null;
      property_id: string | null;
      model_id: string | null;
      completed_at: Date | null;
    }>;
    const task = existing[0];
    if (!task || task.organization_id !== context.organizationId) {
      throw notFound('That task does not exist.');
    }

    if (body.assigneeId) {
      await requireMember(request.db, body.assigneeId, context.organizationId);
    }

    const nextStatus = body.status ?? task.status;
    /*
     * `completed_at` is derived from the status rather than accepted from the
     * caller, and it is recomputed on every write. If it were only ever set, a
     * task reopened after being finished would keep a completion date and the
     * column would be a record of the last time somebody thought it was done —
     * which is not what anything reading it assumes.
     */
    const completedAt = isClosed(nextStatus)
      ? // Already closed and staying closed keeps the date it was closed on;
        // only the crossing sets it.
        (task.completed_at ?? new Date())
      : null;

    /*
     * Every optional field follows the same rule: an absent key leaves the
     * column alone, an explicit `null` clears it. `COALESCE(new, old)` looks
     * like the tidy way to write that and is wrong — it cannot tell "leave it"
     * from "clear it", so a description could be set but never removed.
     */
    const rows = (await request.db`
      UPDATE tasks SET
        title = ${body.title ?? task.title},
        description = ${body.description === undefined ? task.description : body.description},
        status = ${nextStatus},
        due_date = ${body.dueDate === undefined ? task.due_date : body.dueDate},
        assignee_id = ${body.assigneeId === undefined ? task.assignee_id : body.assigneeId},
        completed_at = ${completedAt}
      WHERE id = ${id} AND organization_id = ${context.organizationId}
      RETURNING *
    `) as unknown as Array<Record<string, unknown>>;

    await writeAudit(request.db, {
      organizationId: context.organizationId,
      userId: context.userId,
      action: 'task.updated',
      entityType: 'task',
      entityId: id,
      propertyId: task.property_id ?? undefined,
      modelId: task.model_id ?? undefined,
      previousValue: { status: task.status, assigneeId: task.assignee_id, dueDate: task.due_date },
      newValue: {
        status: nextStatus,
        assigneeId: body.assigneeId === undefined ? task.assignee_id : body.assigneeId,
        dueDate: body.dueDate === undefined ? task.due_date : body.dueDate,
      },
      ipAddress: request.ip,
    });

    return { task: rows[0] ?? null };
  });
}

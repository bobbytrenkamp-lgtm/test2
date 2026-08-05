import { createHash } from 'node:crypto';
import type { Sql } from '../client.js';

/**
 * Recorded server faults.
 *
 * The point of recording a fault is to notice it, so the store is built around
 * grouping rather than around individual events: one route failing four
 * thousand times is one problem, and a list that shows it four thousand times
 * is a list nobody opens twice.
 *
 * ## What is deliberately not recorded
 *
 * No request body, no query values, no headers, no session token, and no model
 * or tenant figures. An error store is a copy of production data held under
 * weaker access controls unless it is disciplined about that, and on a platform
 * holding rent rolls the discipline has to be structural rather than a habit.
 *
 * The route pattern is recorded, never the resolved path, so identifiers do not
 * accumulate here either. A fingerprint, a route and a stack are enough to find
 * a fault. Reproducing it needs the model, which is still where it always was,
 * behind the permissions it always had.
 */

export interface ErrorEventInput {
  organizationId?: string | null;
  userId?: string | null;
  method: string;
  /** The route pattern, e.g. `/models/:id/calculate`. */
  route: string;
  statusCode: number;
  errorName: string;
  message: string;
  stack?: string | null;
}

export interface ErrorGroup {
  fingerprint: string;
  method: string;
  route: string;
  error_name: string;
  message: string;
  occurrences: number;
  first_seen: Date;
  last_seen: Date;
  organizations_affected: number;
}

/**
 * Digits and identifiers are stripped before hashing.
 *
 * The same fault on two different models produces two different messages —
 * "model 8f2c… not found", "model 41ab… not found" — and grouping them apart
 * would report one problem as thousands. What survives is the shape.
 */
export function fingerprintOf(input: {
  method: string;
  route: string;
  errorName: string;
  message: string;
}): string {
  const shape = input.message
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '<id>')
    .replace(/\d+/g, '<n>')
    .slice(0, 400);
  return createHash('sha256')
    .update(`${input.method} ${input.route} ${input.errorName} ${shape}`)
    .digest('hex')
    .slice(0, 32);
}

/**
 * Records a fault.
 *
 * Never throws. A failure to record a failure must not become the response the
 * caller sees, and an error handler that can itself fail is worse than no error
 * handler at all.
 */
export async function recordError(sql: Sql, input: ErrorEventInput): Promise<void> {
  try {
    const fingerprint = fingerprintOf(input);
    await sql`
      INSERT INTO error_events (
        fingerprint, organization_id, user_id, method, route, status_code,
        error_name, message, stack
      ) VALUES (
        ${fingerprint}, ${input.organizationId ?? null}, ${input.userId ?? null},
        ${input.method}, ${input.route}, ${input.statusCode}, ${input.errorName},
        ${input.message.slice(0, 2000)}, ${input.stack?.slice(0, 8000) ?? null}
      )
    `;
  } catch {
    // Swallowed on purpose, and only here. The original fault has already been
    // written to the process log by the handler that called this.
  }
}

/**
 * Faults grouped by fingerprint, most recently seen first.
 *
 * `organizations_affected` is the figure that decides urgency: one tenant
 * hitting a fault repeatedly is a support conversation, and the same fault
 * across every tenant is an outage.
 */
export async function listErrorGroups(
  sql: Sql,
  options: { since?: string; limit?: number } = {},
): Promise<ErrorGroup[]> {
  const limit = Math.min(options.limit ?? 50, 200);
  return (await sql`
    SELECT fingerprint,
           max(method) AS method,
           max(route) AS route,
           max(error_name) AS error_name,
           max(message) AS message,
           count(*)::int AS occurrences,
           min(occurred_at) AS first_seen,
           max(occurred_at) AS last_seen,
           count(DISTINCT organization_id)::int AS organizations_affected
    FROM error_events
    WHERE (${options.since ?? null}::timestamptz IS NULL
           OR occurred_at >= ${options.since ?? null}::timestamptz)
    GROUP BY fingerprint
    ORDER BY max(occurred_at) DESC
    LIMIT ${limit}
  `) as unknown as ErrorGroup[];
}

/** The individual events behind one group, newest first. */
export async function listErrorEvents(
  sql: Sql,
  fingerprint: string,
  limit = 20,
): Promise<Array<Record<string, unknown>>> {
  return (await sql`
    SELECT id, occurred_at, method, route, status_code, error_name, message, stack
    FROM error_events
    WHERE fingerprint = ${fingerprint}
    ORDER BY occurred_at DESC, id DESC
    LIMIT ${Math.min(limit, 100)}
  `) as unknown as Array<Record<string, unknown>>;
}

/**
 * Deletes events older than the retention window.
 *
 * A table that only grows is a table that eventually fills the disk the
 * database is on, which turns a monitoring convenience into an outage. Ninety
 * days is long enough to see a seasonal fault and short enough to bound.
 */
export async function pruneErrors(sql: Sql, retainDays = 90): Promise<number> {
  const rows = (await sql`
    DELETE FROM error_events
    WHERE occurred_at < now() - (${retainDays} || ' days')::interval
    RETURNING id
  `) as unknown as unknown[];
  return rows.length;
}

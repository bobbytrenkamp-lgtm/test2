import type { Sql } from '../client.js';

/**
 * PostgreSQL-backed job queue.
 *
 * `FOR UPDATE SKIP LOCKED` lets several workers consume the same queue without
 * coordinating: each transaction claims rows no other worker holds. This keeps
 * imports, exports, report generation and batch scenario runs off the request
 * path without adding a second piece of infrastructure to operate.
 */

export type JobKind =
  | 'calculate_model'
  | 'import_rent_roll'
  | 'export_workbook'
  | 'render_report'
  | 'aggregate_portfolio'
  | 'run_scenario_batch';

export interface JobRow {
  id: string;
  organization_id: string | null;
  kind: JobKind;
  payload: Record<string, unknown>;
  status: string;
  attempts: number;
  max_attempts: number;
  created_at: Date;
  completed_at: Date | null;
  result: unknown;
  error_message: string | null;
}

export async function enqueueJob(
  sql: Sql,
  input: {
    organizationId: string | null;
    kind: JobKind;
    payload: Record<string, unknown>;
    priority?: number;
    runAfter?: Date;
    requestedBy?: string | null;
    maxAttempts?: number;
  },
): Promise<JobRow> {
  const rows = (await sql`
    INSERT INTO jobs (organization_id, kind, payload, priority, run_after, requested_by, max_attempts)
    VALUES (
      ${input.organizationId}, ${input.kind}, ${sql.json(input.payload as never)},
      ${input.priority ?? 100}, ${input.runAfter ?? new Date()},
      ${input.requestedBy ?? null}, ${input.maxAttempts ?? 3}
    )
    RETURNING id, organization_id, kind, payload, status, attempts, max_attempts,
              created_at, completed_at, result, error_message
  `) as unknown as JobRow[];
  return rows[0] as JobRow;
}

/** Claims one ready job for this worker, or returns null when the queue is empty. */
export async function claimJob(sql: Sql, workerId: string): Promise<JobRow | null> {
  const rows = (await sql`
    UPDATE jobs
    SET status = 'running', locked_at = now(), locked_by = ${workerId}, attempts = attempts + 1
    WHERE id = (
      SELECT id FROM jobs
      WHERE status = 'queued' AND run_after <= now()
      ORDER BY priority, run_after
      FOR UPDATE SKIP LOCKED
      LIMIT 1
    )
    RETURNING id, organization_id, kind, payload, status, attempts, max_attempts,
              created_at, completed_at, result, error_message
  `) as unknown as JobRow[];
  return rows[0] ?? null;
}

export async function completeJob(sql: Sql, jobId: string, result: unknown): Promise<void> {
  await sql`
    UPDATE jobs
    SET status = 'succeeded', result = ${sql.json((result ?? null) as never)},
        completed_at = now(), locked_at = NULL, locked_by = NULL
    WHERE id = ${jobId}
  `;
}

/**
 * Records a failure. The job is requeued with an exponential backoff until its
 * attempt limit is reached, after which it is left in `failed` for an operator
 * to inspect rather than being retried forever.
 */
export async function failJob(sql: Sql, jobId: string, message: string): Promise<void> {
  await sql`
    UPDATE jobs
    SET status = CASE WHEN attempts >= max_attempts THEN 'failed' ELSE 'queued' END,
        error_message = ${message.slice(0, 2000)},
        run_after = now() + (power(2, LEAST(attempts, 6)) || ' seconds')::interval,
        locked_at = NULL,
        locked_by = NULL,
        completed_at = CASE WHEN attempts >= max_attempts THEN now() ELSE NULL END
    WHERE id = ${jobId}
  `;
}

export async function getJob(sql: Sql, jobId: string): Promise<JobRow | null> {
  const rows = (await sql`
    SELECT id, organization_id, kind, payload, status, attempts, max_attempts,
           created_at, completed_at, result, error_message
    FROM jobs WHERE id = ${jobId}
  `) as unknown as JobRow[];
  return rows[0] ?? null;
}

export async function listJobs(sql: Sql, organizationId: string, limit = 50): Promise<JobRow[]> {
  return (await sql`
    SELECT id, organization_id, kind, payload, status, attempts, max_attempts,
           created_at, completed_at, result, error_message
    FROM jobs
    WHERE organization_id = ${organizationId}
    ORDER BY created_at DESC
    LIMIT ${Math.min(limit, 200)}
  `) as unknown as JobRow[];
}

/**
 * Releases jobs whose worker died mid-run so another worker can pick them up.
 *
 * Subject to the same `max_attempts` cap `failJob` enforces, for the same
 * reason: `claimJob` increments `attempts` on every claim, stall included, so
 * a job whose handler reliably crashes the worker process itself (an OOM, say
 * — not a catchable error `failJob` would otherwise see) would be claimed,
 * die, sit `running` until this reaper found it, and be unconditionally
 * requeued — reachable again by `claimJob`, crashable again, forever. A job
 * this has already happened to `max_attempts` times is left `failed` instead,
 * the same terminal state a job that fails by throwing eventually reaches.
 */
export async function reapStalledJobs(sql: Sql, staleAfterSeconds = 900): Promise<number> {
  const rows = (await sql`
    UPDATE jobs
    SET status = CASE WHEN attempts >= max_attempts THEN 'failed' ELSE 'queued' END,
        error_message = CASE
          WHEN attempts >= max_attempts THEN 'Reaped after exceeding its attempt limit while stalled.'
          ELSE error_message
        END,
        completed_at = CASE WHEN attempts >= max_attempts THEN now() ELSE NULL END,
        locked_at = NULL,
        locked_by = NULL
    WHERE status = 'running'
      AND locked_at < now() - (${staleAfterSeconds} || ' seconds')::interval
    RETURNING id
  `) as unknown as Array<{ id: string }>;
  return rows.length;
}

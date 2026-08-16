import { hostname } from 'node:os';
import { randomBytes } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import {
  claimJob,
  completeJob,
  failJob,
  getDatabase,
  reapStalledJobs,
  type Sql,
} from '@cre/database';
import { handlers } from './handlers.js';

/**
 * Background worker.
 *
 * Polls the PostgreSQL-backed queue, claiming one job at a time with
 * FOR UPDATE SKIP LOCKED so any number of workers can run against the same
 * database without coordinating. The loop backs off when the queue is empty so
 * an idle deployment is not hammering the database.
 */

const WORKER_ID = `${hostname()}-${randomBytes(4).toString('hex')}`;
const IDLE_POLL_MS = 2000;
const BUSY_POLL_MS = 50;
const REAP_INTERVAL_MS = 60_000;

let running = true;

/**
 * Claims and runs one job, or returns `false` when the queue is empty.
 *
 * Exported (and parameterised on `sql`/`workerId` rather than closing over
 * the module-level singleton) so a test can drive it directly against a real
 * queue and assert on the outcome, the same way `claimJob`/`completeJob`/
 * `failJob` are already tested in isolation — this is the orchestration that
 * calls them, previously the one part of the pipeline nothing exercised.
 */
export async function tick(sql: Sql, workerId: string): Promise<boolean> {
  const job = await claimJob(sql, workerId);
  if (!job) return false;

  const handler = handlers[job.kind];
  if (!handler) {
    await failJob(sql, job.id, `No handler is registered for job kind "${job.kind}".`);
    return true;
  }

  const startedAt = Date.now();
  try {
    const result = await handler(sql, job);
    await completeJob(sql, job.id, result);
    console.warn(
      JSON.stringify({
        level: 'info',
        event: 'job.succeeded',
        jobId: job.id,
        kind: job.kind,
        durationMs: Date.now() - startedAt,
        worker: workerId,
      }),
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await failJob(sql, job.id, message);
    // The message is logged; the payload is not, because it can name tenants
    // and reference model data.
    console.error(
      JSON.stringify({
        level: 'error',
        event: 'job.failed',
        jobId: job.id,
        kind: job.kind,
        attempts: job.attempts,
        maxAttempts: job.max_attempts,
        message,
        worker: workerId,
      }),
    );
  }
  return true;
}

async function main(sql: Sql): Promise<void> {
  console.warn(JSON.stringify({ level: 'info', event: 'worker.started', worker: WORKER_ID }));

  const reaper = setInterval(() => {
    void reapStalledJobs(sql).then((count) => {
      if (count > 0) {
        console.warn(
          JSON.stringify({ level: 'warn', event: 'jobs.reaped', count, worker: WORKER_ID }),
        );
      }
    });
  }, REAP_INTERVAL_MS);

  while (running) {
    let didWork = false;
    try {
      didWork = await tick(sql, WORKER_ID);
    } catch (error) {
      console.error(
        JSON.stringify({
          level: 'error',
          event: 'worker.tick_failed',
          message: error instanceof Error ? error.message : String(error),
        }),
      );
    }
    await new Promise((resolve) => setTimeout(resolve, didWork ? BUSY_POLL_MS : IDLE_POLL_MS));
  }

  clearInterval(reaper);
}

// Runs the poll loop only when this file is executed directly (`pnpm start`,
// `tsx watch`), not when a test imports `tick` from it — importing this
// module must never start an infinite loop against whatever DATABASE_URL
// happens to be set.
const isEntryPoint =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isEntryPoint) {
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => {
      console.warn(JSON.stringify({ level: 'info', event: 'worker.stopping', worker: WORKER_ID }));
      running = false;
      // Give the in-flight job a moment to record its outcome.
      setTimeout(() => process.exit(0), 5000).unref();
    });
  }

  await main(getDatabase());
}

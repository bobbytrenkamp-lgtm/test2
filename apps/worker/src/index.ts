import { hostname } from 'node:os';
import { randomBytes } from 'node:crypto';
import { claimJob, completeJob, failJob, getDatabase, reapStalledJobs } from '@cre/database';
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

const sql = getDatabase();
let running = true;

async function tick(): Promise<boolean> {
  const job = await claimJob(sql, WORKER_ID);
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
        worker: WORKER_ID,
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
        worker: WORKER_ID,
      }),
    );
  }
  return true;
}

async function main(): Promise<void> {
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
      didWork = await tick();
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

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    console.warn(JSON.stringify({ level: 'info', event: 'worker.stopping', worker: WORKER_ID }));
    running = false;
    // Give the in-flight job a moment to record its outcome.
    setTimeout(() => process.exit(0), 5000).unref();
  });
}

await main();

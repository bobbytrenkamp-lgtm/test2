import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { enqueueJob, failJob, getJob, reapStalledJobs } from '@cre/database';
import { createTestContext, hasDatabase, type TestContext } from './helpers.js';

/**
 * The background job queue's retry cap, under a stall rather than a thrown
 * error.
 *
 * `failJob` (exercised indirectly by every job handler that throws) has
 * always capped retries at `max_attempts`, moving a job to `failed` once
 * exhausted rather than requeuing it forever. `reapStalledJobs` — which
 * recovers a job whose worker died mid-run, `locked_at` gone stale — is a
 * second path back to `queued` that never had the same cap: a job whose
 * handler reliably crashes the worker process itself (not a catchable JS
 * error `failJob` would see) could be claimed, die, sit `running` until the
 * reaper found it, and be unconditionally reset to `queued` — reachable by
 * `claimJob` again, crashable again, with no terminal state it could ever
 * reach.
 */
describe.skipIf(!hasDatabase)('job reaper attempt cap', () => {
  let ctx: TestContext;

  beforeAll(async () => {
    ctx = await createTestContext();
  }, 60_000);

  afterAll(async () => {
    await ctx?.close();
  });

  /** Marks a job as though a worker claimed it and then died, `locked_at` in the past. */
  async function markStalled(jobId: string, attempts: number): Promise<void> {
    await ctx.sql`
      UPDATE jobs
      SET status = 'running', attempts = ${attempts}, locked_by = 'dead-worker',
          locked_at = now() - interval '1 hour'
      WHERE id = ${jobId}
    `;
  }

  it('requeues a stalled job that has not yet exhausted its attempts', async () => {
    const job = await enqueueJob(ctx.sql, {
      organizationId: null,
      kind: 'calculate_model',
      payload: {},
      maxAttempts: 3,
    });
    await markStalled(job.id, 1);

    const reaped = await reapStalledJobs(ctx.sql, 900);
    expect(reaped).toBeGreaterThanOrEqual(1);

    const after = await getJob(ctx.sql, job.id);
    expect(after?.status).toBe('queued');
    expect(after?.completed_at).toBeNull();
  });

  it('fails a stalled job that has already reached its attempt limit, rather than requeuing it forever', async () => {
    // Hand-derived: max_attempts is 2 and the job has already been claimed
    // (and stalled) twice, so `attempts >= max_attempts` is true — the same
    // condition `failJob` already uses to stop retrying. Before this fix,
    // reapStalledJobs had no such condition at all and would requeue this
    // job unconditionally, exactly as many times as it kept stalling.
    const job = await enqueueJob(ctx.sql, {
      organizationId: null,
      kind: 'calculate_model',
      payload: {},
      maxAttempts: 2,
    });
    await markStalled(job.id, 2);

    await reapStalledJobs(ctx.sql, 900);

    const after = await getJob(ctx.sql, job.id);
    expect(after?.status).toBe('failed');
    expect(after?.completed_at).not.toBeNull();
    expect(after?.error_message).toContain('attempt limit');
  });

  it('leaves a job that is not actually stale alone', async () => {
    const job = await enqueueJob(ctx.sql, {
      organizationId: null,
      kind: 'calculate_model',
      payload: {},
    });
    await ctx.sql`
      UPDATE jobs SET status = 'running', locked_by = 'live-worker', locked_at = now()
      WHERE id = ${job.id}
    `;

    // A 900-second staleness threshold does not touch a job locked moments ago.
    await reapStalledJobs(ctx.sql, 900);

    const after = await getJob(ctx.sql, job.id);
    expect(after?.status).toBe('running');
  });
});

/**
 * `failJob` itself, on a real thrown error rather than a stall.
 *
 * Every job handler that throws routes here (see `apps/worker/src/index.ts`),
 * and the reaper's own attempt cap above was modelled directly on this
 * function's `attempts >= max_attempts` condition — but no test had ever
 * called `failJob` with attempts still under the limit, so the requeue branch
 * itself, and the backoff it sets, were never exercised; only the "already
 * exhausted" branch was, indirectly, through the reaper.
 */
describe.skipIf(!hasDatabase)('failJob', () => {
  let ctx: TestContext;

  beforeAll(async () => {
    ctx = await createTestContext();
  }, 60_000);

  afterAll(async () => {
    await ctx?.close();
  });

  it('requeues with an exponential backoff when the attempt limit has not been reached', async () => {
    const job = await enqueueJob(ctx.sql, {
      organizationId: null,
      kind: 'calculate_model',
      payload: {},
      maxAttempts: 3,
    });
    // A job is claimed before it can fail; claiming is what advances attempts.
    await ctx.sql`UPDATE jobs SET attempts = 1 WHERE id = ${job.id}`;

    await failJob(ctx.sql, job.id, 'transient failure');

    const after = await getJob(ctx.sql, job.id);
    expect(after?.status).toBe('queued');
    expect(after?.completed_at).toBeNull();
    expect(after?.error_message).toBe('transient failure');

    const [row] = await ctx.sql`SELECT run_after FROM jobs WHERE id = ${job.id}`;
    // Hand-derived: attempts = 1, so the backoff is 2^1 = 2 seconds — pushed
    // into the future, not left at (or before) the moment of failure.
    expect(new Date((row as { run_after: string }).run_after).getTime()).toBeGreaterThan(
      Date.now(),
    );
  });

  it('moves to failed, not queued, once the attempt limit is reached', async () => {
    const job = await enqueueJob(ctx.sql, {
      organizationId: null,
      kind: 'calculate_model',
      payload: {},
      maxAttempts: 1,
    });
    await ctx.sql`UPDATE jobs SET attempts = 1 WHERE id = ${job.id}`;

    await failJob(ctx.sql, job.id, 'permanent failure');

    const after = await getJob(ctx.sql, job.id);
    expect(after?.status).toBe('failed');
    expect(after?.completed_at).not.toBeNull();
    expect(after?.error_message).toBe('permanent failure');
  });
});

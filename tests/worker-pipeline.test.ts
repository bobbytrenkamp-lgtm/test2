import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { enqueueJob, getJob } from '@cre/database';
import { ENGINE_VERSION } from '@cre/calculation-engine';
import { tick } from '../apps/worker/src/index.js';
import {
  authed,
  createTestContext,
  hasDatabase,
  registerActor,
  type Actor,
  type TestContext,
} from './helpers.js';

/**
 * The worker's own orchestration: claim → run a handler → complete or fail.
 *
 * `tests/jobs.test.ts` covers `claimJob`/`completeJob`/`failJob`/
 * `reapStalledJobs` in isolation, and `tests/worker-handlers.test.ts` covers
 * one handler's own business logic directly. Neither exercises the function
 * that actually wires them together — `tick()` in `apps/worker/src/index.ts`
 * — which is why `docs/feature-status.md` recorded the worker as
 * "Functional | Not covered by automated tests" despite its parts each being
 * tested. These tests call `tick()` itself, the same function `main()`'s
 * poll loop calls, against a real queue.
 */
describe.skipIf(!hasDatabase)('worker tick()', () => {
  let ctx: TestContext;
  let owner: Actor;
  let organizationId: string;
  let modelId: string;

  beforeAll(async () => {
    ctx = await createTestContext();
    owner = await registerActor(ctx.app, 'worker-tick-owner@example.invalid', 'Tick Owner');

    const organization = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/organizations',
      headers: authed(owner.cookie),
      payload: { name: 'Tick Partners' },
    });
    organizationId = (organization.json() as { organization: { id: string } }).organization.id;

    const property = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/properties',
      headers: authed(owner.cookie),
      payload: { name: 'Tick House', propertyType: 'office', rentableArea: '10000' },
    });
    const propertyId = (property.json() as { property: { id: string } }).property.id;

    const model = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/models',
      headers: authed(owner.cookie),
      payload: {
        propertyId,
        name: 'Tick model',
        classification: 'valuation',
        valuationDate: '2026-01-01',
        forecastStartDate: '2026-01-01',
        forecastMonths: 12,
        discountRate: '0.08',
        terminalCapRate: '0.07',
      },
    });
    modelId = (model.json() as { model: { id: string } }).model.id;
  }, 90_000);

  afterAll(async () => {
    await ctx?.close();
  });

  it('returns false, claiming nothing, when the queue is empty', async () => {
    const didWork = await tick(ctx.sql, 'test-worker-empty');
    expect(didWork).toBe(false);
  });

  it('claims, runs and completes a real job, recording its result', async () => {
    const job = await enqueueJob(ctx.sql, {
      organizationId,
      kind: 'calculate_model',
      payload: { modelId },
    });

    const didWork = await tick(ctx.sql, 'test-worker-success');
    expect(didWork).toBe(true);

    const after = await getJob(ctx.sql, job.id);
    expect(after?.status).toBe('succeeded');
    expect(after?.completed_at).not.toBeNull();
    expect((after?.result as { engineVersion: string } | null)?.engineVersion).toBe(ENGINE_VERSION);
  });

  it('fails a job whose handler throws, recording the real error message', async () => {
    // No organizationId: calculate_model's own handler throws
    // "calculate_model requires an organization." before touching the
    // database — a real handler failure, not a simulated one.
    const job = await enqueueJob(ctx.sql, {
      organizationId: null,
      kind: 'calculate_model',
      payload: { modelId },
      maxAttempts: 1,
    });

    const didWork = await tick(ctx.sql, 'test-worker-handler-error');
    expect(didWork).toBe(true);

    const after = await getJob(ctx.sql, job.id);
    expect(after?.status).toBe('failed');
    expect(after?.error_message).toContain('requires an organization');
  });

  it('fails a job of a kind no handler is registered for, rather than dropping it silently', async () => {
    const job = await enqueueJob(ctx.sql, {
      organizationId,
      // Not a real JobKind — the same shape a stale or forward-incompatible
      // enqueuer would produce, which `tick()` must refuse rather than throw
      // an uncaught TypeError from an undefined handler.
      kind: 'not_a_real_job_kind' as never,
      payload: {},
      maxAttempts: 1,
    });

    const didWork = await tick(ctx.sql, 'test-worker-unknown-kind');
    expect(didWork).toBe(true);

    const after = await getJob(ctx.sql, job.id);
    expect(after?.status).toBe('failed');
    expect(after?.error_message).toContain('No handler is registered');
  });
});

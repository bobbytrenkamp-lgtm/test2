import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { enqueueJob, getJob } from '@cre/database';
import { handlers } from '../apps/worker/src/handlers.js';
import {
  authed,
  createTestContext,
  hasDatabase,
  registerActor,
  type Actor,
  type TestContext,
} from './helpers.js';

/**
 * Scenario batches and the sensitivity grid both let a caller substitute an
 * arbitrary string into a `ModelInput` valuation field before running the
 * engine. Neither route validated that string beyond its zod `z.string()`
 * shape: a non-numeric `discountRate`, or a `saleMonth` that isn't a
 * whole number, used to flow straight through to `calculate()` and surface
 * as either `NaN` silently defeating a range guard (`saleMonth`) or a
 * decimal.js parse error with no reference to which field or scenario was
 * at fault. Both routes now reject a malformed value before it reaches the
 * engine; `run_scenario_batch`'s worker handler rejects it a second time,
 * as defense in depth against a job payload that bypassed the route.
 */
describe.skipIf(!hasDatabase)('sensitivity and scenario-batch input validation', () => {
  let ctx: TestContext;
  let owner: Actor;
  let organizationId: string;
  let modelId: string;

  beforeAll(async () => {
    ctx = await createTestContext();
    owner = await registerActor(ctx.app, 'sensitivity-owner@example.invalid', 'Sensitivity Owner');

    const org = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/organizations',
      headers: authed(owner.cookie),
      payload: { name: 'Sensitivity Test Holdings' },
    });
    organizationId = (org.json() as { organization: { id: string } }).organization.id;

    const property = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/properties',
      headers: authed(owner.cookie),
      payload: { name: 'Sensitivity Building', propertyType: 'office', rentableArea: '50000' },
    });
    const propertyId = (property.json() as { property: { id: string } }).property.id;

    const model = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/models',
      headers: authed(owner.cookie),
      payload: {
        propertyId,
        name: 'Sensitivity base case',
        classification: 'acquisition',
        valuationDate: '2026-01-01',
        forecastStartDate: '2026-01-01',
        forecastMonths: 36,
        discountRate: '0.08',
        terminalCapRate: '0.07',
        terminalNoiBasis: 'trailing_12',
        saleMonth: 36,
        saleCostPercent: '0',
        acquisitionPrice: '10000000',
      },
    });
    modelId = (model.json() as { model: { id: string } }).model.id;
  }, 60_000);

  afterAll(async () => {
    await ctx?.close();
  });

  describe('POST /models/:id/sensitivity', () => {
    it('rejects a non-numeric value for a decimal-string variable', async () => {
      const response = await ctx.app.inject({
        method: 'POST',
        url: `/api/v1/models/${modelId}/sensitivity`,
        headers: authed(owner.cookie),
        payload: { rows: { variable: 'discountRate', values: ['0.07', 'not-a-number'] } },
      });
      expect(response.statusCode).toBe(400);
      const body = response.json() as { error: { message: string } };
      expect(body.error.message).toContain('discountRate');
      expect(body.error.message).toContain('not-a-number');
    });

    it('rejects a saleMonth that is not a positive whole number', async () => {
      const response = await ctx.app.inject({
        method: 'POST',
        url: `/api/v1/models/${modelId}/sensitivity`,
        headers: authed(owner.cookie),
        payload: { rows: { variable: 'saleMonth', values: ['24', '0'] } },
      });
      expect(response.statusCode).toBe(400);
      const body = response.json() as { error: { message: string } };
      expect(body.error.message).toMatch(/positive whole number/);
    });

    it('computes a grid of the expected shape for valid values', async () => {
      const response = await ctx.app.inject({
        method: 'POST',
        url: `/api/v1/models/${modelId}/sensitivity`,
        headers: authed(owner.cookie),
        payload: {
          rows: { variable: 'discountRate', values: ['0.07', '0.08', '0.09'] },
          columns: { variable: 'terminalCapRate', values: ['0.06', '0.07'] },
        },
      });
      expect(response.statusCode).toBe(200);
      const body = response.json() as { grid: string[][] };
      expect(body.grid).toHaveLength(3);
      expect(body.grid.every((row) => row.length === 2)).toBe(true);
    });
  });

  describe('POST /models/:id/scenario-batch', () => {
    it('rejects a batch with a malformed override before enqueueing a job', async () => {
      const response = await ctx.app.inject({
        method: 'POST',
        url: `/api/v1/models/${modelId}/scenario-batch`,
        headers: authed(owner.cookie),
        payload: {
          scenarios: [
            { name: 'Base', overrides: [{ variable: 'discountRate', value: '0.08' }] },
            { name: 'Bad sale month', overrides: [{ variable: 'saleMonth', value: 'soon' }] },
          ],
        },
      });
      expect(response.statusCode).toBe(400);
      const body = response.json() as { error: { message: string }; jobId?: string };
      expect(body.error.message).toContain('Bad sale month');
      expect(body.jobId).toBeUndefined();
    });

    it('accepts a batch of valid overrides and returns a pollable job', async () => {
      const response = await ctx.app.inject({
        method: 'POST',
        url: `/api/v1/models/${modelId}/scenario-batch`,
        headers: authed(owner.cookie),
        payload: {
          scenarios: [
            { name: 'Base', overrides: [{ variable: 'discountRate', value: '0.08' }] },
            { name: 'Wider exit', overrides: [{ variable: 'terminalCapRate', value: '0.075' }] },
          ],
        },
      });
      expect(response.statusCode).toBe(200);
      const body = response.json() as { jobId: string; status: string };
      expect(body.jobId).toBeTruthy();

      const job = await getJob(ctx.sql, body.jobId);
      expect(job?.status).toBe('queued');
    });
  });

  describe('run_scenario_batch worker handler (defense in depth)', () => {
    async function runBatch(overrides: Array<{ variable: string; value: string }>) {
      const enqueued = await enqueueJob(ctx.sql, {
        organizationId,
        kind: 'run_scenario_batch',
        payload: { modelId, scenarios: [{ name: 'Direct', overrides }] },
      });
      // Claim this specific job by id, rather than `claimJob`'s "next in
      // queue" pick — an earlier test in this file may have left its own
      // queued (never claimed) job ahead of this one.
      await ctx.sql`
        UPDATE jobs SET status = 'running', locked_at = now(), locked_by = 'test-worker',
          attempts = attempts + 1
        WHERE id = ${enqueued.id}
      `;
      const claimed = await getJob(ctx.sql, enqueued.id);
      return handlers.run_scenario_batch(ctx.sql, claimed!);
    }

    it('throws a clear error for a non-numeric decimal override, never reaching decimal.js', async () => {
      await expect(runBatch([{ variable: 'terminalCapRate', value: 'abc' }])).rejects.toThrow(
        /terminalCapRate.*decimal number/,
      );
    });

    it('throws a clear error for an out-of-shape saleMonth override', async () => {
      await expect(runBatch([{ variable: 'saleMonth', value: '-3' }])).rejects.toThrow(
        /positive whole number/,
      );
    });
  });
});

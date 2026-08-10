import { describe, expect, it } from 'vitest';
import { ENGINE_VERSION } from '@cre/calculation-engine';
import { createTestContext, hasDatabase, type TestContext } from './helpers.js';

/**
 * The application's own version, surfaced.
 *
 * A support conversation has to be able to establish exactly what customer
 * software produced a result: which build of the application handled the
 * request, and which engine version calculated the numbers inside it. Both
 * are read from the same public health check a load balancer already polls,
 * so establishing them never depends on a session being valid.
 */
describe.skipIf(!hasDatabase)('application version', () => {
  it('reports the app version and the engine version on the public health check', async () => {
    let ctx: TestContext | undefined;
    try {
      ctx = await createTestContext();
      const response = await ctx.app.inject({ method: 'GET', url: '/api/v1/health' });
      expect(response.statusCode).toBe(200);
      const body = response.json() as { appVersion: string; engineVersion: string };
      expect(body.appVersion).toMatch(/^\d+\.\d+\.\d+$/);
      // Not re-declared here: read from the engine itself, so a bump to one
      // cannot silently leave the other's test believing a stale figure.
      expect(body.engineVersion).toBe(ENGINE_VERSION);
    } finally {
      await ctx?.close();
    }
  }, 60_000);
});

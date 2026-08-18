import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestContext, hasDatabase, HEADERS, type TestContext } from './helpers.js';

/**
 * Rate limiting: the global 600/min ceiling, and the tighter 10/min override
 * on authentication routes.
 *
 * Registered in `server.ts` (global) and `auth.ts` (`authLimit`, applied to
 * `/auth/register` and `/auth/login`) since the security-hardening pass, but
 * no test had ever actually driven a route past either limit — the 429 path
 * itself, and the fact that the tighter limit is scoped to auth routes rather
 * than applied globally, were both unexercised.
 */
describe.skipIf(!hasDatabase)('rate limiting', () => {
  let ctx: TestContext;

  beforeAll(async () => {
    ctx = await createTestContext();
  }, 60_000);

  afterAll(async () => {
    await ctx?.close();
  });

  it('refuses the 11th login attempt in a minute from the same client', async () => {
    const attempt = () =>
      ctx.app.inject({
        method: 'POST',
        url: '/api/v1/auth/login',
        headers: HEADERS,
        payload: { email: 'nobody@example.invalid', password: 'wrong-password-value' },
      });

    const responses = [];
    for (let i = 0; i < 11; i += 1) {
      responses.push(await attempt());
    }

    // The first ten are refused for being wrong, not for being rate limited —
    // every one of them has to actually reach the handler.
    for (const response of responses.slice(0, 10)) {
      expect(response.statusCode).toBe(401);
    }
    expect(responses[10]?.statusCode).toBe(429);
  });

  it('does not apply the tighter auth limit to an ordinary route', async () => {
    const responses = [];
    for (let i = 0; i < 15; i += 1) {
      responses.push(await ctx.app.inject({ method: 'GET', url: '/api/v1/health' }));
    }

    // Fifteen requests in the same window would trip the 10/min auth limit,
    // but /health carries only the global 600/min ceiling.
    for (const response of responses) {
      expect(response.statusCode).toBe(200);
    }
  });
});

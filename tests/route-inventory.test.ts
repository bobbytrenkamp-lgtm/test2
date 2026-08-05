import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestContext, hasDatabase, type TestContext } from './helpers.js';

/**
 * Every route, held to the same rule.
 *
 * `tests/authorization.test.ts` checks specific endpoints, chosen by hand. That
 * is worth having and it has a hole the shape of every route nobody thought to
 * add to it: an endpoint registered tomorrow without an authorization check
 * passes the whole suite, because no test knows it exists.
 *
 * This walks the router's own inventory instead, so a new route is covered the
 * moment it is registered. Making one public is still possible and is now a
 * deliberate act: it has to be named in `PUBLIC` below, with a reason, in the
 * same change that adds it.
 */

/**
 * Routes that are reachable without a session, and why each has to be.
 *
 * Everything here is an authentication path — the endpoints somebody must be
 * able to reach in order to *get* a session — plus the health check a load
 * balancer polls before any user exists.
 */
const PUBLIC = new Map<string, string>([
  [
    'OPTIONS *',
    'The CORS preflight handler. A preflight carries no credentials and returns ' +
      'no data — only which methods and headers are allowed — and the browser ' +
      'sends it before it will send the real request. It is listed here rather ' +
      'than left to pass incidentally: injecting it returns 400 because "*" is ' +
      'not a URL, which would have looked like a refusal without being one.',
  ],
  ['GET /api/v1/health', 'Polled by a load balancer, which has no session.'],
  ['POST /api/v1/auth/register', 'Creating the first account. Gated by ALLOW_SELF_REGISTRATION.'],
  ['POST /api/v1/auth/login', 'The endpoint that issues a session.'],
  ['POST /api/v1/auth/logout', 'Must succeed for a session that is already gone.'],
  ['POST /api/v1/auth/password-reset/request', 'Reached by somebody locked out.'],
  ['POST /api/v1/auth/password-reset/confirm', 'Reached by somebody locked out.'],
]);

/** The header the CSRF check requires; without it every write is a 403. */
const HEADERS = { 'x-requested-with': 'cre-platform' };

describe.skipIf(!hasDatabase)('route inventory', () => {
  let ctx: TestContext;

  beforeAll(async () => {
    ctx = await createTestContext();
  }, 90_000);

  afterAll(async () => {
    await ctx?.close();
  });

  /** A path with its parameters filled in, so routing reaches the handler. */
  function concrete(url: string): string {
    // The value is a syntactically valid uuid that will not exist. Reaching a
    // "not found" is fine; the assertion is about *authentication*, which is
    // checked before anything is looked up.
    return url.replace(/:[A-Za-z0-9_]+/g, '00000000-0000-4000-8000-000000000000');
  }

  it('registers routes at all, so an empty inventory cannot pass silently', () => {
    // Without this, a broken hook would make every assertion below vacuous by
    // iterating nothing.
    expect(ctx.app.routeInventory.length).toBeGreaterThan(40);
  });

  it('refuses an unauthenticated request to every non-public route', async () => {
    const reachable: string[] = [];

    for (const route of ctx.app.routeInventory) {
      const key = `${route.method} ${route.url}`;
      if (PUBLIC.has(key)) continue;

      const response = await ctx.app.inject({
        method: route.method as 'GET',
        url: concrete(route.url),
        headers: HEADERS,
      });

      /*
       * 401 is the answer this is looking for. 403, 404 and 405 are also
       * refusals — a route can reject on CSRF, or route to a method it does
       * not implement — and anything below 400 means the request was served
       * without a session, which is the failure.
       *
       * A 500 is not accepted either: a handler that crashes before its
       * authorization check has not refused anything, it has just failed
       * loudly, and the next change might make it fail quietly.
       */
      if (response.statusCode < 400 || response.statusCode >= 500) {
        reachable.push(`${key} → ${response.statusCode}`);
      }
    }

    expect(
      reachable,
      'These routes answered an unauthenticated request. Either require a\n' +
        'capability in the handler, or add the route to PUBLIC with the reason\n' +
        'it has to be reachable without a session:\n' +
        reachable.join('\n'),
    ).toEqual([]);
  });

  it('keeps the public list honest — every entry still exists', () => {
    // A stale allowlist entry is how a route quietly becomes exempt: the path
    // is renamed, the old key lingers, and one day it matches something new.
    const registered = new Set(
      ctx.app.routeInventory.map((route) => `${route.method} ${route.url}`),
    );
    const stale = [...PUBLIC.keys()].filter((key) => !registered.has(key));
    expect(stale, `Listed as public but not registered: ${stale.join(', ')}`).toEqual([]);
  });

  it('gives every public route a stated reason', () => {
    // The reason is the control. An allowlist people append to without
    // explaining is one nobody reviews.
    for (const [key, reason] of PUBLIC) {
      expect(reason.length, `${key} needs a reason`).toBeGreaterThan(20);
    }
  });

  it('requires the CSRF header on every state-changing route', async () => {
    const unprotected: string[] = [];

    for (const route of ctx.app.routeInventory) {
      if (['GET', 'HEAD', 'OPTIONS'].includes(route.method)) continue;

      const response = await ctx.app.inject({
        method: route.method as 'POST',
        url: concrete(route.url),
        // Deliberately no X-Requested-With: this is the cross-site form post a
        // SameSite=Lax cookie would otherwise still travel with.
      });
      if (response.statusCode !== 403) {
        unprotected.push(`${route.method} ${route.url} → ${response.statusCode}`);
      }
    }

    expect(
      unprotected,
      'These state-changing routes answered without the X-Requested-With header,\n' +
        'which is what stops a cross-site form post:\n' +
        unprotected.join('\n'),
    ).toEqual([]);
  });
});

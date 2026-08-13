import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  fingerprintOf,
  findErrorEventByReference,
  listErrorGroups,
  pruneErrors,
  recordError,
  referenceFor,
} from '@cre/database';
import {
  authed,
  createTestContext,
  hasDatabase,
  registerActor,
  type Actor,
  type TestContext,
} from './helpers.js';

/**
 * Recorded server faults.
 *
 * Two things are being tested, and the second matters more than the first.
 *
 * That faults are recorded and grouped, so one route failing four thousand
 * times reads as one problem rather than four thousand.
 *
 * And that the store holds nothing it should not. An error store is a copy of
 * production data under weaker access controls unless it is disciplined about
 * that, and on a platform holding rent rolls the discipline has to be
 * structural. These tests assert the absence of request bodies, query values
 * and session tokens directly, because "we do not log that" is a claim and a
 * test is evidence.
 */
describe.skipIf(!hasDatabase)('error monitoring', () => {
  let ctx: TestContext;
  let owner: Actor;
  let readOnlyCookie: string;
  let organizationId: string;

  beforeAll(async () => {
    ctx = await createTestContext();
    owner = await registerActor(ctx.app, 'errors@example.invalid', 'Error Reader');
    const organization = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/organizations',
      headers: authed(owner.cookie),
      payload: { name: 'Error Partners' },
    });
    organizationId = (organization.json() as { organization: { id: string } }).organization.id;

    // A read-only member of the same organization. Testing the refusal against
    // someone with no organization at all would prove nothing about the
    // capability: they are turned away a step earlier.
    const viewer = await registerActor(ctx.app, 'error-viewer@example.invalid', 'Viewer');
    const invitation = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/organizations/${organizationId}/invitations`,
      headers: authed(owner.cookie),
      payload: { email: 'error-viewer@example.invalid', role: 'read_only' },
    });
    await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/invitations/accept',
      headers: authed(viewer.cookie),
      payload: { token: (invitation.json() as { token: string }).token },
    });
    readOnlyCookie = viewer.cookie;
  }, 60_000);

  afterAll(async () => {
    await ctx?.close();
  });

  describe('grouping', () => {
    it('gives the same fingerprint to the same fault on different records', () => {
      // "model 8f2c… not found" and "model 41ab… not found" are one problem.
      // Grouping them apart would report it as thousands, which is the failure
      // mode that makes people stop reading an error list.
      const a = fingerprintOf({
        method: 'GET',
        route: '/models/:id',
        errorName: 'TypeError',
        message:
          'Cannot read properties of undefined for model 8f2c1d90-0000-4000-8000-000000000001',
      });
      const b = fingerprintOf({
        method: 'GET',
        route: '/models/:id',
        errorName: 'TypeError',
        message:
          'Cannot read properties of undefined for model 41ab77e2-0000-4000-8000-000000000002',
      });
      expect(a).toBe(b);
    });

    it('gives different fingerprints to different faults', () => {
      const a = fingerprintOf({
        method: 'GET',
        route: '/models/:id',
        errorName: 'TypeError',
        message: 'Cannot read properties of undefined',
      });
      const b = fingerprintOf({
        method: 'POST',
        route: '/models/:id',
        errorName: 'TypeError',
        message: 'Cannot read properties of undefined',
      });
      const c = fingerprintOf({
        method: 'GET',
        route: '/models/:id',
        errorName: 'RangeError',
        message: 'Cannot read properties of undefined',
      });
      expect(new Set([a, b, c]).size).toBe(3);
    });

    it('counts repeats within one organization', async () => {
      // One tenant hitting a fault repeatedly is a support conversation, and
      // the list has to make that visible without opening anything.
      const route = `/test/${Math.random().toString(36).slice(2)}`;
      for (let i = 0; i < 3; i += 1) {
        await recordError(ctx.sql, {
          method: 'POST',
          route,
          statusCode: 500,
          errorName: 'TestError',
          message: `Something failed for record ${i}`,
          organizationId,
        });
      }

      const groups = await listErrorGroups(ctx.sql, organizationId, { limit: 200 });
      const group = groups.find((entry) => entry.route === route);
      expect(group?.occurrences).toBe(3);
    });

    it("does not count another organization's occurrences of the same fault", async () => {
      // Grouping happens within `listErrorGroups`' own scoping, not across
      // it: the same fingerprint recorded for two different organizations is
      // two separate three-occurrence groups from each organization's own
      // point of view, never a shared six.
      const stranger = await registerActor(ctx.app, 'errors-stranger@example.invalid', 'Stranger');
      const strangerOrg = await ctx.app.inject({
        method: 'POST',
        url: '/api/v1/organizations',
        headers: authed(stranger.cookie),
        payload: { name: 'Unrelated Holdings' },
      });
      const strangerOrgId = (strangerOrg.json() as { organization: { id: string } }).organization
        .id;

      const route = `/test/${Math.random().toString(36).slice(2)}`;
      await recordError(ctx.sql, {
        method: 'POST',
        route,
        statusCode: 500,
        errorName: 'TestError',
        message: 'shared shape, different tenants',
        organizationId,
      });
      await recordError(ctx.sql, {
        method: 'POST',
        route,
        statusCode: 500,
        errorName: 'TestError',
        message: 'shared shape, different tenants',
        organizationId: strangerOrgId,
      });

      const ownerGroups = await listErrorGroups(ctx.sql, organizationId, { limit: 200 });
      expect(ownerGroups.find((entry) => entry.route === route)?.occurrences).toBe(1);

      const strangerGroups = await listErrorGroups(ctx.sql, strangerOrgId, { limit: 200 });
      expect(strangerGroups.find((entry) => entry.route === route)?.occurrences).toBe(1);
    });
  });

  describe('what the store holds', () => {
    it('records nothing when recording itself fails', async () => {
      // An error handler that can fail is worse than none: the caller would see
      // the recorder's failure instead of the response. This passes a broken
      // input and requires no throw.
      await expect(
        recordError(ctx.sql, {
          method: 'GET',
          route: '/test/unwritable',
          statusCode: 500,
          errorName: 'TestError',
          message: 'x',
          organizationId: 'not-a-uuid',
        }),
      ).resolves.toBeNull();
    });

    it('truncates rather than storing an unbounded message', async () => {
      const route = `/test/${Math.random().toString(36).slice(2)}`;
      await recordError(ctx.sql, {
        method: 'GET',
        route,
        statusCode: 500,
        errorName: 'TestError',
        message: 'x'.repeat(50_000),
        stack: 'y'.repeat(50_000),
      });
      const rows = (await ctx.sql`
        SELECT length(message) AS message_length, length(stack) AS stack_length
        FROM error_events WHERE route = ${route}
      `) as unknown as Array<{ message_length: number; stack_length: number }>;
      expect(rows[0]?.message_length).toBeLessThanOrEqual(2000);
      expect(rows[0]?.stack_length).toBeLessThanOrEqual(8000);
    });

    it('has no column for a request body, a query value or a session token', async () => {
      /*
       * Asserted against the schema rather than against one write, because the
       * guarantee is that the store *cannot* hold these — not that today's
       * caller happens not to pass them. A column added later would fail here
       * and have to be argued for.
       */
      const columns = (await ctx.sql`
        SELECT column_name FROM information_schema.columns
        WHERE table_name = 'error_events'
      `) as unknown as Array<{ column_name: string }>;
      const names = columns.map((column) => column.column_name);

      expect(names).not.toContain('body');
      expect(names).not.toContain('request_body');
      expect(names).not.toContain('query');
      expect(names).not.toContain('headers');
      expect(names).not.toContain('session_token');
      expect(names).not.toContain('cookie');
      // And the ones it does have, so a rename cannot make the assertions above
      // pass by accident.
      expect(names).toEqual(expect.arrayContaining(['fingerprint', 'route', 'message', 'stack']));
    });

    it('prunes what is older than the retention window, and keeps what is not', async () => {
      // A table that only grows fills the disk the database is on, turning a
      // monitoring convenience into an outage.
      const route = `/test/${Math.random().toString(36).slice(2)}`;
      await ctx.sql`
        INSERT INTO error_events (fingerprint, occurred_at, method, route, status_code, error_name, message)
        VALUES ('old', now() - interval '200 days', 'GET', ${route}, 500, 'TestError', 'old')
      `;
      await recordError(ctx.sql, {
        method: 'GET',
        route,
        statusCode: 500,
        errorName: 'TestError',
        message: 'recent',
      });

      const removed = await pruneErrors(ctx.sql, 90);
      expect(removed).toBeGreaterThanOrEqual(1);

      const remaining = (await ctx.sql`
        SELECT message FROM error_events WHERE route = ${route}
      `) as unknown as Array<{ message: string }>;
      expect(remaining.map((row) => row.message)).toEqual(['recent']);
    });
  });

  describe('support references', () => {
    it('returns the id a fault was recorded under, so a reference can be built from it', async () => {
      const route = `/test/${Math.random().toString(36).slice(2)}`;
      const id = await recordError(ctx.sql, {
        method: 'GET',
        route,
        statusCode: 500,
        errorName: 'TestError',
        message: 'reference check',
      });
      expect(id).not.toBeNull();
      expect(referenceFor(id as string)).toBe(`ERR-${id}`);
    });

    it('finds the same event back by its reference, or by the bare id', async () => {
      const route = `/test/${Math.random().toString(36).slice(2)}`;
      const id = await recordError(ctx.sql, {
        method: 'POST',
        route,
        statusCode: 500,
        errorName: 'TestError',
        message: 'lookup check',
        organizationId,
      });
      const reference = referenceFor(id as string);

      const byReference = await findErrorEventByReference(ctx.sql, reference, organizationId);
      expect(byReference?.route).toBe(route);

      const byBareId = await findErrorEventByReference(ctx.sql, String(id), organizationId);
      expect(byBareId?.route).toBe(route);
    });

    it('returns null for a reference naming no recorded fault, rather than guessing', async () => {
      expect(await findErrorEventByReference(ctx.sql, 'ERR-999999999', organizationId)).toBeNull();
    });

    it('refuses a reference that is not shaped like one, rather than treating it as a wildcard', async () => {
      // A non-numeric reference could otherwise be interpreted by a looser
      // lookup as "match everything" and hand back an unrelated fault.
      expect(
        await findErrorEventByReference(ctx.sql, 'ERR-not-a-number', organizationId),
      ).toBeNull();
      expect(await findErrorEventByReference(ctx.sql, '', organizationId)).toBeNull();
    });

    it("does not find another organization's event by reference", async () => {
      const route = `/test/${Math.random().toString(36).slice(2)}`;
      const id = await recordError(ctx.sql, {
        method: 'POST',
        route,
        statusCode: 500,
        errorName: 'TestError',
        message: 'cross-organization lookup check',
        organizationId,
      });
      const reference = referenceFor(id as string);

      const stranger = await registerActor(
        ctx.app,
        'errors-ref-stranger@example.invalid',
        'Stranger',
      );
      const strangerOrg = await ctx.app.inject({
        method: 'POST',
        url: '/api/v1/organizations',
        headers: authed(stranger.cookie),
        payload: { name: 'Unrelated Holdings' },
      });
      const strangerOrgId = (strangerOrg.json() as { organization: { id: string } }).organization
        .id;

      expect(await findErrorEventByReference(ctx.sql, reference, strangerOrgId)).toBeNull();
    });
  });

  describe('the route', () => {
    it('serves the grouped list to someone who may read the audit log', async () => {
      const response = await ctx.app.inject({
        method: 'GET',
        url: '/api/v1/operations/errors',
        headers: authed(owner.cookie),
      });
      expect(response.statusCode).toBe(200);
      const body = response.json() as { groups: unknown[]; sinceHours: number };
      expect(Array.isArray(body.groups)).toBe(true);
      expect(body.sinceHours).toBe(24 * 7);
    });

    it('refuses a member of the same organization who may not read the audit log', async () => {
      // A read-only member sees models but not operational history, and a fault
      // record is operational history — it names routes and stack frames.
      const response = await ctx.app.inject({
        method: 'GET',
        url: '/api/v1/operations/errors',
        headers: authed(readOnlyCookie),
      });
      expect(response.statusCode).toBe(403);
    });

    it('does not turn a client mistake into a recorded server fault', async () => {
      // A 404 or a 400 is the caller's to fix. Recording them would bury the
      // faults that are actually ours under noise nobody can act on.
      const before =
        (await ctx.sql`SELECT count(*)::int AS n FROM error_events`) as unknown as Array<{
          n: number;
        }>;

      await ctx.app.inject({
        method: 'GET',
        url: '/api/v1/models/00000000-0000-0000-0000-000000000000',
        headers: authed(owner.cookie),
      });
      await ctx.app.inject({
        method: 'POST',
        url: '/api/v1/properties',
        headers: authed(owner.cookie),
        payload: { name: '' },
      });

      const after =
        (await ctx.sql`SELECT count(*)::int AS n FROM error_events`) as unknown as Array<{
          n: number;
        }>;
      expect(after[0]?.n).toBe(before[0]?.n);
    });

    it('resolves a support reference for someone who may read the audit log', async () => {
      const route = `/test/${Math.random().toString(36).slice(2)}`;
      const id = await recordError(ctx.sql, {
        method: 'GET',
        route,
        statusCode: 500,
        errorName: 'TestError',
        message: 'route lookup check',
        organizationId,
      });

      const response = await ctx.app.inject({
        method: 'GET',
        url: `/api/v1/operations/errors/reference/${referenceFor(id as string)}`,
        headers: authed(owner.cookie),
      });
      expect(response.statusCode).toBe(200);
      const body = response.json() as { event: { route: string } };
      expect(body.event.route).toBe(route);
    });

    it('reports a plain 404 for a reference naming nothing, not a raw lookup failure', async () => {
      const response = await ctx.app.inject({
        method: 'GET',
        url: '/api/v1/operations/errors/reference/ERR-999999999',
        headers: authed(owner.cookie),
      });
      expect(response.statusCode).toBe(404);
    });

    it('refuses a reference lookup to someone who may not read the audit log', async () => {
      const response = await ctx.app.inject({
        method: 'GET',
        url: '/api/v1/operations/errors/reference/ERR-1',
        headers: authed(readOnlyCookie),
      });
      expect(response.statusCode).toBe(403);
    });

    /*
     * `audit:read` is granted per organization — every self-registered
     * organization's own owner holds it over their own audit log — so a
     * fault's `message` and `stack` (which this store's own docstring says
     * can hold SQL, file paths or model data) must not be readable through
     * these routes by a *different* organization's `audit:read` holder, even
     * though nothing about the request otherwise looks unauthorized.
     */
    it("does not serve another organization's recorded faults through the grouped list, the fingerprint drill-down or a reference lookup", async () => {
      const route = `/test/${Math.random().toString(36).slice(2)}`;
      const id = await recordError(ctx.sql, {
        method: 'GET',
        route,
        statusCode: 500,
        errorName: 'TestError',
        message: 'this organization only',
        organizationId,
      });
      const fingerprint = fingerprintOf({
        method: 'GET',
        route,
        errorName: 'TestError',
        message: 'this organization only',
      });
      const reference = referenceFor(id as string);

      const stranger = await registerActor(
        ctx.app,
        'errors-route-stranger@example.invalid',
        'Stranger',
      );
      await ctx.app.inject({
        method: 'POST',
        url: '/api/v1/organizations',
        headers: authed(stranger.cookie),
        payload: { name: 'Unrelated Holdings' },
      });

      const groups = await ctx.app.inject({
        method: 'GET',
        url: '/api/v1/operations/errors?sinceHours=1',
        headers: authed(stranger.cookie),
      });
      expect(
        (groups.json() as { groups: Array<{ route: string }> }).groups.some(
          (group) => group.route === route,
        ),
      ).toBe(false);

      const events = await ctx.app.inject({
        method: 'GET',
        url: `/api/v1/operations/errors/${fingerprint}`,
        headers: authed(stranger.cookie),
      });
      expect((events.json() as { events: unknown[] }).events).toEqual([]);

      const byReference = await ctx.app.inject({
        method: 'GET',
        url: `/api/v1/operations/errors/reference/${reference}`,
        headers: authed(stranger.cookie),
      });
      // Not found, not a bare refusal: the response cannot confirm the fault
      // exists at all, the same shape `favourites.test.ts` and
      // `debt-sizing.test.ts` use for a resource outside the caller's
      // organization.
      expect(byReference.statusCode).toBe(404);
    });
  });
});

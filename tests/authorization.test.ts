import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  HEADERS,
  authed,
  createTestContext,
  hasDatabase,
  registerActor,
  signIn,
  type Actor,
  type TestContext,
} from './helpers.js';

/**
 * Authentication and authorization.
 *
 * The cross-organization tests are the important ones: they construct two real
 * organizations with real data and prove that a member of one cannot read or
 * write the other's records even when handed the exact identifiers. A platform
 * holding several clients' rent rolls has to be right about this.
 */
describe.skipIf(!hasDatabase)('authorization', () => {
  let ctx: TestContext;

  // Organization A
  let ownerA: Actor;
  let orgA: string;
  let propertyA: string;
  let modelA: string;

  // Organization B
  let ownerB: Actor;
  let orgB: string;

  // A read-only member of organization A.
  let viewerCookie: string;

  beforeAll(async () => {
    ctx = await createTestContext();

    ownerA = await registerActor(ctx.app, 'owner-a@example.invalid', 'Owner A');
    orgA = await createOrganization(ownerA.cookie, 'Alpha Capital');
    propertyA = await createProperty(ownerA.cookie, 'Alpha Tower');
    modelA = await createModel(ownerA.cookie, propertyA, 'Alpha base case');

    ownerB = await registerActor(ctx.app, 'owner-b@example.invalid', 'Owner B');
    orgB = await createOrganization(ownerB.cookie, 'Beta Holdings');

    // A viewer joins organization A through an invitation.
    const viewer = await registerActor(ctx.app, 'viewer-a@example.invalid', 'Viewer A');
    const invitation = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/organizations/${orgA}/invitations`,
      headers: authed(ownerA.cookie),
      payload: { email: 'viewer-a@example.invalid', role: 'read_only' },
    });
    const token = (invitation.json() as { token: string }).token;
    await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/invitations/accept',
      headers: authed(viewer.cookie),
      payload: { token },
    });
    viewerCookie = viewer.cookie;
  }, 60_000);

  afterAll(async () => {
    await ctx?.close();
  });

  async function createOrganization(cookie: string, name: string): Promise<string> {
    const response = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/organizations',
      headers: authed(cookie),
      payload: { name },
    });
    return (response.json() as { organization: { id: string } }).organization.id;
  }

  async function createProperty(cookie: string, name: string): Promise<string> {
    const response = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/properties',
      headers: authed(cookie),
      payload: { name, propertyType: 'office', rentableArea: '10000' },
    });
    return (response.json() as { property: { id: string } }).property.id;
  }

  async function createModel(cookie: string, propertyId: string, name: string): Promise<string> {
    const response = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/models',
      headers: authed(cookie),
      payload: {
        propertyId,
        name,
        classification: 'valuation',
        valuationDate: '2026-01-01',
        forecastStartDate: '2026-01-01',
        forecastMonths: 24,
        discountRate: '0.08',
        terminalCapRate: '0.07',
        terminalNoiBasis: 'trailing_12',
        saleMonth: 24,
      },
    });
    return (response.json() as { model: { id: string } }).model.id;
  }

  /* ---------------------------------------------------------------------- */
  /* Authentication                                                          */
  /* ---------------------------------------------------------------------- */

  it('refuses an unauthenticated request', async () => {
    const response = await ctx.app.inject({ method: 'GET', url: '/api/v1/properties' });
    expect(response.statusCode).toBe(401);
  });

  it('refuses a forged session cookie', async () => {
    const response = await ctx.app.inject({
      method: 'GET',
      url: '/api/v1/properties',
      headers: { cookie: 'cre_session=not-a-real-token' },
    });
    expect(response.statusCode).toBe(401);
  });

  it('refuses a state-changing request without the CSRF header', async () => {
    const response = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/properties',
      headers: { cookie: ownerA.cookie, 'content-type': 'application/json' },
      payload: { name: 'Should not be created', propertyType: 'office' },
    });
    expect(response.statusCode).toBe(403);
    expect((response.json() as { error: { code: string } }).error.code).toBe('CSRF_CHECK_FAILED');
  });

  it('does not disclose whether an email is registered', async () => {
    const known = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      headers: HEADERS,
      payload: { email: 'owner-a@example.invalid', password: 'wrong-password-entirely' },
    });
    const unknown = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      headers: HEADERS,
      payload: { email: 'nobody@example.invalid', password: 'wrong-password-entirely' },
    });
    expect(known.statusCode).toBe(401);
    expect(unknown.statusCode).toBe(401);
    expect(known.json()).toEqual(unknown.json());
  });

  it('rejects a password below the policy length', async () => {
    const response = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/auth/register',
      headers: HEADERS,
      payload: { email: 'short@example.invalid', name: 'Short', password: 'short' },
    });
    expect(response.statusCode).toBe(400);
  });

  it('invalidates the session on sign out', async () => {
    const cookie = await signIn(ctx.app, 'owner-b@example.invalid');
    const before = await ctx.app.inject({
      method: 'GET',
      url: '/api/v1/auth/me',
      headers: authed(cookie),
    });
    expect(before.statusCode).toBe(200);

    await ctx.app.inject({ method: 'POST', url: '/api/v1/auth/logout', headers: authed(cookie) });

    const after = await ctx.app.inject({
      method: 'GET',
      url: '/api/v1/auth/me',
      headers: authed(cookie),
    });
    expect(after.statusCode).toBe(401);
  });

  /* ---------------------------------------------------------------------- */
  /* Cross-organization isolation                                            */
  /* ---------------------------------------------------------------------- */

  describe('cross-organization access', () => {
    it('does not list another organization’s properties', async () => {
      const response = await ctx.app.inject({
        method: 'GET',
        url: '/api/v1/properties',
        headers: authed(ownerB.cookie),
      });
      expect(response.statusCode).toBe(200);
      const names = (response.json() as { properties: Array<{ name: string }> }).properties.map(
        (property) => property.name,
      );
      expect(names).not.toContain('Alpha Tower');
    });

    it('returns 404 rather than 403 when reading another organization’s property', async () => {
      // Reporting "forbidden" would confirm the identifier exists, which is
      // itself a disclosure. An unreachable record is simply not found.
      const response = await ctx.app.inject({
        method: 'GET',
        url: `/api/v1/properties/${propertyA}`,
        headers: authed(ownerB.cookie),
      });
      expect(response.statusCode).toBe(404);
    });

    it('refuses to modify another organization’s property', async () => {
      const response = await ctx.app.inject({
        method: 'PATCH',
        url: `/api/v1/properties/${propertyA}`,
        headers: authed(ownerB.cookie),
        payload: { name: 'Hijacked' },
      });
      expect(response.statusCode).toBe(404);

      const check = await ctx.app.inject({
        method: 'GET',
        url: `/api/v1/properties/${propertyA}`,
        headers: authed(ownerA.cookie),
      });
      expect((check.json() as { property: { name: string } }).property.name).toBe('Alpha Tower');
    });

    it('refuses to read another organization’s model', async () => {
      const response = await ctx.app.inject({
        method: 'GET',
        url: `/api/v1/models/${modelA}`,
        headers: authed(ownerB.cookie),
      });
      expect(response.statusCode).toBe(404);
    });

    it('refuses to calculate another organization’s model', async () => {
      const response = await ctx.app.inject({
        method: 'POST',
        url: `/api/v1/models/${modelA}/calculate`,
        headers: authed(ownerB.cookie),
        payload: {},
      });
      expect(response.statusCode).toBe(404);
    });

    it('refuses to write a lease into another organization’s model', async () => {
      const response = await ctx.app.inject({
        method: 'PUT',
        url: `/api/v1/models/${modelA}/leases/INTRUDER`,
        headers: authed(ownerB.cookie),
        payload: {
          tenantId: '00000000-0000-0000-0000-000000000000',
          status: 'occupied',
          area: '1000',
          commencementDate: '2026-01-01',
          expirationDate: '2027-01-01',
          baseRent: '1',
          baseRentBasis: 'per_area_per_year',
        },
      });
      expect(response.statusCode).toBe(404);
    });

    it('refuses to export another organization’s model', async () => {
      const response = await ctx.app.inject({
        method: 'GET',
        url: `/api/v1/models/${modelA}/export/json`,
        headers: authed(ownerB.cookie),
      });
      expect(response.statusCode).toBe(404);
    });

    it('does not surface another organization’s audit entries', async () => {
      const response = await ctx.app.inject({
        method: 'GET',
        url: '/api/v1/audit',
        headers: authed(ownerB.cookie),
      });
      expect(response.statusCode).toBe(200);
      const entries = (response.json() as { entries: Array<{ entity_id: string | null }> }).entries;
      expect(entries.some((entry) => entry.entity_id === propertyA)).toBe(false);
    });

    it('refuses to switch into an organization the user does not belong to', async () => {
      const response = await ctx.app.inject({
        method: 'POST',
        url: `/api/v1/organizations/${orgA}/switch`,
        headers: authed(ownerB.cookie),
      });
      expect(response.statusCode).toBe(403);
    });

    it('refuses to manage members of another organization', async () => {
      const response = await ctx.app.inject({
        method: 'GET',
        url: `/api/v1/organizations/${orgA}/members`,
        headers: authed(ownerB.cookie),
      });
      expect(response.statusCode).toBe(403);
    });
  });

  /* ---------------------------------------------------------------------- */
  /* Role capabilities                                                       */
  /* ---------------------------------------------------------------------- */

  describe('role capabilities', () => {
    it('lets a read-only member read', async () => {
      const response = await ctx.app.inject({
        method: 'GET',
        url: `/api/v1/properties/${propertyA}`,
        headers: authed(viewerCookie),
      });
      expect(response.statusCode).toBe(200);
    });

    it('stops a read-only member creating a property', async () => {
      const response = await ctx.app.inject({
        method: 'POST',
        url: '/api/v1/properties',
        headers: authed(viewerCookie),
        payload: { name: 'Viewer property', propertyType: 'office' },
      });
      expect(response.statusCode).toBe(403);
    });

    it('stops a read-only member editing a model', async () => {
      const response = await ctx.app.inject({
        method: 'PATCH',
        url: `/api/v1/models/${modelA}`,
        headers: authed(viewerCookie),
        payload: { name: 'Renamed by a viewer' },
      });
      expect(response.statusCode).toBe(403);
    });

    it('stops a read-only member calculating', async () => {
      const response = await ctx.app.inject({
        method: 'POST',
        url: `/api/v1/models/${modelA}/calculate`,
        headers: authed(viewerCookie),
        payload: {},
      });
      expect(response.statusCode).toBe(403);
    });

    it('stops a read-only member reading the audit log', async () => {
      const response = await ctx.app.inject({
        method: 'GET',
        url: '/api/v1/audit',
        headers: authed(viewerCookie),
      });
      expect(response.statusCode).toBe(403);
    });

    it('reports the capabilities the client should render against', async () => {
      const response = await ctx.app.inject({
        method: 'GET',
        url: '/api/v1/auth/me',
        headers: authed(viewerCookie),
      });
      const body = response.json() as { role: string; capabilities: string[] };
      expect(body.role).toBe('read_only');
      expect(body.capabilities).toContain('property:read');
      expect(body.capabilities).not.toContain('property:write');
      expect(body.capabilities).not.toContain('model:calculate');
    });
  });

  /* ---------------------------------------------------------------------- */
  /* Organization integrity                                                  */
  /* ---------------------------------------------------------------------- */

  it('will not leave an organization without an owner', async () => {
    const response = await ctx.app.inject({
      method: 'PATCH',
      url: `/api/v1/organizations/${orgB}/members/${ownerB.userId}`,
      headers: authed(await signIn(ctx.app, 'owner-b@example.invalid')),
      payload: { role: 'analyst' },
    });
    expect(response.statusCode).toBe(400);
    expect((response.json() as { error: { message: string } }).error.message).toMatch(/owner/i);
  });
});

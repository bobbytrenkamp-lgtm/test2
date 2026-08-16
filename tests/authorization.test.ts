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

  async function createBudget(
    cookie: string,
    propertyId: string,
    kind: string,
    label: string,
  ): Promise<string> {
    const response = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/budgets',
      headers: authed(cookie),
      payload: { propertyId, kind, fiscalYear: 2026, label },
    });
    if (response.statusCode !== 201) {
      throw new Error(`Budget creation failed (${response.statusCode}): ${response.body}`);
    }
    return (response.json() as { period: { id: string } }).period.id;
  }

  async function createTenant(cookie: string, name: string): Promise<string> {
    const response = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/tenants',
      headers: authed(cookie),
      payload: { name },
    });
    if (response.statusCode !== 201) {
      throw new Error(`Tenant creation failed (${response.statusCode}): ${response.body}`);
    }
    return (response.json() as { tenant: { id: string } }).tenant.id;
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

    /**
     * Found by a repository-wide correctness audit: `PUT
     * /models/:id/leases/:code` wrote the caller-supplied `tenantId` straight
     * onto the lease without checking it belonged to the caller's own
     * organization — unlike every other cross-reference in this route file.
     * `tenants` has no organization scope enforced at the database level (a
     * bare `REFERENCES tenants(id)`), so nothing else would have caught it:
     * `GET /models/:id/leases` joins `tenants` unconditionally and returns
     * `tenant_name` to anyone who can read the model, which would have handed
     * organization B's tenant name to every organization A user who opened
     * this lease. Unlike the previous test (org B writing into org A's
     * model, refused by the model-level ownership check alone), this is org
     * A writing into its *own* model but pointing at org B's tenant — the
     * model-level check alone cannot see this.
     */
    it('refuses to attach another organization’s tenant to a lease in one’s own model', async () => {
      const tenantB = await createTenant(ownerB.cookie, 'Beta Tenant');

      const response = await ctx.app.inject({
        method: 'PUT',
        url: `/api/v1/models/${modelA}/leases/CROSS-TENANT`,
        headers: authed(ownerA.cookie),
        payload: {
          tenantId: tenantB,
          status: 'occupied',
          area: '1000',
          commencementDate: '2026-01-01',
          expirationDate: '2027-01-01',
          baseRent: '1',
          baseRentBasis: 'per_area_per_year',
        },
      });
      expect(response.statusCode).toBe(404);

      // Not written at all, not written with the reference silently dropped.
      const leases = await ctx.app.inject({
        method: 'GET',
        url: `/api/v1/models/${modelA}/leases`,
        headers: authed(ownerA.cookie),
      });
      const codes = (leases.json() as { leases: Array<{ code: string }> }).leases.map(
        (lease) => lease.code,
      );
      expect(codes).not.toContain('CROSS-TENANT');
    });

    /**
     * Same mechanism as the tenant check above, for the lease's other
     * optional foreign key: `market_leasing_profiles` is scoped to a model,
     * not directly to an organization, and was likewise never checked.
     */
    it('refuses to attach another organization’s market leasing profile to a lease', async () => {
      const propertyB = await createProperty(ownerB.cookie, 'Beta Tower');
      const modelB = await createModel(ownerB.cookie, propertyB, 'Beta base case');
      const [profile] = (await ctx.sql`
        INSERT INTO market_leasing_profiles (model_id, code, name)
        VALUES (${modelB}, 'MLP-B', 'Beta market profile')
        RETURNING id
      `) as unknown as Array<{ id: string }>;
      const tenantA = await createTenant(ownerA.cookie, 'Alpha Tenant');

      const response = await ctx.app.inject({
        method: 'PUT',
        url: `/api/v1/models/${modelA}/leases/CROSS-PROFILE`,
        headers: authed(ownerA.cookie),
        payload: {
          tenantId: tenantA,
          marketLeasingProfileId: profile?.id,
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

    it('refuses to read another organization’s calculation trace by guessing its run id', async () => {
      // The model in the URL belongs to B — the ownership check on the path
      // param alone would pass. The leak this closes is the *second*,
      // unchecked id: a run id from A's own calculation, supplied as a query
      // parameter on B's own model.
      const calculated = await ctx.app.inject({
        method: 'POST',
        url: `/api/v1/models/${modelA}/calculate`,
        headers: authed(ownerA.cookie),
        payload: { withTrace: true },
      });
      expect(calculated.statusCode).toBe(200);
      const runId = (calculated.json() as { runId: string }).runId;

      const propertyB = await createProperty(ownerB.cookie, 'Beta Tower');
      const modelB = await createModel(ownerB.cookie, propertyB, 'Beta base case');

      const response = await ctx.app.inject({
        method: 'GET',
        url: `/api/v1/models/${modelB}/trace?runId=${runId}`,
        headers: authed(ownerB.cookie),
      });
      // Refused as "no trace for this model", not disclosed as A's trace.
      expect(response.statusCode).toBe(422);
    });

    it('refuses to read another organization’s forecast through a variance comparison', async () => {
      const calculated = await ctx.app.inject({
        method: 'POST',
        url: `/api/v1/models/${modelA}/calculate`,
        headers: authed(ownerA.cookie),
        payload: {},
      });
      expect(calculated.statusCode).toBe(200);

      const propertyB = await createProperty(ownerB.cookie, 'Beta Tower II');
      const baseB = await createBudget(ownerB.cookie, propertyB, 'original_budget', 'Beta plan');

      const response = await ctx.app.inject({
        method: 'GET',
        url: `/api/v1/variance?baseId=${baseB}&comparisonModelId=${modelA}`,
        headers: authed(ownerB.cookie),
      });
      expect(response.statusCode).toBe(404);
    });

    it('refuses to build a reforecast from another organization’s model', async () => {
      const calculated = await ctx.app.inject({
        method: 'POST',
        url: `/api/v1/models/${modelA}/calculate`,
        headers: authed(ownerA.cookie),
        payload: {},
      });
      expect(calculated.statusCode).toBe(200);

      const propertyB = await createProperty(ownerB.cookie, 'Beta Tower III');
      const actualsB = await createBudget(ownerB.cookie, propertyB, 'actual', 'Beta actuals');

      const response = await ctx.app.inject({
        method: 'POST',
        url: `/api/v1/budgets/${actualsB}/reforecast`,
        headers: authed(ownerB.cookie),
        payload: { modelId: modelA, closedThrough: '2026-06-30', label: 'Hijacked reforecast' },
      });
      expect(response.statusCode).toBe(404);
    });

    /**
     * Found by the same audit pass as the two lease cross-reference checks
     * above: `POST /budgets` scoped its required `propertyId` to the
     * caller's organization, but the optional `modelId` — a bare
     * `REFERENCES models(id)` with no organization scope of its own — was
     * never checked. A budget period pointing at another organization's
     * model is exactly the kind of dangling cross-org reference every other
     * write in this file refuses at the boundary rather than storing.
     */
    it('refuses to point a budget period at another organization’s model', async () => {
      const response = await ctx.app.inject({
        method: 'POST',
        url: '/api/v1/budgets',
        headers: authed(ownerA.cookie),
        payload: {
          propertyId: propertyA,
          modelId: modelA,
          kind: 'original_budget',
          fiscalYear: 2026,
          label: 'A genuine budget',
        },
      });
      // Sanity check the happy path still works with the caller's own model,
      // before proving the cross-org one is refused.
      expect(response.statusCode).toBe(201);

      const propertyB = await createProperty(ownerB.cookie, 'Beta Tower IV');
      const modelB = await createModel(ownerB.cookie, propertyB, 'Beta base case IV');

      const hijacked = await ctx.app.inject({
        method: 'POST',
        url: '/api/v1/budgets',
        headers: authed(ownerA.cookie),
        payload: {
          propertyId: propertyA,
          modelId: modelB,
          kind: 'reforecast',
          fiscalYear: 2026,
          label: 'Hijacked budget',
        },
      });
      expect(hijacked.statusCode).toBe(404);
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

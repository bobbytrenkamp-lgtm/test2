import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getJob } from '@cre/database';
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
 * Server-side PDF rendering of a report.
 *
 * `docs/reporting-specification.md` named this as deferred rather than
 * faked: true server-side rendering needs a headless browser in the worker
 * image. `apps/worker/src/pdf.test.ts` proves that browser produces real
 * PDF bytes from HTML; this is the route and the job handler around it —
 * `POST /models/:id/reports/:reportId/pdf` enqueues `render_report`, and
 * the caller polls `GET /jobs/:id` for the result, the same shape
 * `export_workbook` already returns.
 */
describe.skipIf(!hasDatabase)('server-side PDF rendering', () => {
  let ctx: TestContext;
  let owner: Actor;
  let modelId: string;

  beforeAll(async () => {
    ctx = await createTestContext();
    owner = await registerActor(ctx.app, 'pdf-owner@example.invalid', 'PDF Owner');

    const org = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/organizations',
      headers: authed(owner.cookie),
      payload: { name: 'PDF Test Partners' },
    });
    expect(org.statusCode).toBe(201);

    const property = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/properties',
      headers: authed(owner.cookie),
      payload: { name: 'PDF Tower', propertyType: 'office', rentableArea: '12000' },
    });
    const propertyId = (property.json() as { property: { id: string } }).property.id;
    await ctx.app.inject({
      method: 'PUT',
      url: `/api/v1/properties/${propertyId}/spaces`,
      headers: authed(owner.cookie),
      payload: { spaces: [{ code: 'WHOLE', spaceType: 'office', area: '12000' }] },
    });

    const tenant = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/tenants',
      headers: authed(owner.cookie),
      payload: { name: 'PDF Anchor Tenant' },
    });
    const tenantId = (tenant.json() as { tenant: { id: string } }).tenant.id;

    const model = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/models',
      headers: authed(owner.cookie),
      payload: {
        propertyId,
        name: 'PDF base case',
        classification: 'valuation',
        valuationDate: '2026-01-01',
        forecastStartDate: '2026-01-01',
        forecastMonths: 24,
        discountRate: '0.08',
        terminalCapRate: '0.07',
      },
    });
    modelId = (model.json() as { model: { id: string } }).model.id;

    await ctx.app.inject({
      method: 'PUT',
      url: `/api/v1/models/${modelId}/leases/L-1`,
      headers: authed(owner.cookie),
      payload: {
        tenantId,
        status: 'occupied',
        area: '12000',
        spaceIds: ['WHOLE'],
        commencementDate: '2026-01-01',
        expirationDate: '2032-12-31',
        baseRent: '29.00',
        baseRentBasis: 'per_area_per_year',
      },
    });
  }, 90_000);

  afterAll(async () => {
    await ctx?.close();
  });

  it('refuses an unknown report id without enqueueing a job', async () => {
    const response = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/models/${modelId}/reports/not-a-report/pdf`,
      headers: authed(owner.cookie),
    });
    expect(response.statusCode).toBe(404);
  });

  it('refuses to render a report for an uncalculated model', async () => {
    const response = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/models/${modelId}/reports/rent-roll/pdf`,
      headers: authed(owner.cookie),
    });
    expect(response.statusCode).toBe(422);
  });

  describe('once calculated', () => {
    beforeAll(async () => {
      const calculated = await ctx.app.inject({
        method: 'POST',
        url: `/api/v1/models/${modelId}/calculate`,
        headers: authed(owner.cookie),
      });
      expect(calculated.statusCode, calculated.body).toBe(200);
    });

    it('enqueues a job, and the worker produces real PDF bytes', async () => {
      const response = await ctx.app.inject({
        method: 'POST',
        url: `/api/v1/models/${modelId}/reports/rent-roll/pdf`,
        headers: authed(owner.cookie),
      });
      expect(response.statusCode, response.body).toBe(200);
      const { jobId, status } = response.json() as { jobId: string; status: string };
      expect(status).toBe('queued');

      const didWork = await tick(ctx.sql, 'test-worker-pdf');
      expect(didWork).toBe(true);

      const job = await getJob(ctx.sql, jobId);
      expect(job?.status, job?.error_message ?? undefined).toBe('succeeded');
      const result = job?.result as { encoding: string; content: string; filename: string };
      expect(result.encoding).toBe('base64');
      expect(result.filename).toBe('rent-roll.pdf');
      const pdf = Buffer.from(result.content, 'base64');
      expect(pdf.subarray(0, 5).toString('latin1')).toBe('%PDF-');
    }, 30_000);

    it('gates the pdf route behind export:run, which report:read alone does not carry', async () => {
      const orgResponse = await ctx.app.inject({
        method: 'GET',
        url: '/api/v1/organizations',
        headers: authed(owner.cookie),
      });
      const organizationId = (
        orgResponse.json() as { organizations: Array<{ organization_id: string }> }
      ).organizations[0]?.organization_id;

      const outsider = await registerActor(ctx.app, 'pdf-readonly@example.invalid', 'Read Only');
      const invitation = await ctx.app.inject({
        method: 'POST',
        url: `/api/v1/organizations/${organizationId}/invitations`,
        headers: authed(owner.cookie),
        payload: { email: outsider.email, role: 'read_only' },
      });
      const token = (invitation.json() as { token: string }).token;
      await ctx.app.inject({
        method: 'POST',
        url: '/api/v1/invitations/accept',
        headers: authed(outsider.cookie),
        payload: { token },
      });

      const response = await ctx.app.inject({
        method: 'POST',
        url: `/api/v1/models/${modelId}/reports/rent-roll/pdf`,
        headers: authed(outsider.cookie),
      });
      expect(response.statusCode).toBe(403);
    });
  });
});

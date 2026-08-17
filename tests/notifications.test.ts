import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  authed,
  createTestContext,
  hasDatabase,
  registerActor,
  type Actor,
  type TestContext,
} from './helpers.js';

/**
 * Mention notifications.
 *
 * `comments.mentions` has stored who a comment drew in since migration 0004,
 * but the mention only ever surfaced inside the thread itself — the person
 * it named was never told out of band. These tests are about the feed built
 * on top of it: who gets a row, who does not, and that it never crosses an
 * organization boundary.
 */
describe.skipIf(!hasDatabase)('mention notifications', () => {
  let ctx: TestContext;
  let owner: Actor;
  let analyst: Actor;
  let viewer: Actor;
  let organizationId: string;
  let modelId: string;
  let propertyId: string;

  beforeAll(async () => {
    ctx = await createTestContext();
    owner = await registerActor(ctx.app, 'notify-owner@example.invalid', 'Notify Owner');

    const organization = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/organizations',
      headers: authed(owner.cookie),
      payload: { name: 'Notify Partners' },
    });
    organizationId = (organization.json() as { organization: { id: string } }).organization.id;

    async function join(actor: Actor, email: string, role: string): Promise<void> {
      const invitation = await ctx.app.inject({
        method: 'POST',
        url: `/api/v1/organizations/${organizationId}/invitations`,
        headers: authed(owner.cookie),
        payload: { email, role },
      });
      await ctx.app.inject({
        method: 'POST',
        url: '/api/v1/invitations/accept',
        headers: authed(actor.cookie),
        payload: { token: (invitation.json() as { token: string }).token },
      });
    }

    analyst = await registerActor(ctx.app, 'notify-analyst@example.invalid', 'Notify Analyst');
    await join(analyst, 'notify-analyst@example.invalid', 'analyst');
    viewer = await registerActor(ctx.app, 'notify-viewer@example.invalid', 'Notify Viewer');
    await join(viewer, 'notify-viewer@example.invalid', 'read_only');

    const property = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/properties',
      headers: authed(owner.cookie),
      payload: { name: 'Notify House', propertyType: 'office', rentableArea: '50000' },
    });
    propertyId = (property.json() as { property: { id: string } }).property.id;

    const model = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/models',
      headers: authed(owner.cookie),
      payload: {
        propertyId,
        name: 'Notify model',
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

  async function comment(body: Record<string, unknown>) {
    return ctx.app.inject({
      method: 'POST',
      url: '/api/v1/comments',
      headers: authed(owner.cookie),
      payload: { entityType: 'model', entityId: modelId, ...body },
    });
  }

  async function feed(actor: Actor, unread = false) {
    const response = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/notifications?unread=${unread}`,
      headers: authed(actor.cookie),
    });
    expect(response.statusCode).toBe(200);
    return response.json() as {
      notifications: Array<Record<string, unknown>>;
      unreadCount: number;
    };
  }

  it('notifies a mentioned colleague and nobody else', async () => {
    const created = await comment({
      body: 'Can you check the rollover assumption?',
      mentions: [analyst.userId],
    });
    expect(created.statusCode).toBe(201);

    const analystFeed = await feed(analyst);
    expect(analystFeed.notifications).toHaveLength(1);
    expect(analystFeed.notifications[0]?.excerpt).toContain('rollover assumption');
    expect(analystFeed.notifications[0]?.actor_name).toBe('Notify Owner');
    expect(analystFeed.notifications[0]?.href).toBe(`/models/${modelId}`);
    expect(analystFeed.unreadCount).toBe(1);

    // Not the author, and not a member who was never mentioned.
    const ownerFeed = await feed(owner);
    expect(ownerFeed.notifications).toHaveLength(0);
    const viewerFeed = await feed(viewer);
    expect(viewerFeed.notifications).toHaveLength(0);
  });

  it('marks a notification read, idempotently, without letting another member touch it', async () => {
    const analystFeed = await feed(analyst);
    const id = analystFeed.notifications[0]?.id as string;

    const stranger = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/notifications/${id}/read`,
      headers: authed(viewer.cookie),
    });
    expect(stranger.statusCode).toBe(404);

    const first = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/notifications/${id}/read`,
      headers: authed(analyst.cookie),
    });
    expect(first.statusCode).toBe(200);

    const readAt = (await feed(analyst)).notifications[0]?.read_at;
    expect(readAt).not.toBeNull();

    // A second call is a no-op, not an error, and does not move the timestamp.
    const second = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/notifications/${id}/read`,
      headers: authed(analyst.cookie),
    });
    expect(second.statusCode).toBe(200);
    expect((await feed(analyst)).notifications[0]?.read_at).toBe(readAt);

    expect((await feed(analyst, true)).notifications).toHaveLength(0);
    expect((await feed(analyst)).unreadCount).toBe(0);
  });

  it('marks every unread notification read in one call', async () => {
    await comment({ body: 'One more thing to check.', mentions: [analyst.userId] });
    await comment({ body: 'And another.', mentions: [analyst.userId] });
    expect((await feed(analyst)).unreadCount).toBe(2);

    const response = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/notifications/read-all',
      headers: authed(analyst.cookie),
    });
    expect(response.statusCode).toBe(200);
    expect((response.json() as { marked: number }).marked).toBe(2);
    expect((await feed(analyst)).unreadCount).toBe(0);
  });

  it('does not notify the author of their own comment, even if self-mentioned', async () => {
    // The mention picker excludes the caller, but the API itself does not
    // refuse a self-mention — nothing should be created from it regardless.
    const before = (await feed(owner)).notifications.length;
    const created = await comment({ body: 'Note to self.', mentions: [owner.userId] });
    expect(created.statusCode).toBe(201);
    expect((await feed(owner)).notifications).toHaveLength(before);
  });

  it('never lets a notification cross an organization boundary', async () => {
    const outsider = await registerActor(
      ctx.app,
      'notify-outsider@example.invalid',
      'Notify Outsider',
    );
    await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/organizations',
      headers: authed(outsider.cookie),
      payload: { name: 'Unrelated Notify Co' },
    });

    const outsiderFeed = await feed(outsider);
    expect(outsiderFeed.notifications).toHaveLength(0);
    expect(outsiderFeed.unreadCount).toBe(0);
  });
});

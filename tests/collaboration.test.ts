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
 * Comments on a model.
 *
 * The approval workflow could move a model from review back to draft and record
 * that it happened, but not why — so an analyst learned that someone
 * disagreed, not what to change.
 *
 * The tests that matter here are the ones about who may do what. A comment
 * anyone can close is a review nobody has to answer, and the fastest way past a
 * criticism would be to dismiss it.
 */
describe.skipIf(!hasDatabase)('comments', () => {
  let ctx: TestContext;
  let owner: Actor;
  let analyst: Actor;
  let viewer: Actor;
  let organizationId: string;
  let modelId: string;
  let propertyId: string;

  beforeAll(async () => {
    ctx = await createTestContext();
    owner = await registerActor(ctx.app, 'comment-owner@example.invalid', 'Comment Owner');

    const organization = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/organizations',
      headers: authed(owner.cookie),
      payload: { name: 'Comment Partners' },
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

    analyst = await registerActor(ctx.app, 'comment-analyst@example.invalid', 'Analyst');
    await join(analyst, 'comment-analyst@example.invalid', 'analyst');
    viewer = await registerActor(ctx.app, 'comment-viewer@example.invalid', 'Viewer');
    await join(viewer, 'comment-viewer@example.invalid', 'read_only');

    const property = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/properties',
      headers: authed(owner.cookie),
      payload: { name: 'Comment House', propertyType: 'office', rentableArea: '50000' },
    });
    propertyId = (property.json() as { property: { id: string } }).property.id;

    const model = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/models',
      headers: authed(owner.cookie),
      payload: {
        propertyId,
        name: 'Under review',
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

  async function comment(
    cookie: string,
    body: Record<string, unknown>,
  ): Promise<{ statusCode: number; body: string }> {
    const response = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/comments',
      headers: authed(cookie),
      payload: { entityType: 'model', entityId: modelId, ...body },
    });
    return { statusCode: response.statusCode, body: response.body };
  }

  async function list(
    cookie: string,
    includeResolved = false,
  ): Promise<Array<Record<string, unknown>>> {
    const response = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/comments?entityType=model&entityId=${modelId}&includeResolved=${includeResolved}`,
      headers: authed(cookie),
    });
    expect(response.statusCode).toBe(200);
    return (response.json() as { comments: Array<Record<string, unknown>> }).comments;
  }

  it('records a reviewer’s objection against the model it is about', async () => {
    const created = await comment(owner.cookie, {
      body: 'The exit capitalisation rate is 50bp inside the market and nothing explains it.',
    });
    expect(created.statusCode).toBe(201);

    const comments = await list(analyst.cookie);
    expect(comments[0]?.body).toContain('exit capitalisation rate');
    expect(comments[0]?.author_name).toBe('Comment Owner');
  });

  it('lets a read-only member read the review without joining it', async () => {
    // Seeing a model and commenting on it are different permissions.
    const comments = await list(viewer.cookie);
    expect(comments.length).toBeGreaterThan(0);

    const attempted = await comment(viewer.cookie, { body: 'I would like to weigh in.' });
    expect(attempted.statusCode).toBe(403);
  });

  it('refuses a mention of someone outside the organization', async () => {
    // Accepting an arbitrary identifier would claim to have drawn in a person
    // who will never be told, and would confirm that a guessed user exists.
    const stranger = await registerActor(ctx.app, 'comment-stranger@example.invalid', 'Stranger');
    const attempted = await comment(owner.cookie, {
      body: 'What do you think?',
      mentions: [stranger.userId],
    });
    expect(attempted.statusCode).toBe(400);
    expect(attempted.body).toContain('members of this organization');

    // And nothing was written: a partial save would be worse than a refusal.
    const comments = await list(owner.cookie);
    expect(comments.some((entry) => entry.body === 'What do you think?')).toBe(false);
  });

  it('accepts a mention of a colleague', async () => {
    const created = await comment(owner.cookie, {
      body: 'Can you check the rollover assumption?',
      mentions: [analyst.userId],
    });
    expect(created.statusCode).toBe(201);
    const saved = JSON.parse(created.body) as { comment: { mentions: string[] } };
    expect(saved.comment.mentions).toEqual([analyst.userId]);
  });

  it('does not let the person criticised close the criticism', async () => {
    // The heart of it. If anyone could resolve anything, the fastest way past a
    // reviewer's objection would be to dismiss it, and the review would be
    // decorative.
    const created = await comment(owner.cookie, { body: 'This needs a second look.' });
    const id = (JSON.parse(created.body) as { comment: { id: string } }).comment.id;

    const dismissed = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/comments/${id}/resolve`,
      headers: authed(analyst.cookie),
      payload: {},
    });
    expect(dismissed.statusCode).toBe(403);
    expect(dismissed.body).toContain('Reply to it instead');
  });

  it('lets the author resolve their own', async () => {
    const created = await comment(analyst.cookie, { body: 'Never mind, I misread the schedule.' });
    const id = (JSON.parse(created.body) as { comment: { id: string } }).comment.id;

    const resolved = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/comments/${id}/resolve`,
      headers: authed(analyst.cookie),
      payload: {},
    });
    expect(resolved.statusCode).toBe(200);
  });

  it('hides resolved comments unless they are asked for', async () => {
    // The open ones are the work. A list that keeps everything forever is one
    // people stop reading, and then an open objection goes unnoticed.
    const open = await list(owner.cookie, false);
    const all = await list(owner.cookie, true);
    expect(all.length).toBeGreaterThan(open.length);
    expect(open.every((entry) => entry.resolved_at === null)).toBe(true);
  });

  it('refuses to resolve the same comment twice', async () => {
    const created = await comment(owner.cookie, { body: 'Closing this one.' });
    const id = (JSON.parse(created.body) as { comment: { id: string } }).comment.id;

    const url = `/api/v1/comments/${id}/resolve`;
    expect(
      (await ctx.app.inject({ method: 'POST', url, headers: authed(owner.cookie), payload: {} }))
        .statusCode,
    ).toBe(200);
    const again = await ctx.app.inject({
      method: 'POST',
      url,
      headers: authed(owner.cookie),
      payload: {},
    });
    expect(again.statusCode).toBe(400);
  });

  it('lets exactly one of two simultaneous resolves win, and only one audit entry records it', async () => {
    // The sequential test above never reaches the race: by the time the
    // second call runs, the precondition check that reads `resolved_at`
    // already sees it set, so it is refused before ever touching the
    // UPDATE. Firing both at once is what actually exercises the guard on
    // the write itself -- and what the loser gets back if that guard is
    // missing: a 200 with a null comment, plus an audit entry falsely
    // crediting them with resolving something someone else already had.
    const created = await comment(owner.cookie, { body: 'Racing to close this one.' });
    const id = (JSON.parse(created.body) as { comment: { id: string } }).comment.id;
    const url = `/api/v1/comments/${id}/resolve`;

    const [first, second] = await Promise.all([
      ctx.app.inject({ method: 'POST', url, headers: authed(owner.cookie), payload: {} }),
      ctx.app.inject({ method: 'POST', url, headers: authed(owner.cookie), payload: {} }),
    ]);
    expect([first.statusCode, second.statusCode].sort()).toEqual([200, 400]);

    const winner = first.statusCode === 200 ? first : second;
    expect((winner.json() as { comment: { id: string } }).comment.id).toBe(id);

    const audit = await ctx.app.inject({
      method: 'GET',
      url: '/api/v1/audit?limit=500&entityType=comment',
      headers: authed(owner.cookie),
    });
    const entries = (audit.json() as { entries: Array<{ action: string; entity_id: string }> })
      .entries;
    const resolutions = entries.filter(
      (entry) => entry.action === 'comment.resolved' && entry.entity_id === id,
    );
    expect(resolutions.length).toBe(1);
  });

  it('refuses to anchor a comment to a record in another organization', async () => {
    const stranger = await registerActor(ctx.app, 'comment-outsider@example.invalid', 'Outsider');
    await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/organizations',
      headers: authed(stranger.cookie),
      payload: { name: 'Unrelated Comment Co' },
    });

    // `comments` has no foreign key to the thing it names, because the thing
    // varies — so without the anchor check a comment could be attached to any
    // identifier at all, including one belonging to somebody else.
    const attempted = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/comments',
      headers: authed(stranger.cookie),
      payload: { entityType: 'model', entityId: modelId, body: 'Reaching in from outside.' },
    });
    expect(attempted.statusCode).toBe(404);
  });

  it('records that a comment happened without copying what it said', async () => {
    // The audit log is append-only. Copying every word into it would make
    // resolving a comment cosmetic, which is not what resolution means.
    const response = await ctx.app.inject({
      method: 'GET',
      url: '/api/v1/audit?limit=200',
      headers: authed(owner.cookie),
    });
    const entries = (response.json() as { entries: Array<{ action: string; new_value: unknown }> })
      .entries;
    const created = entries.filter((entry) => entry.action === 'comment.created');
    expect(created.length).toBeGreaterThan(0);
    expect(JSON.stringify(created)).not.toContain('exit capitalisation rate');
  });
});

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
 * Asset-management tasks.
 *
 * The interesting tests here are not "does it save a row". They are the four
 * places a task tracker quietly tells a lie:
 *
 *   - a task assigned to somebody who cannot see it, which looks owned and is
 *     not;
 *   - a task attached to another organization's property, which both leaks the
 *     existence of that property and files the work in the wrong place;
 *   - a completion date left behind on a task that was reopened, so the column
 *     records the last time somebody *thought* it was done;
 *   - a due date that cannot be cleared, because the update used COALESCE and
 *     could not distinguish "leave it" from "remove it".
 */
describe.skipIf(!hasDatabase)('tasks', () => {
  let ctx: TestContext;
  let owner: Actor;
  let analyst: Actor;
  let viewer: Actor;
  let outsider: Actor;
  let organizationId: string;
  let propertyId: string;
  let modelId: string;
  let foreignPropertyId: string;
  let analystUserId: string;
  let outsiderUserId: string;

  beforeAll(async () => {
    ctx = await createTestContext();
    owner = await registerActor(ctx.app, 'task-owner@example.invalid', 'Task Owner');

    const organization = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/organizations',
      headers: authed(owner.cookie),
      payload: { name: 'Task Partners' },
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

    analyst = await registerActor(ctx.app, 'task-analyst@example.invalid', 'Task Analyst');
    await join(analyst, 'task-analyst@example.invalid', 'analyst');
    viewer = await registerActor(ctx.app, 'task-viewer@example.invalid', 'Task Viewer');
    await join(viewer, 'task-viewer@example.invalid', 'read_only');

    const me = await ctx.app.inject({
      method: 'GET',
      url: '/api/v1/auth/me',
      headers: authed(analyst.cookie),
    });
    analystUserId = (me.json() as { user: { id: string } }).user.id;

    const property = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/properties',
      headers: authed(owner.cookie),
      payload: { name: 'Task House', propertyType: 'office', rentableArea: '50000' },
    });
    propertyId = (property.json() as { property: { id: string } }).property.id;

    const model = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/models',
      headers: authed(owner.cookie),
      payload: {
        propertyId,
        name: 'Task model',
        classification: 'valuation',
        valuationDate: '2026-01-01',
        forecastStartDate: '2026-01-01',
        forecastMonths: 12,
        discountRate: '0.08',
        terminalCapRate: '0.07',
      },
    });
    modelId = (model.json() as { model: { id: string } }).model.id;

    // A second organization, so "belongs to this organization" has something to
    // be false about.
    outsider = await registerActor(ctx.app, 'task-outsider@example.invalid', 'Task Outsider');
    const otherOrganization = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/organizations',
      headers: authed(outsider.cookie),
      payload: { name: 'Rival Partners' },
    });
    const otherId = (otherOrganization.json() as { organization: { id: string } }).organization.id;
    expect(otherId).not.toBe(organizationId);

    const foreign = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/properties',
      headers: authed(outsider.cookie),
      payload: { name: 'Rival House', propertyType: 'office', rentableArea: '10000' },
    });
    foreignPropertyId = (foreign.json() as { property: { id: string } }).property.id;

    const outsiderMe = await ctx.app.inject({
      method: 'GET',
      url: '/api/v1/auth/me',
      headers: authed(outsider.cookie),
    });
    outsiderUserId = (outsiderMe.json() as { user: { id: string } }).user.id;
  }, 90_000);

  afterAll(async () => {
    await ctx?.close();
  });

  async function create(
    cookie: string,
    payload: Record<string, unknown>,
  ): Promise<{ statusCode: number; task: Record<string, unknown>; body: string }> {
    const response = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/tasks',
      headers: authed(cookie),
      payload,
    });
    const parsed =
      response.statusCode === 201
        ? (response.json() as { task: Record<string, unknown> }).task
        : ({} as Record<string, unknown>);
    return { statusCode: response.statusCode, task: parsed, body: response.body };
  }

  async function patch(
    cookie: string,
    id: string,
    payload: Record<string, unknown>,
  ): Promise<{ statusCode: number; task: Record<string, unknown> }> {
    const response = await ctx.app.inject({
      method: 'PATCH',
      url: `/api/v1/tasks/${id}`,
      headers: authed(cookie),
      payload,
    });
    return {
      statusCode: response.statusCode,
      task:
        response.statusCode === 200
          ? (response.json() as { task: Record<string, unknown> }).task
          : ({} as Record<string, unknown>),
    };
  }

  async function list(cookie: string, query = ''): Promise<Array<Record<string, unknown>>> {
    const response = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/tasks${query}`,
      headers: authed(cookie),
    });
    expect(response.statusCode).toBe(200);
    return (response.json() as { tasks: Array<Record<string, unknown>> }).tasks;
  }

  it('files a task against the asset it concerns', async () => {
    const created = await create(owner.cookie, {
      title: 'Chase the estoppel from the anchor tenant',
      propertyId,
      modelId,
      assigneeId: analystUserId,
      dueDate: '2026-03-31',
    });
    expect(created.statusCode).toBe(201);

    const tasks = await list(analyst.cookie, `?propertyId=${propertyId}`);
    const task = tasks.find((row) => row.id === created.task.id);
    expect(task?.property_name).toBe('Task House');
    expect(task?.model_name).toBe('Task model');
    expect(task?.assignee_name).toBe('Task Analyst');
    expect(task?.created_by_name).toBe('Task Owner');
  });

  it('refuses to assign work to somebody outside the organization', async () => {
    // A task owned by a stranger looks owned on the board and is not: nobody
    // who can see it is going to be told about it.
    const created = await create(owner.cookie, {
      title: 'Assigned to nobody real',
      assigneeId: outsiderUserId,
    });
    expect(created.statusCode).toBe(400);
    expect(created.body).toContain('member of this organization');
  });

  it('reports another organization’s property as absent rather than forbidden', async () => {
    // A 403 would confirm the identifier names a real property somewhere else,
    // which is exactly what an outsider probing identifiers wants to learn.
    const created = await create(owner.cookie, {
      title: 'Filed against a building we do not own',
      propertyId: foreignPropertyId,
    });
    expect(created.statusCode).toBe(404);
  });

  it('will not let a read-only member create work', async () => {
    const created = await create(viewer.cookie, { title: 'Not mine to raise' });
    expect(created.statusCode).toBe(403);

    // Reading the board is a different thing from adding to it.
    const tasks = await list(viewer.cookie);
    expect(tasks.length).toBeGreaterThan(0);
  });

  it('clears the completion date when a finished task is reopened', async () => {
    const created = await create(owner.cookie, { title: 'Get the roof quote' });
    expect(created.task.completed_at).toBeNull();

    const done = await patch(owner.cookie, created.task.id as string, { status: 'done' });
    expect(done.task.status).toBe('done');
    expect(done.task.completed_at).not.toBeNull();

    const reopened = await patch(owner.cookie, created.task.id as string, { status: 'open' });
    expect(reopened.task.status).toBe('open');
    // If this were merely set-on-close, the column would now be a record of the
    // last time somebody thought the work was finished.
    expect(reopened.task.completed_at).toBeNull();
  });

  it('keeps the original completion date when a closed task is edited', async () => {
    const created = await create(owner.cookie, { title: 'Already handled', status: 'done' });
    const first = created.task.completed_at;
    expect(first).not.toBeNull();

    const renamed = await patch(owner.cookie, created.task.id as string, {
      title: 'Already handled, renamed',
    });
    // Editing the title is not finishing it again.
    expect(renamed.task.completed_at).toEqual(first);
  });

  it('distinguishes clearing a field from leaving it alone', async () => {
    const created = await create(owner.cookie, {
      title: 'Re-forecast after the notice',
      description: 'The anchor served notice on 14 February.',
      dueDate: '2026-06-30',
      assigneeId: analystUserId,
    });

    // An absent key leaves the column alone.
    const touched = await patch(owner.cookie, created.task.id as string, { status: 'in_progress' });
    expect(touched.task.due_date).not.toBeNull();
    expect(touched.task.description).toContain('14 February');
    expect(touched.task.assignee_id).toBe(analystUserId);

    // An explicit null clears it. COALESCE cannot tell these two apart.
    const cleared = await patch(owner.cookie, created.task.id as string, {
      dueDate: null,
      description: null,
      assigneeId: null,
    });
    expect(cleared.task.due_date).toBeNull();
    expect(cleared.task.description).toBeNull();
    expect(cleared.task.assignee_id).toBeNull();
  });

  it('hides closed work by default and finds it when asked', async () => {
    const created = await create(owner.cookie, { title: 'Cancel the parking licence' });
    await patch(owner.cookie, created.task.id as string, { status: 'cancelled' });

    const open = await list(owner.cookie);
    expect(open.some((row) => row.id === created.task.id)).toBe(false);

    const all = await list(owner.cookie, '?includeClosed=true');
    expect(all.some((row) => row.id === created.task.id)).toBe(true);
  });

  it('sorts undated work after dated work rather than treating it as urgent', async () => {
    const undated = await create(owner.cookie, { title: 'Someday: review the service charge' });
    const dated = await create(owner.cookie, {
      title: 'Lodge the rates appeal',
      dueDate: '2026-01-15',
    });

    const tasks = await list(owner.cookie);
    const datedAt = tasks.findIndex((row) => row.id === dated.task.id);
    const undatedAt = tasks.findIndex((row) => row.id === undated.task.id);
    expect(datedAt).toBeGreaterThanOrEqual(0);
    expect(undatedAt).toBeGreaterThan(datedAt);
  });

  it('answers “overdue” against the date the caller supplies, not the server’s', async () => {
    const created = await create(owner.cookie, {
      title: 'Serve the rent review notice',
      dueDate: '2026-05-01',
    });

    // The day before it is due, in the caller's own reckoning, it is not late.
    const early = await list(owner.cookie, '?overdueAsOf=2026-04-30');
    expect(early.some((row) => row.id === created.task.id)).toBe(false);

    const late = await list(owner.cookie, '?overdueAsOf=2026-05-02');
    expect(late.some((row) => row.id === created.task.id)).toBe(true);

    // Finishing it takes it off the overdue list; the date it was due does not
    // change, and a done task is not outstanding.
    await patch(owner.cookie, created.task.id as string, { status: 'done' });
    const afterwards = await list(owner.cookie, '?overdueAsOf=2026-05-02');
    expect(afterwards.some((row) => row.id === created.task.id)).toBe(false);
  });

  it('does not show one organization’s tasks to another', async () => {
    const mine = await list(owner.cookie, '?includeClosed=true');
    expect(mine.length).toBeGreaterThan(0);

    const theirs = await list(outsider.cookie, '?includeClosed=true');
    const leaked = theirs.filter((row) => mine.some((task) => task.id === row.id));
    expect(leaked).toEqual([]);
  });

  it('records the change in the audit log, both sides of it', async () => {
    const created = await create(owner.cookie, {
      title: 'Rebid the insurance',
      propertyId,
      dueDate: '2026-09-01',
    });
    await patch(owner.cookie, created.task.id as string, { status: 'blocked' });

    const response = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/audit?entityType=task`,
      headers: authed(owner.cookie),
    });
    expect(response.statusCode).toBe(200);
    const entries = (response.json() as { entries: Array<Record<string, unknown>> }).entries;
    const update = entries.find(
      (entry) => entry.entity_id === created.task.id && entry.action === 'task.updated',
    );
    expect(update).toBeDefined();
    expect((update?.previous_value as { status: string }).status).toBe('open');
    expect((update?.new_value as { status: string }).status).toBe('blocked');
  });
});

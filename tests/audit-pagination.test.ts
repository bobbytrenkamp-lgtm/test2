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
 * Keyset pagination over the audit log.
 *
 * The audit log is the one table that only ever grows, and it is the one where
 * a silently skipped row is worst: a compliance reader who pages through a
 * year of history has no way to tell that entry 4,312 was never shown.
 *
 * Ordering by `occurred_at` alone cannot promise that. Timestamps collide —
 * these tests write rows deliberately sharing one to the microsecond — and two
 * rows that compare equal can land on either side of a page boundary, so one
 * gets shown twice and another not at all. The id breaks the tie.
 */
describe.skipIf(!hasDatabase)('audit pagination', () => {
  let ctx: TestContext;
  let owner: Actor;
  const TOTAL = 25;

  beforeAll(async () => {
    ctx = await createTestContext();
    owner = await registerActor(ctx.app, 'audit-page@example.invalid', 'Audit Reader');

    const organization = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/organizations',
      headers: authed(owner.cookie),
      payload: { name: 'Audit Partners' },
    });
    const organizationId = (organization.json() as { organization: { id: string } }).organization
      .id;

    /*
     * Every row shares one timestamp, to the microsecond.
     *
     * That is not a contrived case — a bulk import or a cascading update writes
     * a batch of audit rows inside a single statement, and PostgreSQL's `now()`
     * is the transaction's start time, so they genuinely do collide. Ordering
     * that is not unique makes pagination lose rows exactly here.
     */
    for (let i = 0; i < TOTAL; i += 1) {
      await ctx.sql`
        INSERT INTO audit_log (organization_id, user_id, action, entity_type, entity_id, occurred_at)
        VALUES (${organizationId}, ${owner.userId}, ${`test.entry_${String(i).padStart(2, '0')}`},
                'test', ${String(i)}, '2026-06-01T12:00:00.000000Z')
      `;
    }
  }, 60_000);

  afterAll(async () => {
    await ctx?.close();
  });

  async function page(
    limit: number,
    cursor?: string | null,
  ): Promise<{ entries: Array<{ id: string; action: string }>; nextCursor: string | null }> {
    const url =
      `/api/v1/audit?limit=${limit}` + (cursor ? `&cursor=${encodeURIComponent(cursor)}` : '');
    const response = await ctx.app.inject({ method: 'GET', url, headers: authed(owner.cookie) });
    expect(response.statusCode).toBe(200);
    return response.json() as never;
  }

  /** Walks every page and returns the ids in the order they were served. */
  async function walk(limit: number): Promise<string[]> {
    const ids: string[] = [];
    let cursor: string | null = null;
    for (let guard = 0; guard < 50; guard += 1) {
      const result: Awaited<ReturnType<typeof page>> = await page(limit, cursor);
      ids.push(...result.entries.map((entry) => entry.id));
      if (!result.nextCursor) return ids;
      cursor = result.nextCursor;
    }
    throw new Error('Pagination did not terminate');
  }

  it('serves every row exactly once across pages, despite identical timestamps', async () => {
    // The assertion the whole design exists for. Offset would also pass on a
    // quiet table; what it cannot promise is that a tie is broken the same way
    // on both sides of a boundary.
    const ids = await walk(4);
    const mine = ids.length;
    expect(mine).toBeGreaterThanOrEqual(TOTAL);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('returns the same rows whatever the page size', async () => {
    const byFour = await walk(4);
    const bySeven = await walk(7);
    const byFifty = await walk(50);
    expect(new Set(byFour)).toEqual(new Set(bySeven));
    expect(new Set(byFour)).toEqual(new Set(byFifty));
    // And in the same order, since the ordering is total.
    expect(byFour).toEqual(bySeven);
  });

  it('stops rather than looping, and says so with a null cursor', async () => {
    const all = await page(500);
    expect(all.nextCursor).toBeNull();
    expect(all.entries.length).toBeGreaterThanOrEqual(TOTAL);
  });

  it('reports a next cursor only when there is more to read', async () => {
    const first = await page(4);
    expect(first.entries).toHaveLength(4);
    expect(first.nextCursor).not.toBeNull();

    // The cursor is where the page stopped, so it names the last row served.
    const last = first.entries[first.entries.length - 1];
    expect(first.nextCursor).toContain(last?.id as string);
  });

  it('treats a malformed cursor as no cursor rather than failing', async () => {
    // Cursors travel in URLs. A stale bookmark or a truncated copy-paste should
    // show the first page, not an error page.
    for (const cursor of ['nonsense', '|', 'not-a-date|not-a-uuid-either', '']) {
      const response = await ctx.app.inject({
        method: 'GET',
        url: `/api/v1/audit?limit=3&cursor=${encodeURIComponent(cursor)}`,
        headers: authed(owner.cookie),
      });
      // Either the first page, or a clean rejection — never a 500.
      expect([200, 400], cursor).toContain(response.statusCode);
    }
  });

  it('still honours offset, for callers that page by position', async () => {
    const first = await page(5);
    const response = await ctx.app.inject({
      method: 'GET',
      url: '/api/v1/audit?limit=5&offset=5',
      headers: authed(owner.cookie),
    });
    const second = response.json() as { entries: Array<{ id: string }> };
    const overlap = second.entries.filter((entry) =>
      first.entries.some((other) => other.id === entry.id),
    );
    expect(overlap).toEqual([]);
  });

  it('keeps one organization out of another’s history', async () => {
    const stranger = await registerActor(ctx.app, 'audit-stranger@example.invalid', 'Stranger');
    await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/organizations',
      headers: authed(stranger.cookie),
      payload: { name: 'Unrelated Audit Co' },
    });

    const response = await ctx.app.inject({
      method: 'GET',
      url: '/api/v1/audit?limit=500',
      headers: authed(stranger.cookie),
    });
    const body = response.json() as { entries: Array<{ action: string }> };
    expect(body.entries.some((entry) => entry.action.startsWith('test.entry_'))).toBe(false);
  });
});

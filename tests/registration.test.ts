import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { HEADERS, createTestContext, hasDatabase, type TestContext } from './helpers.js';

/**
 * `POST /auth/register`'s existing-email check is a read followed by a
 * write, not one atomic step — two requests for the same address arriving
 * close together can both pass the check and both reach the insert.
 * `users.email`'s own UNIQUE constraint is what actually decides between
 * them, and before this fix, the loser's constraint violation propagated
 * unhandled into the framework's generic 500 path instead of the deliberate
 * 409 a simultaneous registration is supposed to get.
 */
describe.skipIf(!hasDatabase)('registration', () => {
  let ctx: TestContext;

  beforeAll(async () => {
    ctx = await createTestContext();
  }, 60_000);

  afterAll(async () => {
    await ctx?.close();
  });

  it('refuses a race between two concurrent registrations for the same email with a 409, not a 500', async () => {
    const email = 'race-condition@example.invalid';
    const register = () =>
      ctx.app.inject({
        method: 'POST',
        url: '/api/v1/auth/register',
        headers: HEADERS,
        payload: { email, name: 'Race Condition', password: 'a-sufficiently-long-password' },
      });

    const [first, second] = await Promise.all([register(), register()]);
    const statuses = [first.statusCode, second.statusCode].sort();

    // Exactly one wins (201) and one loses (409) — never a 500, which is
    // what an unhandled unique-constraint violation would have produced for
    // whichever request's INSERT lost the race.
    expect(statuses).toEqual([201, 409]);
    const loser = first.statusCode === 409 ? first : second;
    expect((loser.json() as { error: { code: string } }).error.code).toBe('REGISTRATION_FAILED');
  });
});

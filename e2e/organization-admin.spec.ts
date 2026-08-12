import { expect, test } from '@playwright/test';
import { ROLES, sessionFile } from './roles.js';

/**
 * Organization admin: the plan every member can see, and the member
 * management only an owner's capabilities actually carry. See
 * `docs/commercial-gap-analysis.md` Phase A item 3.
 *
 * Two flows this feature includes are deliberately not exercised here:
 * creating a brand-new organization from a zero-organization account, and
 * completing an invitation as a brand-new account. Both need
 * self-registration, which `playwright.config.ts` disables for this whole
 * suite on purpose — the seed provides every account these tests use, the
 * same as a real deployment would keep open registration closed. Both flows
 * were driven manually against a real running server (register, create an
 * organization, invite, sign in as the invitee, accept) before this PR
 * shipped; what this file covers is what the seeded fixtures can actually
 * exercise: the plan card every role sees, and that member management is
 * gated on capability, in both directions.
 */

test.describe('an organization owner', () => {
  test.use({ storageState: sessionFile('owner') });

  test('sees the plan, the full membership, and can create an invitation', async ({ page }) => {
    await page.goto('/organization');
    await expect(page.getByRole('heading', { name: 'Organization', level: 1 })).toBeVisible();

    // The seed organization is created through the same `createOrganization`
    // every sign-up goes through, so it carries a real trial entitlements row.
    await expect(page.getByRole('heading', { name: 'Plan' })).toBeVisible();
    await expect(page.getByText('Trial', { exact: true })).toBeVisible();
    await expect(page.getByText('Starter', { exact: true })).toBeVisible();

    await expect(page.getByRole('heading', { name: 'Members' })).toBeVisible();
    for (const person of [ROLES.owner.name, ROLES.analyst.name, ROLES.reviewer.name]) {
      await expect(page.getByRole('cell', { name: person, exact: true })).toBeVisible();
    }

    await expect(page.getByRole('heading', { name: 'Invite someone' })).toBeVisible();
    await page.getByLabel('Email').fill('prospective-teammate@example.invalid');
    await page.getByRole('button', { name: 'Invite' }).click();
    await expect(page.getByText('Invited prospective-teammate@example.invalid')).toBeVisible();
    // No mail provider is bundled, so the token is shown for the owner to
    // send themselves — that string is the proof the invitation actually
    // has somewhere to go, not just a row in a table.
    await expect(page.getByText(/Share this link:/)).toBeVisible();

    await expect(page.getByRole('heading', { name: 'Data export' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Export everything' })).toBeVisible();
  });
});

test.describe('a reviewer', () => {
  test.use({ storageState: sessionFile('reviewer') });

  test('sees the plan but not member management, which their role does not carry', async ({
    page,
  }) => {
    await page.goto('/organization');
    await expect(page.getByRole('heading', { name: 'Organization', level: 1 })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Plan' })).toBeVisible();

    // Not merely styled away: `member:manage` and `organization:invite` are
    // capabilities a reviewer's role does not hold, so the page never issues
    // the members request at all — see `Organization.tsx`.
    await expect(page.getByRole('heading', { name: 'Members' })).toBeHidden();
    await expect(page.getByRole('heading', { name: 'Invite someone' })).toBeHidden();
    // organization:manage is an owner-only capability, same as the member
    // management above — a reviewer cannot bulk-export the organization's
    // data any more than they can invite someone to it.
    await expect(page.getByRole('heading', { name: 'Data export' })).toBeHidden();
  });
});

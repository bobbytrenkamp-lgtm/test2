import { expect, test as setup } from '@playwright/test';
import { ROLES, SEED_PASSWORD, sessionFile, type RoleKey } from './roles.js';

/**
 * Signs in once per role and saves the session.
 *
 * The API rate limits the login route, which is correct, so the suite must not
 * re-authenticate for every test. Doing it here also means the sign-in form
 * itself is exercised before anything else runs: if authentication is broken,
 * the failure says so plainly instead of surfacing as twenty confusing ones.
 */
for (const role of Object.keys(ROLES) as RoleKey[]) {
  setup(`sign in as ${role}`, async ({ page }) => {
    const account = ROLES[role];

    await page.goto('/');
    await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible();

    await page.getByLabel('Email address').fill(account.email);
    await page.getByLabel('Password').fill(SEED_PASSWORD);
    await page.getByRole('button', { name: 'Sign in' }).click();

    // The shell only renders once the session resolves, so waiting for the
    // primary navigation proves the cookie was accepted.
    await expect(page.getByRole('navigation', { name: 'Primary' })).toBeVisible();
    await expect(page.getByText(account.name)).toBeVisible();

    await page.context().storageState({ path: sessionFile(role) });
  });
}

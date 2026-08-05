import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import { totp } from '@cre/database';
import { ROLES, SEED_PASSWORD, sessionFile } from './roles.js';

/**
 * Enrolling a second factor, and then signing in with it.
 *
 * The API tests cover the rules. This covers the loop a person actually walks:
 * read a secret off the screen, generate a code from it, type it back, sign out,
 * and be asked for a code that was not asked for before.
 *
 * The code is generated in the test from the secret the screen displays, using
 * the same RFC 6238 implementation the server uses. That is not circular in the
 * way that matters: the implementation is pinned to the RFC's published vectors
 * elsewhere, so agreement here means the *screen* handed over a secret that
 * really does drive the login it is supposed to.
 */
const STANDARD = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'];

test.describe('enrolment', () => {
  // The reviewer account, so this cannot disturb the sessions the rest of the
  // suite reuses for the owner and analyst.
  test.use({ storageState: sessionFile('reviewer') });

  test('enrols, then requires a code that was not required before', async ({ page, browser }) => {
    await page.goto('/security');
    await expect(page.getByRole('heading', { name: 'Security', level: 1 })).toBeVisible();

    // Off to begin with.
    await expect(page.getByRole('heading', { name: 'Two-factor authentication' })).toBeVisible();
    await page.getByRole('button', { name: 'Set up two-factor authentication' }).click();

    await expect(page.getByRole('heading', { name: /add it to your authenticator/i })).toBeVisible({
      timeout: 30_000,
    });

    // The secret, as an authenticator app would be given it.
    const secret = (await page.locator('code').first().innerText()).trim();
    expect(secret).toMatch(/^[A-Z2-7]{32}$/);

    // Nothing is protected yet: the account is not enrolled until a code lands.
    await page.getByLabel('Code from your app').fill(totp(secret));
    await page.getByRole('button', { name: 'Turn on two-factor authentication' }).click();

    // Recovery codes are shown exactly once, and the screen says so.
    const codesPanel = page.getByRole('status', { name: 'Recovery codes' });
    await expect(codesPanel).toBeVisible({ timeout: 30_000 });
    await expect(codesPanel).toContainText('shown once');
    const recovery = (await codesPanel.locator('code').allInnerTexts()).map((t) => t.trim());
    expect(recovery).toHaveLength(10);

    /*
     * The sign-in half runs in its own browser context, signed out.
     *
     * Signing *this* page out instead would revoke the shared reviewer session
     * that `sessionFile('reviewer')` hands to every other spec — which is
     * exactly what happened the first time this was written: the whole file
     * passed alone and broke `tasks.spec.ts` in the full run. A fresh context
     * proves the same thing and touches nobody else's session.
     */
    const fresh = await browser.newContext({ storageState: { cookies: [], origins: [] } });
    const guest = await fresh.newPage();
    try {
      await guest.goto('/');
      await expect(guest.getByRole('heading', { name: 'Sign in' })).toBeVisible();

      await guest.getByLabel('Email address').fill(ROLES.reviewer.email);
      await guest.getByLabel('Password').fill(SEED_PASSWORD);
      await guest.getByRole('button', { name: 'Sign in' }).click();

      // The code field appears only once the server has asked for it.
      await expect(guest.getByLabel('Authenticator code')).toBeVisible({ timeout: 30_000 });
      await expect(guest.getByRole('alert')).toContainText(/authenticator/i);

      // A wrong code does not get in.
      await guest.getByLabel('Authenticator code').fill('000001');
      await guest.getByRole('button', { name: 'Sign in' }).click();
      await expect(guest.getByLabel('Authenticator code')).toBeVisible();

      // The real one does.
      await guest.getByLabel('Authenticator code').fill(totp(secret));
      await guest.getByRole('button', { name: 'Sign in' }).click();
      await expect(guest.getByRole('navigation', { name: 'Primary' })).toBeVisible({
        timeout: 30_000,
      });
    } finally {
      await fresh.close();
    }

    /*
     * Put the account back as it was found. The suite reuses these seeded
     * accounts across files, and a test that leaves a second factor behind
     * would break every later run rather than only itself.
     */
    await page.goto('/security');
    await page.getByLabel('Current password').fill(SEED_PASSWORD);
    await page.getByRole('button', { name: 'Turn off two-factor authentication' }).click();
    await expect(
      page.getByRole('button', { name: 'Set up two-factor authentication' }),
    ).toBeVisible({ timeout: 30_000 });
  });
});

test.describe('the security screen', () => {
  test.use({ storageState: sessionFile('owner') });

  test('is accessible', async ({ page }) => {
    await page.goto('/security');
    await expect(page.getByRole('heading', { name: 'Security', level: 1 })).toBeVisible();

    const { violations } = await new AxeBuilder({ page }).withTags(STANDARD).analyze();
    const summary = violations.map(
      (violation) =>
        `${violation.id} (${violation.impact ?? 'unknown'}): ${violation.help}\n` +
        violation.nodes.map((node) => `      ${node.target.join(' ')}`).join('\n'),
    );
    expect(summary, summary.join('\n')).toEqual([]);
  });

  test('says what it does not protect against', async ({ page }) => {
    // An honest security screen is one that states its own limits. Somebody
    // relaying a code in real time is inside the window, and no shared-secret
    // scheme fixes that — claiming otherwise is how a false sense of safety
    // gets built.
    await page.goto('/security');
    await expect(page.getByText(/relaying a code to this site in real time/i)).toBeVisible();
  });
});

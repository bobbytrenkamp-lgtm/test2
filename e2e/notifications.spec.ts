import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import { SEED, sessionFile } from './roles.js';

/**
 * Mention notifications.
 *
 * `review.spec.ts` covers a comment itself being recorded and read; this is
 * the half that used to be missing — the person a comment names finding out
 * about it anywhere but the thread they were not already reading.
 *
 * `fullyParallel: false` and a single worker (see playwright.config.ts) make
 * the two describe blocks below run in file order against the same seeded
 * database, which is what lets the second one observe what the first one
 * created.
 */
const STANDARD = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'];

test.describe('as the analyst who draws a colleague in', () => {
  test.use({ storageState: sessionFile('analyst') });

  test('mentioning a reviewer records it on the comment', async ({ page }) => {
    await page.goto('/properties');
    await page.getByRole('link', { name: SEED.office.property }).click();
    await page.getByRole('link', { name: SEED.office.model }).click();
    await page.getByRole('link', { name: 'Review' }).click();

    const note = `Please check the renewal probability on suite 400 (${Date.now()}).`;
    await page.getByLabel('Add a comment').fill(note);
    await page.getByLabel('Draw someone in').selectOption({ label: 'Priya Ramanathan' });
    await page.getByRole('button', { name: 'Post comment' }).click();
    await expect(page.getByText(note)).toBeVisible({ timeout: 30_000 });
  });
});

test.describe('as the reviewer who was mentioned', () => {
  test.use({ storageState: sessionFile('reviewer') });

  test('sees it in the notification feed, and reading it clears the unread count', async ({
    page,
  }) => {
    await page.goto('/');
    const bell = page.getByRole('button', { name: /Notifications/ });
    await expect(bell).toBeVisible();
    await bell.click();

    const panel = page.getByRole('region', { name: 'Notifications' });
    await expect(panel).toBeVisible();
    const mention = panel.locator('.notification-item.unread').filter({ hasText: 'Rowan Estrada' });
    await expect(mention).toBeVisible();

    // Clicking it navigates to what it names and marks it read.
    await mention.click();
    await expect(page).toHaveURL(/\/models\//);

    await bell.click();
    await expect(page.locator('.notification-item.unread')).toHaveCount(0);
  });

  test('is accessible with the panel open', async ({ page }) => {
    // The interactive state, not just the closed bell — a badge and a plain
    // button are trivially accessible; the panel with its list and links is
    // the part worth checking.
    await page.goto('/');
    await page.getByRole('button', { name: /Notifications/ }).click();
    await expect(page.getByRole('region', { name: 'Notifications' })).toBeVisible();

    const { violations } = await new AxeBuilder({ page }).withTags(STANDARD).analyze();
    const summary = violations.map(
      (violation) =>
        `${violation.id} (${violation.impact ?? 'unknown'}): ${violation.help}\n` +
        violation.nodes.map((node) => `      ${node.target.join(' ')}`).join('\n'),
    );
    expect(summary, summary.join('\n')).toEqual([]);
  });
});

import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import { SEED, sessionFile } from './roles.js';

test.use({ storageState: sessionFile('owner') });

/**
 * Recents and favourites.
 *
 * The API test proves the toggle and the organization scoping; what the
 * browser has to prove is the two things that only exist there:
 *
 * 1. **The star reflects the pinned state, and it survives a reload.** A flip
 *    that only lived in local component state would vanish the moment the
 *    page did.
 * 2. **Recents live in the browser, not on the server.** Opening a model is
 *    enough to put it on the dashboard, with no explicit save — and clearing
 *    storage (the same as a different device) makes it disappear, while a
 *    server-recorded favourite does not.
 *
 * Every test unpins whatever it pinned. This suite shares a database with
 * every other spec, and the dashboard section this exercises is the first
 * thing several unrelated specs would see if a favourite were left behind.
 */

test('pinning flips the star and survives a reload', async ({ page }) => {
  await page.goto('/properties');
  await page.getByRole('link', { name: SEED.office.property }).click();
  await expect(page.getByRole('heading', { name: SEED.office.property, level: 1 })).toBeVisible();

  const star = page.getByRole('button', { name: `Add ${SEED.office.property} to favourites` });
  await expect(star).toBeVisible();
  await star.click();
  await expect(
    page.getByRole('button', { name: `Remove ${SEED.office.property} from favourites` }),
  ).toBeVisible();

  // Not just local component state: a reload has nothing to remember except
  // what the server was told.
  await page.reload();
  await expect(
    page.getByRole('button', { name: `Remove ${SEED.office.property} from favourites` }),
  ).toBeVisible();

  // Clean up: unpin.
  await page
    .getByRole('button', { name: `Remove ${SEED.office.property} from favourites` })
    .click();
  await expect(
    page.getByRole('button', { name: `Add ${SEED.office.property} to favourites` }),
  ).toBeVisible();
});

test('a pinned asset appears on the dashboard and in the palette', async ({ page }) => {
  await page.goto('/properties');
  await page.getByRole('link', { name: SEED.industrial.property }).click();
  await page.getByRole('button', { name: `Add ${SEED.industrial.property} to favourites` }).click();

  await page.goto('/');
  const favouritesCard = page.locator('.pinned-list').first();
  await expect(favouritesCard.getByRole('link', { name: SEED.industrial.property })).toBeVisible();

  // The palette's "where was I" answer, reached without typing anything.
  await page.keyboard.press('Control+k');
  await expect(
    page.getByRole('option', { name: new RegExp(SEED.industrial.property) }).first(),
  ).toBeVisible();
  await page.keyboard.press('Escape');

  await page.goto(`/properties`);
  await page.getByRole('link', { name: SEED.industrial.property }).click();
  await page
    .getByRole('button', { name: `Remove ${SEED.industrial.property} from favourites` })
    .click();
});

test('recently viewed is local: it appears without pinning and clears with storage', async ({
  page,
}) => {
  /*
   * Pinning the industrial property keeps the dashboard section on screen
   * after local storage is cleared below — otherwise, with nothing pinned and
   * nothing recent, the whole section returns null and there would be nothing
   * to assert against.
   */
  await page.goto('/properties');
  await page.getByRole('link', { name: SEED.industrial.property }).click();
  await page.getByRole('button', { name: `Add ${SEED.industrial.property} to favourites` }).click();

  await page.goto('/properties');
  await page.getByRole('link', { name: SEED.office.property }).click();
  await expect(page.getByRole('heading', { name: SEED.office.property, level: 1 })).toBeVisible();

  await page.goto('/');
  const recentSection = page.locator('.pinned-recent-grid').locator('div', {
    has: page.getByRole('heading', { name: 'Recently viewed' }),
  });
  await expect(recentSection.getByRole('link', { name: SEED.office.property })).toBeVisible();

  /*
   * Recorded on this device only, unlike a favourite. Clearing local storage —
   * standing in for a different device, or a different person on a shared one
   * — makes it disappear while the session cookie and the server-recorded
   * favourite are untouched.
   */
  await page.evaluate(() => window.localStorage.clear());
  await page.reload();
  await expect(recentSection.getByText('Properties and models you open appear here')).toBeVisible();
  await expect(
    page.locator('.pinned-list').first().getByRole('link', { name: SEED.industrial.property }),
  ).toBeVisible();

  await page.goto('/properties');
  await page.getByRole('link', { name: SEED.industrial.property }).click();
  await page
    .getByRole('button', { name: `Remove ${SEED.industrial.property} from favourites` })
    .click();
});

test('the dashboard section is accessible', async ({ page }) => {
  await page.goto('/properties');
  await page.getByRole('link', { name: SEED.office.property }).click();
  await page.getByRole('button', { name: `Add ${SEED.office.property} to favourites` }).click();

  await page.goto('/');
  await expect(page.locator('.pinned-recent-grid')).toBeVisible();

  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .analyze();
  expect(
    results.violations.map((violation) => `${violation.id}: ${violation.help}`),
    results.violations.map((violation) => violation.id).join(', '),
  ).toEqual([]);

  await page.goto('/properties');
  await page.getByRole('link', { name: SEED.office.property }).click();
  await page
    .getByRole('button', { name: `Remove ${SEED.office.property} from favourites` })
    .click();
});

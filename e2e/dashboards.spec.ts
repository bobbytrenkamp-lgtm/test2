import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import { sessionFile } from './roles.js';

/**
 * Configurable dashboards.
 *
 * `dashboards` has existed since this platform's first migration, designed
 * but never wired to a screen. This drives the path an owner actually
 * takes: hide a widget, reorder what remains, reload and see it hold, then
 * reset back to the default.
 */
const STANDARD = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'];

test.use({ storageState: sessionFile('owner') });

test.afterEach(async ({ page }) => {
  // Each test starts from a clean slate rather than depending on the
  // previous one's outcome, so a failure in one does not cascade into the
  // next by leaving the dashboard customized.
  await page.request.delete('/api/v1/dashboards?scope=organization', {
    headers: { 'X-Requested-With': 'cre-platform' },
  });
});

test('hides a widget and shows it again', async ({ page }) => {
  await page.goto('/');
  const heading = page.getByRole('heading', { name: 'Assets by property type' });
  await expect(heading).toBeVisible();

  await page.getByRole('button', { name: 'Customize dashboard' }).click();
  await page.getByRole('checkbox', { name: 'Assets by property type', exact: true }).uncheck();
  await expect(heading).toBeHidden();

  await page.getByRole('checkbox', { name: 'Assets by property type', exact: true }).check();
  await expect(heading).toBeVisible();
});

test('reorders widgets, and a reload remembers it', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Customize dashboard' }).click();

  const items = page.locator('.dashboard-customizer-list li');
  const firstLabel = await items.nth(0).locator('label').textContent();
  await items
    .nth(0)
    .getByRole('button', { name: /Move .* down/ })
    .click();

  // The item that was first is now second, in the same panel.
  await expect(items.nth(1).locator('label')).toHaveText(firstLabel ?? '');

  await page.reload();
  await page.getByRole('button', { name: 'Customize dashboard' }).click();
  await expect(page.locator('.dashboard-customizer-list li').nth(1).locator('label')).toHaveText(
    firstLabel ?? '',
  );
});

test('resets to the default layout', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Customize dashboard' }).click();
  await page.getByRole('checkbox', { name: 'Recently updated properties', exact: true }).uncheck();
  await expect(page.getByRole('heading', { name: 'Recently updated properties' })).toBeHidden();

  await page.getByRole('button', { name: 'Reset to default' }).click();
  await expect(page.getByRole('heading', { name: 'Recently updated properties' })).toBeVisible();
  await expect(
    page.getByRole('checkbox', { name: 'Recently updated properties', exact: true }),
  ).toBeChecked();
});

test('is accessible with the customizer open', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Customize dashboard' }).click();
  await expect(page.getByRole('heading', { name: 'Customize dashboard' })).toBeVisible();

  const { violations } = await new AxeBuilder({ page }).withTags(STANDARD).analyze();
  const summary = violations.map(
    (violation) =>
      `${violation.id} (${violation.impact ?? 'unknown'}): ${violation.help}\n` +
      violation.nodes.map((node) => `      ${node.target.join(' ')}`).join('\n'),
  );
  expect(summary, summary.join('\n')).toEqual([]);
});

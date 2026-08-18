import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import { sessionFile } from './roles.js';

/**
 * "New Underwriting": the guided flow that replaces "create a property,
 * then remember to go create a model on it too" with one form and one
 * landing spot.
 */
const STANDARD = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'];

test.describe('as an analyst', () => {
  test.use({ storageState: sessionFile('analyst') });

  test('creates a property and its first model together, and lands directly on the new model’s assumptions', async ({
    page,
  }) => {
    await page.goto('/');
    await page.getByRole('link', { name: 'New underwriting' }).click();
    await expect(page.getByRole('heading', { name: 'New underwriting' })).toBeVisible();

    await page.getByLabel('Name', { exact: true }).fill('E2E Underwriting Tower');
    await page.getByLabel('Property type').selectOption('office');
    await page.getByLabel('Rentable area').fill('180000');

    await page.getByLabel('Model name').fill('E2E acquisition case');
    await page.getByLabel('Forecast start').fill('2027-01-01');

    await page.getByRole('button', { name: 'Start underwriting' }).click();

    // Landed straight on the new model's Assumptions tab, not on the
    // property list or the property detail page.
    await expect(page).toHaveURL(/\/models\/[0-9a-f-]+\/assumptions/);
    await expect(
      page.getByRole('heading', { name: 'Valuation and vacancy assumptions' }),
    ).toBeVisible();

    // And the model workspace actually resolved the property this same
    // request created — its own breadcrumb names it, and links back to it.
    await expect(
      page.getByRole('navigation', { name: 'Breadcrumb' }).getByRole('link', {
        name: 'E2E Underwriting Tower',
      }),
    ).toBeVisible();
  });

  test('is accessible', async ({ page }) => {
    await page.goto('/underwriting/new');
    await expect(page.getByRole('heading', { name: 'New underwriting' })).toBeVisible();

    const { violations } = await new AxeBuilder({ page }).withTags(STANDARD).analyze();
    const summary = violations.map(
      (violation) =>
        `${violation.id} (${violation.impact ?? 'unknown'}): ${violation.help}\n` +
        violation.nodes.map((node) => `      ${node.target.join(' ')}`).join('\n'),
    );
    expect(summary, summary.join('\n')).toEqual([]);
  });
});

test.describe('as a reviewer', () => {
  test.use({ storageState: sessionFile('reviewer') });

  test('does not see the New underwriting link, and is refused if it navigates there directly', async ({
    page,
  }) => {
    await page.goto('/');
    await expect(page.getByRole('link', { name: 'New underwriting' })).toBeHidden();

    // A reviewer holds neither property:write nor model:write. The server
    // refuses regardless; the page's own message is so a refusal is never
    // how somebody finds out.
    await page.goto('/underwriting/new');
    await expect(
      page.getByRole('heading', { name: 'You cannot start a new underwriting' }),
    ).toBeVisible();
  });
});

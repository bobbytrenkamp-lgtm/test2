import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import { SEED, sessionFile } from './roles.js';

/**
 * The Inputs tab: one place to see what data a model has and where to add
 * more, instead of four separate tabs (Rent roll, Assumptions, Assumption
 * import, Imports) with no single starting point. Reuses the same
 * `GET /models/:id/workflow` data the progress strip already shows.
 */
const STANDARD = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'];

test.describe('as an analyst', () => {
  test.use({ storageState: sessionFile('analyst') });

  async function openInputs(page: import('@playwright/test').Page): Promise<void> {
    await page.goto('/properties');
    await page.getByRole('link', { name: SEED.office.property }).click();
    await page.getByRole('link', { name: SEED.office.model }).click();
    await page.getByRole('link', { name: 'Inputs' }).click();
    await expect(page.getByRole('heading', { name: 'Inputs', level: 1 })).toBeVisible();
  }

  test('shows the six input areas with real status for the seeded model', async ({ page }) => {
    await openInputs(page);

    for (const title of [
      'Rent Roll',
      'Operating',
      'Capital',
      'Debt',
      'Assumption Extract',
      'Rent Roll Spreadsheet',
    ]) {
      await expect(page.getByRole('heading', { name: title, level: 2, exact: true })).toBeVisible();
    }

    // The seeded office model has a full rent roll — a real status, not a
    // placeholder. `exact: true` matters here: "Rent Roll" is otherwise a
    // substring match of the "Rent Roll Spreadsheet" card's own heading.
    const rentRollCard = page.locator('.card', {
      has: page.getByRole('heading', { name: 'Rent Roll', level: 2, exact: true }),
    });
    await expect(rentRollCard.getByText('Done', { exact: true })).toBeVisible();
  });

  test('each card opens the right screen, without colliding with the tab bar', async ({ page }) => {
    await openInputs(page);

    const rentRollCard = page.locator('.card', {
      has: page.getByRole('heading', { name: 'Rent Roll', level: 2, exact: true }),
    });
    await rentRollCard.getByRole('link', { name: 'Open the leasing screen' }).click();
    await expect(page).toHaveURL(/\/models\/[0-9a-f-]+\/rent-roll/);
    await expect(page.getByRole('heading', { name: 'Leases', level: 2 })).toBeVisible();
  });

  test('is accessible', async ({ page }) => {
    await openInputs(page);

    const { violations } = await new AxeBuilder({ page }).withTags(STANDARD).analyze();
    const summary = violations.map(
      (violation) =>
        `${violation.id} (${violation.impact ?? 'unknown'}): ${violation.help}\n` +
        violation.nodes.map((node) => `      ${node.target.join(' ')}`).join('\n'),
    );
    expect(summary, summary.join('\n')).toEqual([]);
  });
});

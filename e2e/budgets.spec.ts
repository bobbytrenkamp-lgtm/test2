import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { SEED, sessionFile } from './roles.js';

test.use({ storageState: sessionFile('owner') });

/**
 * Budget, actuals and variance.
 *
 * The seed carries an approved FY2026 budget and six months of actuals against
 * it for the office asset, deliberately deviating in both directions, so this
 * exercises a real comparison rather than an empty form.
 */
async function openBudgets(page: Page): Promise<void> {
  await page.goto('/properties');
  await page.getByRole('link', { name: SEED.office.property }).click();
  await page.getByRole('link', { name: SEED.office.model }).click();
  await page.getByRole('link', { name: 'Budgets' }).click();
  await expect(page.getByRole('heading', { name: 'Budgets and actuals' })).toBeVisible();
}

/**
 * Chooses an option by the text a person would read.
 *
 * The values are generated identifiers, and `selectOption` matches labels only
 * as exact strings, so the option is resolved by its visible text first.
 */
async function chooseByText(page: Page, label: string, text: string): Promise<void> {
  const select = page.getByLabel(label, { exact: true });
  const option = select.locator('option').filter({ hasText: text });
  const value = await option.first().getAttribute('value');
  if (!value) throw new Error(`No option matching "${text}" in "${label}".`);
  await select.selectOption(value);
}

/** Selects the base and comparison the seeded data provides. */
async function compareBudgetToActuals(page: Page): Promise<void> {
  await chooseByText(page, 'Measure against (base)', 'approved budget');
  await chooseByText(page, 'Compare', 'actuals to June');
}

test('lists the seeded budget periods and shows the approved one as frozen', async ({ page }) => {
  await openBudgets(page);

  const table = page.getByRole('table', { name: 'Budget periods for this property' });
  await expect(table.getByRole('row').filter({ hasText: 'FY2026 approved budget' })).toBeVisible();
  await expect(table.getByRole('row').filter({ hasText: 'FY2026 actuals to June' })).toBeVisible();

  // Approving freezes the figures, so the approved period offers no import
  // control. A button that would be refused by the server should not be shown.
  const approved = table.getByRole('row').filter({ hasText: 'FY2026 approved budget' });
  await expect(approved).toContainText('Approved');
  await expect(approved.getByRole('button', { name: 'Import' })).toHaveCount(0);
});

test('computes a variance between the approved budget and the actuals', async ({ page }) => {
  await openBudgets(page);

  await compareBudgetToActuals(page);

  const variance = page.getByRole('table', { name: /Variance by account/ });
  await expect(variance).toBeVisible();

  // Property taxes were budgeted and spent identically every month, so the
  // designation must be neutral rather than favourable — a zero variance is
  // not good news, it is no news.
  const taxes = variance.getByRole('row').filter({ hasText: 'Property taxes' });
  await expect(taxes).toContainText('Neutral');

  // Repairs overspent in March. Costs are held negative, so a worse outcome is
  // a negative variance, and that is what makes it unfavourable.
  const repairs = variance.getByRole('row').filter({ hasText: 'Repairs and maintenance' });
  await expect(repairs).toContainText('Unfavourable');

  // The net row is the sum, not a category-aware subtraction.
  await expect(variance.getByRole('row').filter({ hasText: 'Net' })).toBeVisible();
});

test('compares the budget against the model forecast', async ({ page }) => {
  await openBudgets(page);

  await chooseByText(page, 'Measure against (base)', 'approved budget');
  await page.getByLabel('Compare', { exact: true }).selectOption('__forecast__');

  // The forecast side needs no second data entry pass: the model already holds
  // the same accounts month by month in the same sign convention.
  await expect(page.getByText(/Forecast, engine/)).toBeVisible();
  await expect(page.getByRole('table', { name: /Variance by account/ })).toBeVisible();
});

test('the budgets screen is accessible', async ({ page }) => {
  await openBudgets(page);
  await compareBudgetToActuals(page);
  await expect(page.getByRole('table', { name: /Variance by account/ })).toBeVisible();

  const { violations } = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .analyze();
  const summary = violations.map(
    (violation) =>
      `${violation.id} (${violation.impact ?? 'unknown'}): ${violation.help}\n` +
      violation.nodes.map((node) => `      ${node.target.join(' ')}`).join('\n'),
  );
  expect(summary, summary.join('\n')).toEqual([]);
});

test.describe('a reviewer', () => {
  test.use({ storageState: sessionFile('reviewer') });

  test('can read budgets but not author one', async ({ page }) => {
    await openBudgets(page);
    // budget:write is not a reviewer capability; model:approve is.
    await expect(page.getByRole('button', { name: 'New budget' })).toHaveCount(0);
    await expect(
      page.getByRole('table', { name: 'Budget periods for this property' }),
    ).toBeVisible();
  });
});

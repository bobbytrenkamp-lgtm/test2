import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { SEED, sessionFile } from './roles.js';

/**
 * Automated accessibility checks.
 *
 * These catch the mechanical failures — an unlabelled control, a contrast
 * ratio below the threshold, a heading level skipped — which are the ones worth
 * catching automatically because they are easy to reintroduce and tedious to
 * find by hand. They are not a substitute for using the platform with a screen
 * reader, and `docs/testing-strategy.md` says so; an audit with real assistive
 * technology is still outstanding.
 */
const STANDARD = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'];

async function audit(page: Page): Promise<void> {
  const { violations } = await new AxeBuilder({ page }).withTags(STANDARD).analyze();

  // Report every rule and the element that broke it, so a failure is
  // actionable from the log alone rather than needing the run reproduced.
  const summary = violations.map(
    (violation) =>
      `${violation.id} (${violation.impact ?? 'unknown'}): ${violation.help}\n` +
      violation.nodes.map((node) => `      ${node.target.join(' ')}`).join('\n'),
  );
  expect(summary, summary.join('\n')).toEqual([]);
}

test.describe('signed out', () => {
  test.use({ storageState: { cookies: [], origins: [] } });

  test('the sign-in page', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible();
    await audit(page);
  });
});

test.describe('signed in', () => {
  test.use({ storageState: sessionFile('owner') });

  test('the dashboard', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByRole('navigation', { name: 'Primary' })).toBeVisible();
    await audit(page);
  });

  test('the property list', async ({ page }) => {
    await page.goto('/properties');
    await expect(page.getByRole('heading', { name: 'Properties', level: 1 })).toBeVisible();
    await audit(page);
  });

  test('a property and its models', async ({ page }) => {
    await page.goto('/properties');
    await page.getByRole('link', { name: SEED.office.property }).click();
    await expect(page.getByRole('heading', { name: 'Physical structure' })).toBeVisible();
    await audit(page);
  });

  test('the cash flow, after a calculation', async ({ page }) => {
    await page.goto('/properties');
    await page.getByRole('link', { name: SEED.industrial.property }).click();
    await page.getByRole('link', { name: SEED.industrial.model }).click();
    await page.getByRole('button', { name: 'Calculate' }).click();
    await expect(page.getByRole('status')).toContainText('Calculated with engine', {
      timeout: 60_000,
    });
    await audit(page);
  });

  test('the returns and debt tab', async ({ page }) => {
    await page.goto('/properties');
    await page.getByRole('link', { name: SEED.industrial.property }).click();
    await page.getByRole('link', { name: SEED.industrial.model }).click();
    await page.getByRole('button', { name: 'Calculate' }).click();
    await expect(page.getByRole('status')).toContainText('Calculated with engine', {
      timeout: 60_000,
    });
    await page.getByRole('link', { name: 'Returns and debt' }).click();
    await audit(page);
  });

  test('the portfolio aggregate', async ({ page }) => {
    await page.goto('/portfolios');
    await expect(page.getByRole('heading', { name: 'Portfolios', level: 1 })).toBeVisible();
    await audit(page);
  });

  test('the lease editor', async ({ page }) => {
    await page.goto('/properties');
    await page.getByRole('link', { name: SEED.office.property }).click();
    await page.getByRole('link', { name: SEED.office.model }).click();
    await page.getByRole('link', { name: 'Rent roll' }).click();
    await page.getByRole('button', { name: 'Add lease' }).click();
    await expect(page.getByRole('heading', { name: 'New lease' })).toBeVisible();
    await audit(page);
  });

  test('the import wizard', async ({ page }) => {
    await page.goto('/properties');
    await page.getByRole('link', { name: SEED.office.property }).click();
    await page.getByRole('link', { name: SEED.office.model }).click();
    await page.getByRole('link', { name: 'Imports' }).click();
    await expect(page.getByRole('heading', { name: 'Import a rent roll' })).toBeVisible();
    await audit(page);
  });
});

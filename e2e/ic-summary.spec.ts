import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { SEED, sessionFile } from './roles.js';

test.use({ storageState: sessionFile('owner') });

/**
 * The investment committee summary.
 *
 * One page built to be read by somebody who did not build the model, and
 * printed as often as it is read on screen. What matters in the browser is
 * not the arithmetic — every figure comes from the Returns and Health tabs,
 * which already have their own tests — but that this page never disagrees
 * with them, and that risk is not quietly dropped on the way to a summary.
 */

async function openICSummary(page: Page): Promise<void> {
  await page.goto('/properties');
  await page.getByRole('link', { name: SEED.office.property }).click();
  await page.getByRole('link', { name: SEED.office.model }).click();
  await page.getByRole('button', { name: /^Calculat/ }).click();
  await expect(page.getByRole('status', { name: 'Model status' })).toContainText('Calculated', {
    timeout: 120_000,
  });
  await page.getByRole('link', { name: 'IC summary', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: 'Investment committee summary' }),
  ).toBeVisible();
}

test('states the same returns the Returns tab shows', async ({ page }) => {
  await openICSummary(page);

  const summaryIrr = await page
    .locator('.metric', { hasText: 'Unlevered IRR' })
    .locator('dd')
    .first()
    .innerText();

  await page.getByRole('link', { name: 'Returns and debt' }).click();
  const returnsIrr = await page
    .locator('.metric', { hasText: 'Unlevered IRR' })
    .locator('dd')
    .first()
    .innerText();

  // Not recomputed — read from the same stored result, so the two figures
  // must be identical rather than merely close.
  expect(summaryIrr.split('\n')[0]).toBe(returnsIrr.split('\n')[0]);
});

test('leads with the health tab’s own warnings, not a score', async ({ page }) => {
  await openICSummary(page);

  const risk = page.locator('.card', { has: page.getByRole('heading', { name: 'Risk' }) });
  await expect(risk).toBeVisible();
  // No numeric score anywhere on the page — the same rule the Health tab
  // itself is held to, carried over rather than re-decided here.
  await expect(page.locator('body')).not.toContainText(/\b\d{1,3}\s*\/\s*100\b/);
});

test('a finding on this page matches one on the health tab', async ({ page }) => {
  await openICSummary(page);

  const risk = page.locator('.card', { has: page.getByRole('heading', { name: 'Risk' }) });
  const finding = risk.locator('.finding').first();
  await expect(finding).toBeVisible();
  const title = await finding.locator('strong').innerText();

  await page.getByRole('link', { name: 'Health', exact: true }).click();
  await expect(page.locator('.finding', { hasText: title }).first()).toBeVisible();
});

test('the print button does not navigate away', async ({ page }) => {
  // `window.print()` opens the OS print dialog, which Playwright cannot drive
  // and which would hang the test if it tried. What is checkable from here is
  // that the button exists, is reachable, and that clicking it leaves the
  // summary itself exactly where it was.
  await openICSummary(page);
  await page.evaluate(() => {
    window.print = () => {
      /* stubbed: the real dialog is outside what a browser test can drive */
    };
  });
  await page.getByRole('button', { name: 'Print' }).click();
  await expect(
    page.getByRole('heading', { name: 'Investment committee summary' }),
  ).toBeVisible();
});

test('is accessible', async ({ page }) => {
  await openICSummary(page);
  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .analyze();
  expect(
    results.violations.map((violation) => `${violation.id}: ${violation.help}`),
    results.violations.map((violation) => violation.id).join(', '),
  ).toEqual([]);
});

import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { SEED, sessionFile } from './roles.js';

/**
 * The underwriting package download, from the IC summary screen.
 *
 * The workbook's own content — that the summary sheet reads the same
 * figures the Returns and Health tabs show — is proven server-side in
 * tests/underwriting-package-export.test.ts. What only the browser can
 * prove is that the button a reviewer actually clicks produces a real
 * download rather than a broken link.
 */
const STANDARD = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'];

test.use({ storageState: sessionFile('owner') });

async function openICSummary(page: Page): Promise<void> {
  await page.goto('/properties');
  await page.getByRole('link', { name: SEED.office.property }).click();
  await page.getByRole('link', { name: SEED.office.model }).click();
  await page.getByRole('button', { name: /^Calculat/ }).click();
  await expect(page.getByRole('status', { name: 'Model status' })).toContainText('Calculated', {
    timeout: 120_000,
  });
  await page.getByRole('link', { name: 'IC summary', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Investment committee summary' })).toBeVisible();
}

test('downloads a workbook, not a broken link', async ({ page }) => {
  await openICSummary(page);

  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('link', { name: 'Download underwriting package' }).click(),
  ]);

  expect(download.suggestedFilename()).toMatch(/-underwriting-package\.xlsx$/);
  const failure = await download.failure();
  expect(failure).toBeNull();
});

test('sits beside Print rather than replacing it', async ({ page }) => {
  await openICSummary(page);
  await expect(page.getByRole('link', { name: 'Download underwriting package' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Print' })).toBeVisible();
});

test('is accessible with the download link present', async ({ page }) => {
  await openICSummary(page);
  await expect(page.getByRole('link', { name: 'Download underwriting package' })).toBeVisible();

  const { violations } = await new AxeBuilder({ page }).withTags(STANDARD).analyze();
  const summary = violations.map(
    (violation) =>
      `${violation.id} (${violation.impact ?? 'unknown'}): ${violation.help}\n` +
      violation.nodes.map((node) => `      ${node.target.join(' ')}`).join('\n'),
  );
  expect(summary, summary.join('\n')).toEqual([]);
});

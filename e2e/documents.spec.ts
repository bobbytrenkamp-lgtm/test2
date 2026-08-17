import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import { SEED, sessionFile } from './roles.js';

/**
 * Documents attached to a property.
 *
 * `documents` and `STORAGE_DRIVER` have existed since this platform's first
 * migration, designed but never wired to a route or a screen. This drives
 * the path an analyst actually takes: pick a real file, see it land on the
 * property, and get exactly those bytes back.
 */
const STANDARD = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'];

test.describe('as an analyst', () => {
  test.use({ storageState: sessionFile('analyst') });

  test('uploads a document and downloads exactly what was uploaded', async ({ page }) => {
    await page.goto('/properties');
    await page.getByRole('link', { name: SEED.office.property }).click();
    await expect(page.getByRole('heading', { name: 'Documents', exact: true })).toBeVisible();

    const contents = `Lease abstract for suite 400, prepared ${Date.now()}.`;
    await page.getByLabel('Upload a document').setInputFiles({
      name: `e2e-lease-abstract-${Date.now()}.txt`,
      mimeType: 'text/plain',
      buffer: Buffer.from(contents),
    });

    const row = page.locator('tbody tr').filter({ hasText: 'e2e-lease-abstract' });
    await expect(row).toBeVisible({ timeout: 30_000 });
    await expect(row).toContainText('Rowan Estrada');

    const [download] = await Promise.all([
      page.waitForEvent('download'),
      row.getByRole('link').click(),
    ]);
    const path = await download.path();
    expect(path).not.toBeNull();
    const fs = await import('node:fs/promises');
    expect((await fs.readFile(path as string)).toString('utf8')).toBe(contents);

    await row.getByRole('button', { name: 'Delete' }).click();
    await expect(row).toBeHidden({ timeout: 30_000 });
  });

  test('is accessible', async ({ page }) => {
    await page.goto('/properties');
    await page.getByRole('link', { name: SEED.office.property }).click();
    await expect(page.getByRole('heading', { name: 'Documents', exact: true })).toBeVisible();

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

  test('sees documents but is offered no way to add or remove one', async ({ page }) => {
    // Reading and commenting on a review are permissions a reviewer holds;
    // writing to the property itself is not — the same distinction
    // `review.spec.ts` draws for comments.
    await page.goto('/properties');
    await page.getByRole('link', { name: SEED.office.property }).click();
    await expect(page.getByRole('heading', { name: 'Documents', exact: true })).toBeVisible();

    await expect(page.getByLabel('Upload a document')).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Delete' })).toHaveCount(0);
  });
});

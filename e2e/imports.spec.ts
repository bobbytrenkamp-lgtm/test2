import { expect, test } from '@playwright/test';
import { SEED, sessionFile } from './roles.js';

test.use({ storageState: sessionFile('owner') });

/**
 * The rent-roll import wizard.
 *
 * The promise the wizard makes is that nothing is written until the analyst has
 * seen what will be written. This test takes it at its word with a file that is
 * deliberately part wrong: a sound row and a row whose lease ends before it
 * begins. The sound row must arrive in the rent roll; the broken one must be
 * named, refused, and counted — silently dropping it would be worse than
 * failing outright, because the total would look right.
 */
const CSV = [
  'Suite,Tenant,Lease ID,Area,Lease Start,Lease End,Base Rent',
  '2200,Alder & Finch LLP,E2E-IMPORT-GOOD,6500,2027-03-01,2034-02-28,"$41.00"',
  '2300,Northwind Cartography,E2E-IMPORT-BAD,3100,2027-05-01,2026-04-30,"$39.50"',
].join('\n');

test('analyses, reports findings, and imports only the sound rows', async ({ page }) => {
  await page.goto('/properties');
  await page.getByRole('link', { name: SEED.office.property }).click();
  await page.getByRole('link', { name: SEED.office.model }).click();
  await page.getByRole('link', { name: 'Imports' }).click();

  await expect(page.getByRole('heading', { name: 'Import a rent roll' })).toBeVisible();

  await page.getByLabel('File name').fill('e2e-rent-roll.csv');
  await page.getByLabel('CSV contents').fill(CSV);
  await page.getByRole('button', { name: 'Analyse the file' }).click();

  // Header detection and column matching happen before any mapping is shown.
  await expect(page.getByText(/Header row 1, 2 data rows/)).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Column mapping' })).toBeVisible();
  await expect(page.getByLabel('Lease Code')).toBeVisible();

  await page.getByRole('button', { name: 'Validate' }).click();

  const findings = page.getByRole('table', { name: 'Import findings' });
  await expect(findings).toBeVisible();
  const failing = findings.getByRole('row').filter({ hasText: 'Error' });
  await expect(failing).toHaveCount(1);
  await expect(failing).toContainText(/expir|before|commence/i);

  await page.getByRole('button', { name: 'Import valid rows' }).click();
  await expect(page.getByRole('status', { name: 'Import result' })).toContainText(
    '1 lease written to the rent roll',
  );

  // The wizard's own report is not evidence that anything was stored. The rent
  // roll is.
  await page.getByRole('link', { name: 'Rent roll' }).click();
  const table = page.getByRole('table', { name: 'Leases on this model' });
  await expect(table.getByRole('row').filter({ hasText: 'E2E-IMPORT-GOOD' })).toBeVisible();
  await expect(table.getByRole('row').filter({ hasText: 'E2E-IMPORT-BAD' })).toHaveCount(0);
});

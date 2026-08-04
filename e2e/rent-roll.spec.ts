import { expect, test } from '@playwright/test';
import { SEED, sessionFile } from './roles.js';

test.use({ storageState: sessionFile('owner') });

/**
 * The lease editor.
 *
 * A lease is saved whole or not at all: its dates, area and rent have to agree
 * with one another before anything is written, because a half-saved lease
 * produces a cash flow nobody can defend. These tests hold the editor to that —
 * an impossible term is refused at the point of entry, and a coherent one
 * reaches the rent roll intact.
 */
test.beforeEach(async ({ page }) => {
  await page.goto('/properties');
  await page.getByRole('link', { name: SEED.office.property }).click();
  await page.getByRole('link', { name: SEED.office.model }).click();
  await page.getByRole('link', { name: 'Rent roll' }).click();
  await expect(page.getByRole('heading', { name: 'Leases' })).toBeVisible();
});

test('refuses a lease that expires before it commences', async ({ page }) => {
  await page.getByRole('button', { name: 'Add lease' }).click();
  await expect(page.getByRole('heading', { name: 'New lease' })).toBeVisible();

  await page.getByLabel('Lease reference').fill('E2E-INVALID-TERM');
  await page.getByLabel('New tenant name').fill('Ardent Survey Company');
  await page.getByLabel('Area', { exact: true }).fill('4200');
  await page.getByLabel('Commencement').fill('2027-01-01');
  await page.getByLabel('Expiration').fill('2026-06-30');

  const save = page.getByRole('button', { name: 'Save lease' });
  await expect(page.getByRole('alert')).toContainText('A lease cannot expire before it commences.');
  await expect(save).toBeDisabled();
  // The invalid field is marked for assistive technology too, not only visually.
  await expect(page.getByLabel('Expiration')).toHaveAttribute('aria-invalid', 'true');

  // Correcting the term clears the objection rather than requiring a reload.
  await page.getByLabel('Expiration').fill('2032-12-31');
  await expect(page.getByRole('alert')).toBeHidden();
  await expect(save).toBeEnabled();
});

test('writes a valid lease to the rent roll', async ({ page }) => {
  const code = 'E2E-NEW-LEASE';
  const table = page.getByRole('table', { name: 'Leases on this model' });
  const before = await table.getByRole('row').count();

  await page.getByRole('button', { name: 'Add lease' }).click();
  await page.getByLabel('Lease reference').fill(code);
  await page.getByLabel('New tenant name').fill('Ardent Survey Company');
  await page.getByLabel('Area', { exact: true }).fill('4200');
  await page.getByLabel('Commencement').fill('2027-01-01');
  await page.getByLabel('Expiration').fill('2032-12-31');
  await page.getByLabel(/^Base rent/).fill('38.50');
  await page.getByLabel('Rent basis').selectOption('per_area_per_year');
  await page.getByLabel('Expense recovery').selectOption('base_year');

  await page.getByRole('button', { name: 'Save lease' }).click();

  // The editor closes on success, which is the signal that the server accepted
  // the record rather than the browser merely having sent it.
  await expect(page.getByRole('heading', { name: 'New lease' })).toBeHidden();

  const row = table.getByRole('row').filter({ hasText: code });
  await expect(row).toBeVisible();
  await expect(row).toContainText('Ardent Survey Company');
  await expect(row).toContainText('4,200');
  await expect(table.getByRole('row')).toHaveCount(before + 1);
});

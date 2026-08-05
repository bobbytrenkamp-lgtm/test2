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

/**
 * Finding a lease in a rent roll.
 *
 * Three tenancies fit on a screen. A regional mall's three hundred do not, and
 * reading one top to bottom is how a lease gets missed.
 */
test('searches the rent roll and says what it is hiding', async ({ page }) => {
  const table = page.getByRole('table', { name: 'Leases on this model' });
  const total = (await table.getByRole('row').count()) - 1; // less the header

  await page.getByLabel('Search leases').fill('Kestrel');
  await expect(table.getByRole('row').filter({ hasText: 'Kestrel Analytics' })).toBeVisible();
  await expect(table.getByRole('row').filter({ hasText: 'Meridian Actuarial' })).toHaveCount(0);

  // The count must say it is a subset. A total that silently means "the
  // filtered rows" is how a rent roll gets reported short.
  await expect(page.getByText(`filtered from ${total}`)).toBeVisible();

  await page.getByLabel('Search leases').fill('Nobody by that name');
  await expect(page.getByRole('heading', { name: 'No lease matches that search' })).toBeVisible();

  await page.getByLabel('Search leases').fill('');
  await expect(page.getByText(/filtered from/)).toHaveCount(0);
});

test('sorts area as a number, not as text', async ({ page }) => {
  // The seeded office leases are 38,200 / 42,500 / 51,300 — all five digits, so
  // sorting them as text happens to give the right answer. This lease is 4,200:
  // as text it sorts *after* 38,200, so it is the case that tells a numeric
  // comparison apart from a lexicographic one.
  const code = 'E2E-SMALL-SUITE';
  await page.getByRole('button', { name: 'Add lease' }).click();
  await page.getByLabel('Lease reference').fill(code);
  await page.getByLabel('New tenant name').fill('Quill and Pike Notaries');
  await page.getByLabel('Area', { exact: true }).fill('4200');
  await page.getByLabel('Commencement').fill('2027-01-01');
  await page.getByLabel('Expiration').fill('2030-12-31');
  await page.getByLabel(/^Base rent/).fill('29.00');
  await page.getByLabel('Rent basis').selectOption('per_area_per_year');
  await page.getByRole('button', { name: 'Save lease' }).click();
  await expect(page.getByRole('heading', { name: 'New lease' })).toBeHidden();

  const table = page.getByRole('table', { name: 'Leases on this model' });
  await page.getByRole('button', { name: 'Area' }).click();

  const header = table.getByRole('columnheader').filter({ hasText: 'Area' });
  await expect(header).toHaveAttribute('aria-sort', 'ascending');

  // Smallest first. Lexicographically 4,200 would be last of the four.
  const first = table.getByRole('row').nth(1);
  await expect(first).toContainText('4,200');

  // And clicking the same column again reverses it, rather than re-sorting
  // ascending and appearing to do nothing.
  await page.getByRole('button', { name: 'Area' }).click();
  await expect(header).toHaveAttribute('aria-sort', 'descending');
  await expect(table.getByRole('row').nth(1)).toContainText('51,300');
});

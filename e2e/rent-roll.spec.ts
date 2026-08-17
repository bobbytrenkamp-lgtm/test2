import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import { SEED, sessionFile } from './roles.js';

test.use({ storageState: sessionFile('owner') });
const STANDARD = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'];

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
  await page.getByLabel(/^Area/).fill('4200');
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
  // A grid, not a table: the rent roll became an editable spreadsheet surface.
  const table = page.getByRole('grid', { name: 'Leases on this model' });
  const before = await table.getByRole('row').count();

  await page.getByRole('button', { name: 'Add lease' }).click();
  await page.getByLabel('Lease reference').fill(code);
  await page.getByLabel('New tenant name').fill('Ardent Survey Company');
  await page.getByLabel(/^Area/).fill('4200');
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
  // A grid, not a table: the rent roll became an editable spreadsheet surface.
  const table = page.getByRole('grid', { name: 'Leases on this model' });
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
  await page.getByLabel(/^Area/).fill('4200');
  await page.getByLabel('Commencement').fill('2027-01-01');
  await page.getByLabel('Expiration').fill('2030-12-31');
  await page.getByLabel(/^Base rent/).fill('29.00');
  await page.getByLabel('Rent basis').selectOption('per_area_per_year');
  await page.getByRole('button', { name: 'Save lease' }).click();
  await expect(page.getByRole('heading', { name: 'New lease' })).toBeHidden();

  /*
   * Sorting moved from the column headers to a toolbar control when the rent
   * roll became an editable grid: in a spreadsheet a click on a header selects
   * the column, so a sort button there would fight the selection. `aria-sort`
   * still lives on the header, which is what a screen reader reads, and it is
   * still asserted here.
   */
  const grid = page.getByRole('grid', { name: 'Leases on this model' });
  await page.getByLabel('Sort leases by').selectOption('area:asc');

  const header = grid.getByRole('columnheader').filter({ hasText: 'Area' });
  await expect(header).toHaveAttribute('aria-sort', 'ascending');

  // Smallest first. Lexicographically 4,200 would be last of the four.
  await expect(grid.getByRole('row').nth(1)).toContainText('4,200');

  // And reversing it reverses the rows, rather than appearing to do nothing.
  await page.getByLabel('Sort leases by').selectOption('area:desc');
  await expect(header).toHaveAttribute('aria-sort', 'descending');
  await expect(grid.getByRole('row').nth(1)).toContainText('51,300');
});

/**
 * Found by a repository-wide correctness audit: `LeaseEditor` had no `key`,
 * so switching straight from one lease's editor to another's — via the same
 * "Edit … in full" toolbar button, without cancelling first — kept the same
 * component instance mounted. `useState`'s initializer only ever runs once,
 * so the form kept showing the lease it opened on even though a different
 * row was now selected.
 */
test('switching the lease editor from one lease straight to another shows the new one, not the old one', async ({
  page,
}) => {
  // The toolbar button lives beside the grid, not inside it (`role="grid"`
  // holds only rows and gridcells), so the button is found through the
  // surrounding card rather than through the grid locator itself.
  const card = page.locator('.card', { has: page.getByRole('heading', { name: 'Leases' }) });
  const grid = page.getByRole('grid', { name: 'Leases on this model' });
  const rowMeridian = grid.getByRole('row').filter({ hasText: 'Meridian Actuarial' });
  const rowKestrel = grid.getByRole('row').filter({ hasText: 'Kestrel Analytics' });
  await expect(rowMeridian).toBeVisible();
  await expect(rowKestrel).toBeVisible();

  await rowMeridian.getByRole('gridcell').first().click();
  await card.getByRole('button', { name: /^Edit L-SUITE-1200 in full$/ }).click();
  await expect(page.getByLabel('Lease reference')).toHaveValue('L-SUITE-1200');

  // Switches straight to Kestrel's lease without cancelling Meridian's editor
  // first — the exact sequence the bug required.
  await rowKestrel.getByRole('gridcell').first().click();
  await card.getByRole('button', { name: /^Edit L-SUITE-1600 in full$/ }).click();

  // The bug's own failure mode: this would still read L-SUITE-1200, Kestrel's
  // row selected but Meridian's form values still on screen.
  await expect(page.getByLabel('Lease reference')).toHaveValue('L-SUITE-1600');
  const selectedTenant = page.getByLabel('Tenant').locator('option:checked');
  await expect(selectedTenant).toHaveText('Kestrel Analytics');

  // Read-only check: nothing here is saved.
  await page.getByRole('button', { name: 'Cancel' }).click();
});

/**
 * Lease options.
 *
 * The engine has simulated renewal, termination and contraction as
 * probability-weighted branches since the calculation engine's own
 * `lease-options.ts` was written, and `leases.options` has round-tripped
 * through the API the whole time — but nothing in this editor ever showed a
 * field for it, despite the toolbar's own "Edit … in full" button already
 * promising "options are records rather than single values, so they are
 * edited here". This closes that gap.
 */
test('adds a renewal option to a lease, and it survives a reload', async ({ page }) => {
  const code = 'E2E-LEASE-OPTION';
  await page.getByRole('button', { name: 'Add lease' }).click();
  await page.getByLabel('Lease reference').fill(code);
  await page.getByLabel('New tenant name').fill('Halden Cartage');
  await page.getByLabel(/^Area/).fill('3000');
  await page.getByLabel('Commencement').fill('2027-01-01');
  await page.getByLabel('Expiration').fill('2032-12-31');
  await page.getByLabel(/^Base rent/).fill('28.00');

  await page.getByRole('button', { name: 'Add an option' }).click();
  await page.getByLabel('Option 1 exercise date').fill('2031-06-30');
  await page.getByLabel('Option 1 probability').fill('0.65');
  await page.getByLabel('Option 1 term added').fill('36');

  await page.getByRole('button', { name: 'Save lease' }).click();
  await expect(page.getByRole('heading', { name: 'New lease' })).toBeHidden();

  // Reopen the same lease and confirm the option held — the editor's own
  // report of success is not evidence that anything was actually stored.
  const card = page.locator('.card', { has: page.getByRole('heading', { name: 'Leases' }) });
  const grid = page.getByRole('grid', { name: 'Leases on this model' });
  const row = grid.getByRole('row').filter({ hasText: code });
  const editButton = card.getByRole('button', { name: new RegExp(`^Edit ${code} in full$`) });
  // Saving triggers the grid's own reload in the background; a click that
  // lands on the row just before that reload resolves can have its focus
  // cleared by the fresh data arriving. Re-clicking until the button is
  // actually enabled rides out that race rather than assuming one click
  // landed after the reload settled.
  await expect(async () => {
    await row.getByRole('gridcell').first().click();
    await expect(editButton).toBeEnabled({ timeout: 2000 });
  }).toPass();
  await editButton.click();

  await expect(page.getByLabel('Option 1 type')).toHaveValue('renewal');
  await expect(page.getByLabel('Option 1 exercise date')).toHaveValue('2031-06-30');
  await expect(page.getByLabel('Option 1 probability')).toHaveValue('0.65');
  await expect(page.getByLabel('Option 1 term added')).toHaveValue('36');
});

test('removes an option before saving', async ({ page }) => {
  await page.getByRole('button', { name: 'Add lease' }).click();
  await page.getByRole('button', { name: 'Add an option' }).click();
  await expect(page.getByLabel('Option 1 type')).toBeVisible();

  await page.getByRole('button', { name: 'Remove option' }).click();
  await expect(page.getByLabel('Option 1 type')).toBeHidden();
});

test('is accessible with an option added', async ({ page }) => {
  await page.getByRole('button', { name: 'Add lease' }).click();
  await page.getByRole('button', { name: 'Add an option' }).click();
  // Exercises the renewal-specific fields too, not just the fields common to
  // every option type.
  await page.getByLabel('Option 1 renewal rent').selectOption('fixed');
  await expect(page.getByLabel('Option 1 fixed rent')).toBeVisible();

  const { violations } = await new AxeBuilder({ page }).withTags(STANDARD).analyze();
  const summary = violations.map(
    (violation) =>
      `${violation.id} (${violation.impact ?? 'unknown'}): ${violation.help}\n` +
      violation.nodes.map((node) => `      ${node.target.join(' ')}`).join('\n'),
  );
  expect(summary, summary.join('\n')).toEqual([]);
});

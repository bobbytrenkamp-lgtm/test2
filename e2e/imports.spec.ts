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

/**
 * Importing a workbook, and choosing which sheet.
 *
 * The API has returned the sheet list since spreadsheets were supported; this
 * covers the part that makes it useful — a workbook whose *first* sheet is a
 * cover page, which is the common shape, and an analyst who can see which sheet
 * was read and change it.
 *
 * The file is built here with exceljs and handed to the picker as real bytes,
 * so this exercises the browser's own base64 encoding rather than a fixture
 * that was already encoded.
 */
test('reads a workbook, and lets the analyst pick the sheet', async ({ page }) => {
  const ExcelJS = (await import('exceljs')).default;
  const book = new ExcelJS.Workbook();

  const cover = book.addWorksheet('Cover');
  cover.addRow(['Prepared for the investment committee']);

  const roll = book.addWorksheet('Schedule of tenancies');
  roll.addRow(['Suite', 'Tenant', 'Lease ID', 'Area', 'Lease Start', 'Lease End', 'Base Rent']);
  roll.addRow([
    '3100',
    'Pemberton Cartage',
    'E2E-XLSX-1',
    7400,
    new Date(Date.UTC(2027, 0, 1)),
    new Date(Date.UTC(2033, 11, 31)),
    36.5,
  ]);
  const bytes = Buffer.from((await book.xlsx.writeBuffer()) as ArrayBuffer);

  await page.goto('/properties');
  await page.getByRole('link', { name: SEED.office.property }).click();
  await page.getByRole('link', { name: SEED.office.model }).click();
  await page.getByRole('link', { name: 'Imports' }).click();
  await expect(page.getByRole('heading', { name: 'Import a rent roll' })).toBeVisible();

  await page.getByLabel('Or choose a file').setInputFiles({
    name: 'e2e-rent-roll.xlsx',
    mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    buffer: bytes,
  });

  // A spreadsheet has no text to show, so the wizard says what it will read
  // rather than presenting an empty box or a screen of mojibake.
  await expect(page.getByRole('status', { name: 'Selected file' })).toContainText(
    'read as a spreadsheet',
  );

  await page.getByRole('button', { name: 'Analyse the file' }).click();

  // The rent roll was chosen over the cover sheet, and the choice is visible.
  const worksheet = page.getByLabel('Worksheet');
  await expect(worksheet).toBeVisible({ timeout: 60_000 });
  await expect(worksheet).toHaveValue('1');
  await expect(page.getByText(/Header row 1, 1 data rows/)).toBeVisible();

  // Choosing the cover sheet re-analyses against it, so the choice is real
  // rather than a label on a decision already made.
  await worksheet.selectOption('0');
  await expect(page.getByText(/Header row 1, 1 data rows/)).toHaveCount(0, { timeout: 60_000 });

  // And back, then all the way through to the rent roll.
  await worksheet.selectOption('1');
  await expect(page.getByText(/Header row 1, 1 data rows/)).toBeVisible({ timeout: 60_000 });

  await page
    .getByRole('button', { name: /validate/i })
    .first()
    .click();
  await page
    .getByRole('button', { name: /import/i })
    .last()
    .click();

  await page.getByRole('link', { name: 'Rent roll' }).click();
  await page.getByLabel('Search leases').fill('Pemberton');
  const row = page.getByRole('row').filter({ hasText: 'Pemberton Cartage' });
  await expect(row).toBeVisible({ timeout: 60_000 });
  // The date that came out of Excel as a Date object, all the way to the grid.
  await expect(row).toContainText('2033');
});

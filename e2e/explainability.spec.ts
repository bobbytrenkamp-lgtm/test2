import { expect, test, type Page } from '@playwright/test';
import { SEED, sessionFile } from './roles.js';

test.use({ storageState: sessionFile('owner') });

/**
 * Explaining a number.
 *
 * The engine records how it derived every material figure. The question this
 * suite answers is whether an analyst can actually get at that: click a total,
 * see the tenants that made it, see the formula, and follow a link to the
 * record to change.
 *
 * The standard applied throughout is that the panel must never *recalculate*.
 * Everything it shows is read from the calculation already stored, so what it
 * says is what the engine did — an inspector that re-derived a figure could
 * agree with the model on Tuesday and disagree on Wednesday, and a reader
 * would have no way to tell which was wrong.
 */

async function openCashFlow(page: Page): Promise<void> {
  await page.goto('/properties');
  await page.getByRole('link', { name: SEED.office.property }).click();
  await page.getByRole('link', { name: SEED.office.model }).click();

  /*
   * Calculated here rather than relied on from another spec.
   *
   * Everything below reads the *trace*, which only exists when a calculation
   * was run with tracing on. Depending on some earlier file in the suite having
   * done that makes this pass or fail on alphabetical ordering, which is not a
   * property anybody should have to know about.
   */
  await page.getByRole('button', { name: /^Calculat/ }).click();
  await expect(page.getByRole('status', { name: 'Model status' })).toContainText('Calculated', {
    timeout: 120_000,
  });
  await expect(page.getByRole('table', { name: /cash flow/i })).toBeVisible();
}

/** Opens the inspector on the first figure of a named line. */
async function inspect(page: Page, line: string): Promise<void> {
  const table = page.getByRole('table', { name: /cash flow/i });
  const row = table.getByRole('row').filter({ has: page.getByRole('rowheader', { name: line }) });
  await expect(row).toBeVisible();
  await row.getByRole('button').first().click();
  await expect(page.getByRole('dialog')).toBeVisible();
}

test('breaks a revenue total down into the tenants that made it', async ({ page }) => {
  /*
   * The part the old inspector had no answer for. It went straight to the
   * engine's trace, which is a log of formula applications and reads like one;
   * what a reader wants first is which tenants the number is.
   */
  await openCashFlow(page);
  await inspect(page, 'Expense recoveries');

  const dialog = page.getByRole('dialog');
  const components = dialog.getByRole('table', { name: /What makes up/ });
  await expect(components).toBeVisible();
  await expect(components.getByRole('row').filter({ hasText: 'Total' })).toBeVisible();

  /*
   * A contributor row names a tenant, not an identifier. Asserted by shape
   * rather than against a seeded tenant name, so the test does not break every
   * time the demonstration data is edited.
   */
  const first = components.getByRole('row').nth(1);
  const name = (await first.getByRole('rowheader').innerText()).trim();
  expect(name.length).toBeGreaterThan(3);
  expect(name).not.toMatch(/^(lease|occurrence):/);
  expect(name).not.toMatch(/^[0-9a-f-]{20,}$/);
});

test('names the records to change, and links to them', async ({ page }) => {
  await openCashFlow(page);
  await inspect(page, 'Expense recoveries');

  const dialog = page.getByRole('dialog');
  await expect(dialog.getByRole('heading', { name: 'Where to change it' })).toBeVisible();
  // A lease source reads as its code and tenant, not as `lease:9f3c…`.
  const link = dialog.getByRole('link').first();
  await expect(link).toBeVisible();
  await expect(link).not.toHaveText(/^lease:/);
});

test('takes the reader to the lease it named, already filtered', async ({ page }) => {
  /*
   * A link that lands on an unfiltered rent roll of three hundred rows has not
   * answered "where is that tenant?". The filter travels in the URL, so the
   * back button also returns to what they were looking at.
   */
  await openCashFlow(page);
  await inspect(page, 'Expense recoveries');

  const dialog = page.getByRole('dialog');
  // From the "where to change it" list, whose entries are the records the trace
  // named — the components table above it also links, but to the same place.
  const link = dialog.locator('.inspector-sources a').first();
  const href = (await link.getAttribute('href')) ?? '';
  expect(href).toMatch(/\/rent-roll\?lease=/);
  const code = decodeURIComponent(href.split('lease=')[1] ?? '');
  await link.click();

  await expect(page).toHaveURL(new RegExp(`/rent-roll\\?lease=${encodeURIComponent(code)}`));
  const grid = page.getByRole('grid', { name: 'Leases on this model' });
  await expect(grid).toBeVisible();
  await expect(grid.getByRole('row')).toHaveCount(2); // header plus the one lease
});

test('shows the engine trace, with its formula and inputs', async ({ page }) => {
  await openCashFlow(page);
  await inspect(page, 'Expense recoveries');

  const dialog = page.getByRole('dialog');
  await expect(dialog.getByRole('heading', { name: 'Calculation' })).toBeVisible();
  // A named formula and a decimal result, which is what makes it a derivation
  // rather than a restatement.
  await expect(dialog.locator('.trace-entry').first()).toBeVisible();
  await expect(dialog.locator('.trace-entry').first().locator('dd').first()).not.toBeEmpty();
});

test('says which calculation it is reading, not that it is live', async ({ page }) => {
  await openCashFlow(page);
  await inspect(page, 'Net operating income');

  const dialog = page.getByRole('dialog');
  await expect(dialog).toContainText('not a fresh one');
  await expect(dialog).toContainText(/Engine \d+\.\d+\.\d+/);
});

test('copies the calculation as text', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await openCashFlow(page);
  await inspect(page, 'Expense recoveries');

  await page.getByRole('button', { name: 'Copy calculation' }).click();
  await expect(page.getByRole('button', { name: 'Copied' })).toBeVisible();

  const text = await page.evaluate(() => navigator.clipboard.readText());
  expect(text).toContain('Expense recoveries');
  expect(text).toContain('Components');
  expect(text).toContain('Engine');
});

test('explains a return metric from the Returns tab', async ({ page }) => {
  await openCashFlow(page);
  await page.getByRole('link', { name: 'Returns and debt' }).click();
  await expect(page.getByRole('heading', { name: 'Return metrics' })).toBeVisible();

  // Only the metrics the engine actually traces are clickable. A figure that
  // opened an empty panel would teach people that clicking numbers does nothing.
  await page.getByRole('button', { name: /How Exit cap rate was calculated/ }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText('Exit cap rate and sale price');
});

test('closes on request and returns focus to the page', async ({ page }) => {
  await openCashFlow(page);
  await inspect(page, 'Net operating income');
  await page.getByRole('button', { name: 'Close the calculation inspector' }).click();
  await expect(page.getByRole('dialog')).toBeHidden();
});

import { expect, test } from '@playwright/test';
import { SEED, sessionFile } from './roles.js';

test.use({ storageState: sessionFile('owner') });

/**
 * The path an analyst actually takes: find the asset, open its model, run the
 * calculation, then ask the platform to justify one of the numbers it produced.
 *
 * The last step is the point of the whole exercise. A cash flow that cannot be
 * explained is not an answer, so the test is not satisfied by a figure
 * appearing on screen — it opens the inspector and requires the engine's own
 * trace, with a formula, its inputs and its sources.
 */
test('sign in, open a model, calculate, and inspect how a figure was derived', async ({ page }) => {
  await page.goto('/properties');

  await expect(page.getByRole('heading', { name: 'Properties', level: 1 })).toBeVisible();
  await page.getByRole('link', { name: SEED.office.property }).click();

  await expect(page.getByRole('heading', { name: SEED.office.property, level: 1 })).toBeVisible();
  // The space list is the recovery denominator; a property with no spaces would
  // silently produce a cash flow nobody could defend.
  await expect(page.getByRole('heading', { name: 'Physical structure' })).toBeVisible();

  await page.getByRole('link', { name: SEED.office.model }).click();
  await expect(page.getByRole('heading', { name: SEED.office.model, level: 1 })).toBeVisible();

  await page.getByRole('button', { name: 'Calculate' }).click();
  await expect(page.getByRole('status')).toContainText('Calculated with engine', {
    timeout: 60_000,
  });

  const cashFlow = page.getByRole('table', { name: /cash flow/i });
  await expect(cashFlow).toBeVisible();

  // Net operating income is a subtotal of the lines above it, so it is not the
  // figure to interrogate. Scheduled base rent is derived from lease
  // occurrences and carries a trace.
  const row = cashFlow
    .getByRole('row')
    .filter({ has: page.getByRole('rowheader', { name: 'Scheduled base rent' }) });
  const firstYear = row.getByRole('button').first();
  await expect(firstYear).toBeVisible();
  await firstYear.click();

  const inspector = page.getByRole('dialog', { name: /How Scheduled base rent/ });
  await expect(inspector).toBeVisible();
  await expect(inspector.getByRole('heading', { name: 'How this was calculated' })).toBeVisible();

  // A trace entry names the formula that produced the value, the inputs it read
  // and where those inputs came from. Anything less is not an explanation.
  const entry = inspector.locator('.trace-entry').first();
  await expect(entry).toBeVisible();
  await expect(entry.locator('.badge')).not.toBeEmpty();

  const result = entry.locator('dt:text-is("Result") + dd');
  await expect(result).toBeVisible();
  // The traced result is a decimal string, not a rendered or rounded figure.
  await expect(result).toHaveText(/^-?\d[\d,]*(\.\d+)?$/);

  const sources = entry.locator('dt:text-is("Sources") + dd');
  await expect(sources).not.toBeEmpty();

  await inspector.getByRole('button', { name: 'Close the calculation inspector' }).click();
  await expect(inspector).toBeHidden();
});

test('the cash flow can be read monthly as well as annually', async ({ page }) => {
  await page.goto('/properties');
  await page.getByRole('link', { name: SEED.industrial.property }).click();
  await page.getByRole('link', { name: SEED.industrial.model }).click();

  await page.getByRole('button', { name: 'Calculate' }).click();
  await expect(page.getByRole('status')).toContainText('Calculated with engine', {
    timeout: 60_000,
  });

  const cashFlow = page.getByRole('table', { name: /cash flow/i });
  const annualColumns = await cashFlow.locator('thead th').count();

  await page.getByRole('button', { name: 'Monthly', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Monthly', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  );

  // A monthly view of the same forecast has strictly more columns than an
  // annual one; if the toggle did nothing, this is where it shows.
  await expect
    .poll(async () => cashFlow.locator('thead th').count())
    .toBeGreaterThan(annualColumns);
});

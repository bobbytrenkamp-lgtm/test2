import { expect, test, type Page } from '@playwright/test';
import { SEED, sessionFile } from './roles.js';

/**
 * Sensitivity grids and model cloning.
 *
 * The screen was reachable and believed working, and believed is not the same
 * as verified: `docs/feature-status.md` listed it as Functional precisely
 * because nothing drove it.
 *
 * What makes these worth writing rather than a smoke test is that a sensitivity
 * grid can be held to an economic truth. A higher exit capitalisation rate buys
 * the same income for less money, so the value must fall as the rate rises —
 * every time, on any asset. A grid that is transposed, or that quietly reuses
 * one cell's result, renders perfectly and fails that. Checking the direction
 * catches the wiring; checking that a screen appeared catches nothing.
 */

async function openScenarios(page: Page): Promise<void> {
  await page.goto('/properties');
  await page.getByRole('link', { name: SEED.office.property }).click();
  await page.getByRole('link', { name: SEED.office.model }).click();
  await page.getByRole('link', { name: 'Scenarios' }).click();
  await expect(page.getByRole('heading', { name: 'Sensitivity analysis' })).toBeVisible();
}

/** Reads a currency cell back as a number, so it can be compared as one. */
function toNumber(text: string): number {
  const cleaned = text.replace(/[^0-9.-]/g, '');
  return Number(cleaned);
}

test.describe('as an analyst', () => {
  test.use({ storageState: sessionFile('analyst') });

  test('values fall as the exit capitalisation rate rises', async ({ page }) => {
    await openScenarios(page);

    // One-way, so the row order is the only thing under test.
    await page.getByLabel('Second dimension').selectOption('one');
    await page.getByLabel('Row variable').selectOption('terminalCapRate');
    await page.getByLabel('Row values').fill('0.05, 0.06, 0.07, 0.08');
    await page.getByLabel('Metric').selectOption('dcfValue');
    await page.getByRole('button', { name: 'Run sensitivity' }).click();

    const table = page.getByRole('table');
    await expect(table.getByRole('row')).toHaveCount(5, { timeout: 120_000 });

    const values: number[] = [];
    for (const rate of ['0.05', '0.06', '0.07', '0.08']) {
      const row = table.getByRole('row').filter({ hasText: rate });
      const cell = row.getByRole('cell').last();
      values.push(toNumber((await cell.innerText()).trim()));
    }

    // Every figure is a real number, not an empty cell dressed up as one.
    for (const value of values) {
      expect(Number.isFinite(value)).toBe(true);
      expect(value).toBeGreaterThan(0);
    }

    // The invariant: strictly decreasing. A cap rate is a divisor on the exit
    // value, so this holds for any asset with a positive terminal income.
    for (let i = 1; i < values.length; i += 1) {
      expect(values[i]).toBeLessThan(values[i - 1] as number);
    }
  });

  test('a two-way table is the shape of both its inputs', async ({ page }) => {
    await openScenarios(page);

    await page.getByLabel('Second dimension').selectOption('two');
    await page.getByLabel('Row variable').selectOption('terminalCapRate');
    await page.getByLabel('Row values').fill('0.06, 0.07, 0.08');
    await page.getByLabel('Column variable').selectOption('discountRate');
    await page.getByLabel('Column values').fill('0.08, 0.09');
    await page.getByLabel('Metric').selectOption('dcfValue');
    await page.getByRole('button', { name: 'Run sensitivity' }).click();

    const table = page.getByRole('table');
    // Three row values plus the header.
    await expect(table.getByRole('row')).toHaveCount(4, { timeout: 120_000 });

    // Two column values plus the row-label column. A grid that dropped a
    // dimension would still render, and would be wrong.
    await expect(table.getByRole('columnheader')).toHaveCount(3);

    // Discounting harder lowers the value too, so the second column is below
    // the first on every row — the column direction, which the one-way test
    // cannot see.
    for (const rate of ['0.06', '0.07', '0.08']) {
      const cells = table.getByRole('row').filter({ hasText: rate }).getByRole('cell');
      const atEight = toNumber((await cells.nth(0).innerText()).trim());
      const atNine = toNumber((await cells.nth(1).innerText()).trim());
      expect(atNine).toBeLessThan(atEight);
    }
  });

  test('a clone is a separate draft, not a second window on the same model', async ({ page }) => {
    await openScenarios(page);

    const name = `Upside case ${Date.now()}`;
    await page.getByLabel('New model name').fill(name);
    await page.getByRole('button', { name: 'Clone', exact: true }).click();

    // Cloning navigates to the copy, which is the point: an analyst is now
    // working on the new case rather than still editing the original.
    await expect(page.getByRole('heading', { name, level: 1 })).toBeVisible({ timeout: 60_000 });

    // A clone starts as a draft however the original was approved, or the
    // approval would have been inherited without anyone reviewing the copy.
    await expect(page.getByText(/draft/i).first()).toBeVisible();
  });
});

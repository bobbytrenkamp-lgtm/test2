import { expect, test, type Page } from '@playwright/test';
import { SEED, sessionFile } from './roles.js';

test.use({ storageState: sessionFile('owner') });

/**
 * Spreadsheet editing on the assumption collections.
 *
 * Six collections became grids at once, all through the same primitive and the
 * same batched endpoint. What is worth checking in the browser is not the
 * primitive again — the rent-roll suite covers that — but the two things that
 * are specific here:
 *
 * 1. **The edit reaches the engine.** An operating expense typed into a cell
 *    has to move NOI, or the grid is wired to a local array.
 * 2. **The collections that should not be grids are not.** Growth curves carry
 *    a per-year rate list, which is not a value, and quietly offering a
 *    "default rate" cell would invite an analyst to edit the fallback while the
 *    years that actually apply sit out of sight.
 */

async function openAssumptions(page: Page): Promise<void> {
  await page.goto('/properties');
  await page.getByRole('link', { name: SEED.office.property }).click();
  await page.getByRole('link', { name: SEED.office.model }).click();
  await page.getByRole('link', { name: 'Assumptions' }).click();
  await expect(page.getByRole('grid', { name: 'Operating expenses' })).toBeVisible();
}

/** Walks the caret to a named column of the first row of a named grid. */
async function focusCell(page: Page, gridName: string, column: string): Promise<void> {
  const grid = page.getByRole('grid', { name: gridName });
  await grid.focus();
  const headers = await grid.getByRole('columnheader').allInnerTexts();
  const index = headers.findIndex((text) => text.trim().startsWith(column));
  expect(
    index,
    `no column starting with "${column}" — headers: ${headers.join(' | ')}`,
  ).toBeGreaterThanOrEqual(0);

  await page.keyboard.press('Control+ArrowUp');
  await page.keyboard.press('Control+ArrowLeft');
  for (let i = 0; i < index; i += 1) await page.keyboard.press('ArrowRight');
}

test.beforeEach(async ({ page }) => {
  await openAssumptions(page);
});

test('every collection that can be a grid is one', async ({ page }) => {
  for (const name of [
    'Operating expenses',
    'Other property revenue',
    'Capital',
    'Debt facilities',
    'Market leasing assumptions',
  ]) {
    await expect(page.getByRole('grid', { name })).toBeVisible();
  }
});

test('growth curves stay a reading surface, because a rate list is not a cell', async ({
  page,
}) => {
  /*
   * Pinned deliberately. A growth curve's meaning is its per-year rates; a
   * single editable "default rate" column would look like the whole story and
   * be a footnote.
   */
  await expect(page.getByRole('grid', { name: 'Growth curves' })).toHaveCount(0);
  await expect(page.getByRole('table', { name: 'Growth curves' })).toBeVisible();
});

test('an expense typed into a cell moves net operating income', async ({ page }) => {
  /*
   * The claim that matters. Everything else about the grid could be right and
   * this still be a local array.
   *
   * The seed is shared across every spec in this suite, and specs that follow
   * assert on the *direction* a value moves — so a permanent change here can
   * invert one of them by pushing the model's value negative. The original
   * amount is therefore read first and put back at the end, which leaves the
   * seed exactly as it was found.
   */
  const grid = page.getByRole('grid', { name: 'Operating expenses' });
  await focusCell(page, 'Operating expenses', 'Amount');
  // Read from the cell the caret is actually on rather than a guessed index,
  // which would silently read the wrong column if one were reordered.
  const original = (await grid.locator('td.is-active').innerText()).replace(/[^0-9.]/g, '');
  expect(Number(original), 'the seeded expense has no amount to restore').toBeGreaterThan(0);

  await page.getByRole('link', { name: 'Cash flow' }).click();
  const noi = page.getByRole('row').filter({ hasText: 'Net operating income' }).first();
  await expect(noi).toBeVisible();
  const before = await noi.innerText();

  await page.getByRole('link', { name: 'Assumptions' }).click();
  await expect(grid).toBeVisible();

  // A modest, plausible change: enough to move NOI, not enough to make the
  // property worthless and flip a later spec's direction on its own.
  await focusCell(page, 'Operating expenses', 'Amount');
  await page.keyboard.type(String(Number(original) + 25_000));
  await page.keyboard.press('Enter');

  const changeBar = page.getByLabel('Unsaved changes in Operating expenses');
  await expect(changeBar).toContainText('1 unsaved change');
  await changeBar.getByRole('button', { name: /^Save 1 change/ }).click();
  await expect(changeBar).toBeHidden({ timeout: 15_000 });

  await page.getByRole('button', { name: /^Calculat/ }).click();
  await expect(page.getByLabel('Model status')).toContainText('Calculated', { timeout: 120_000 });

  await page.getByRole('link', { name: 'Cash flow' }).click();
  const after = page.getByRole('row').filter({ hasText: 'Net operating income' }).first();
  await expect(after).toBeVisible();
  const moved = (await after.innerText()) !== before;

  // Restore before asserting, so a failure does not leave the seed altered for
  // every spec that runs after this one.
  await page.getByRole('link', { name: 'Assumptions' }).click();
  await expect(grid).toBeVisible();
  await focusCell(page, 'Operating expenses', 'Amount');
  await page.keyboard.type(original);
  await page.keyboard.press('Enter');
  await changeBar.getByRole('button', { name: /^Save 1 change/ }).click();
  await expect(changeBar).toBeHidden({ timeout: 15_000 });
  await page.getByRole('button', { name: /^Calculat/ }).click();
  await expect(page.getByLabel('Model status')).toContainText('Calculated', { timeout: 120_000 });

  expect(moved, 'NOI did not move when an operating expense changed').toBe(true);
});

test('a percentage cell accepts the three ways an analyst types one', async ({ page }) => {
  // 7%, 7 and 0.07 all mean seven percent. The grid stores the fraction.
  await focusCell(page, 'Operating expenses', 'Recoverable');
  await page.keyboard.type('45%');
  await page.keyboard.press('Enter');

  const changeBar = page.getByLabel('Unsaved changes in Operating expenses');
  await expect(changeBar).toContainText('1 unsaved change');

  const grid = page.getByRole('grid', { name: 'Operating expenses' });
  await expect(grid.locator('td.is-edited').first()).toContainText('45.00%');
});

test('refuses a value it cannot read, per collection', async ({ page }) => {
  await focusCell(page, 'Debt facilities', 'Commitment');
  await page.keyboard.type('about nine million');
  await page.keyboard.press('Enter');

  await expect(page.getByRole('alert').filter({ hasText: 'could not be read' })).toBeVisible();
  await expect(page.getByLabel('Unsaved changes in Debt facilities')).toBeHidden();
});

test('a dropdown column offers only what the engine accepts', async ({ page }) => {
  /*
   * A method is one of a fixed set, and typing a near-miss into it would be
   * refused with no way to discover the right spelling. The cell editor is a
   * real select, so the choices are the discovery mechanism.
   */
  await focusCell(page, 'Operating expenses', 'Method');
  await page.keyboard.press('Enter');

  const editor = page.getByRole('combobox', { name: 'Method' });
  await expect(editor).toBeVisible();
  const options = await editor.locator('option').allInnerTexts();
  // `titleCase` capitalises the first letter only, so these read as sentences.
  expect(options).toContain('Fixed annual');
  expect(options).toContain('Percent of effective gross revenue');
});

test('each grid keeps its own column preferences', async ({ page }) => {
  // Two grids on one screen must not share a stored layout, or hiding a column
  // on the expenses grid would hide one on debt.
  const expenses = page.getByRole('grid', { name: 'Operating expenses' });
  const debt = page.getByRole('grid', { name: 'Debt facilities' });

  await page
    .locator('.card', { hasText: 'Operating expenses' })
    .getByRole('button', { name: /^Columns / })
    .click();
  await page
    .getByRole('group', { name: 'Choose and order columns' })
    .getByRole('checkbox', { name: 'Growth curve' })
    .uncheck();
  await page.keyboard.press('Escape');

  await expect(expenses.getByRole('columnheader', { name: 'Growth curve' })).toBeHidden();
  await expect(debt.getByRole('columnheader', { name: 'Commitment' })).toBeVisible();

  // Put it back so the preference does not leak into the other specs.
  await page
    .locator('.card', { hasText: 'Operating expenses' })
    .getByRole('button', { name: /^Columns / })
    .click();
  await page.getByRole('button', { name: 'Show every column' }).click();
  await page.keyboard.press('Escape');
});

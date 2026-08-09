import { expect, test, type Page } from '@playwright/test';
import { SEED, sessionFile } from './roles.js';

test.use({ storageState: sessionFile('owner') });

/**
 * Spreadsheet editing on the rent roll.
 *
 * The unit tests cover selection, clipboard and the edit layer as pure data.
 * What they cannot show is the thing that actually matters to an analyst: that
 * a keystroke in a cell reaches the calculation engine and moves the model.
 * That is what these check, end to end and through the real server.
 *
 * Every gesture here is exercised from the keyboard. A grid that can only be
 * driven with a mouse fails the people who use it fastest and the people who
 * cannot use a mouse at all, and those turn out to be the same requirement.
 */

const GRID = 'Leases on this model';

async function openRentRoll(page: Page): Promise<void> {
  await page.goto('/properties');
  await page.getByRole('link', { name: SEED.office.property }).click();
  await page.getByRole('link', { name: SEED.office.model }).click();
  await page.getByRole('link', { name: 'Rent roll' }).click();
  await expect(page.getByRole('heading', { name: 'Leases' })).toBeVisible();
  await expect(page.getByRole('grid', { name: GRID })).toBeVisible();
}

/** Focuses the grid and walks the caret to a named column on the first row. */
async function focusCell(page: Page, column: string, row = 0): Promise<void> {
  const grid = page.getByRole('grid', { name: GRID });
  await grid.focus();
  // Home the caret, then step across to the wanted column by its header order.
  const headers = await grid.getByRole('columnheader').allInnerTexts();
  const index = headers.findIndex((text) => text.trim().startsWith(column));
  expect(
    index,
    `no column starting with "${column}" — headers: ${headers.join(' | ')}`,
  ).toBeGreaterThanOrEqual(0);

  await page.keyboard.press('Control+ArrowUp');
  await page.keyboard.press('Control+ArrowLeft');
  for (let i = 0; i < index; i += 1) await page.keyboard.press('ArrowRight');
  for (let i = 0; i < row; i += 1) await page.keyboard.press('ArrowDown');
}

test.beforeEach(async ({ page }) => {
  await openRentRoll(page);
});

test('types a rent into a cell and holds it before writing', async ({ page }) => {
  /*
   * The core loop: select, type, Enter. The edit is *held* rather than written,
   * which is what lets a lease stay validated as a whole record — and the page
   * has to say so, or an analyst cannot tell whether their work is safe.
   */
  await focusCell(page, 'Base rent');
  await page.keyboard.type('44.25');
  await page.keyboard.press('Enter');

  await expect(page.getByLabel('Unsaved changes')).toContainText('1 unsaved change');
  await expect(page.getByRole('button', { name: /Save 1 change/ })).toBeEnabled();
});

test('undoes and redoes an edit from the keyboard', async ({ page }) => {
  await focusCell(page, 'Base rent');
  await page.keyboard.type('51');
  await page.keyboard.press('Enter');
  await expect(page.getByLabel('Unsaved changes')).toContainText('1 unsaved change');

  // Undo has to take the value back to *no pending edit*, not to an empty
  // string — the change bar disappearing is what says it did.
  await page.keyboard.press('Control+z');
  await expect(page.getByLabel('Unsaved changes')).toBeHidden();

  await page.keyboard.press('Control+Shift+z');
  await expect(page.getByLabel('Unsaved changes')).toContainText('1 unsaved change');
});

test('fills one value down a selection with a single keystroke', async ({ page }) => {
  /*
   * The gesture the whole feature exists for: set a rent on the first lease,
   * extend the selection down, and fill. Three leases, one action, one entry on
   * the undo stack.
   */
  await focusCell(page, 'Base rent');
  await page.keyboard.type('39.00');
  await page.keyboard.press('Enter');

  await focusCell(page, 'Base rent');
  await page.keyboard.press('Shift+ArrowDown');
  await page.keyboard.press('Shift+ArrowDown');
  await page.keyboard.press('Control+d');

  await expect(page.getByLabel('Unsaved changes')).toContainText('3 unsaved changes');

  // And it undoes as one action, because it was one action.
  await page.keyboard.press('Control+z');
  await expect(page.getByLabel('Unsaved changes')).toContainText('1 unsaved change');
});

test('refuses a value it cannot read instead of writing a zero', async ({ page }) => {
  /*
   * A rent roll where "tbd" quietly became 0 would understate revenue with no
   * evidence anywhere in the model. The refusal has to be visible and the cell
   * has to keep its old value.
   */
  await focusCell(page, 'Base rent');
  await page.keyboard.type('tbd');
  await page.keyboard.press('Enter');

  await expect(page.getByRole('alert')).toContainText('could not be read');
  await expect(page.getByRole('alert')).toContainText('is not a number');
  await expect(page.getByLabel('Unsaved changes')).toBeHidden();
});

test('saves a grid edit and the calculation moves with it', async ({ page }) => {
  /*
   * The end-to-end claim, and the only one that proves the grid is wired to the
   * engine rather than to a local array: change a rent, save, recalculate, and
   * watch the model's own NOI change.
   */
  await page.getByRole('link', { name: 'Cash flow' }).click();
  const noiRow = page.getByRole('row').filter({ hasText: 'Net operating income' }).first();
  await expect(noiRow).toBeVisible();
  const before = await noiRow.innerText();

  await page.getByRole('link', { name: 'Rent roll' }).click();
  await expect(page.getByRole('grid', { name: GRID })).toBeVisible();

  await focusCell(page, 'Base rent');
  await page.keyboard.type('95.00');
  await page.keyboard.press('Enter');

  await page.getByRole('button', { name: /^Save \d+ change/ }).click();
  // The change bar going away is the server having accepted the batch.
  await expect(page.getByLabel('Unsaved changes')).toBeHidden({ timeout: 15_000 });

  await page.getByRole('button', { name: /^Calculat/ }).click();
  await expect(page.getByLabel('Model status')).toContainText('Calculated', { timeout: 120_000 });

  await page.getByRole('link', { name: 'Cash flow' }).click();
  const after = page.getByRole('row').filter({ hasText: 'Net operating income' }).first();
  await expect(after).toBeVisible();
  await expect(after).not.toHaveText(before);
});

test('discards every pending change on request', async ({ page }) => {
  await focusCell(page, 'Base rent');
  await page.keyboard.type('61');
  await page.keyboard.press('Enter');
  await expect(page.getByLabel('Unsaved changes')).toContainText('1 unsaved change');

  await page.getByRole('button', { name: 'Discard all' }).click();
  await expect(page.getByLabel('Unsaved changes')).toBeHidden();
});

test('hides a column and remembers the choice', async ({ page }) => {
  const grid = page.getByRole('grid', { name: GRID });
  await expect(grid.getByRole('columnheader', { name: /^Basis/ })).toBeVisible();

  await page.getByRole('button', { name: /^Columns / }).click();
  // By role, not by label: the row also carries "Move Basis earlier/later"
  // buttons, so a label lookup matches three elements.
  await page
    .getByRole('group', { name: 'Choose and order columns' })
    .getByRole('checkbox', { name: 'Basis' })
    .uncheck();
  await page.keyboard.press('Escape');
  await expect(grid.getByRole('columnheader', { name: /^Basis/ })).toBeHidden();

  // A view preference an analyst set is not something to make them set again.
  await page.reload();
  await expect(page.getByRole('grid', { name: GRID })).toBeVisible();
  await expect(
    page.getByRole('grid', { name: GRID }).getByRole('columnheader', { name: /^Basis/ }),
  ).toBeHidden();

  // Put it back, so the preference does not leak into the other specs.
  await page.getByRole('button', { name: /^Columns / }).click();
  await page.getByRole('button', { name: 'Show every column' }).click();
  await page.keyboard.press('Escape');
  await expect(
    page.getByRole('grid', { name: GRID }).getByRole('columnheader', { name: /^Basis/ }),
  ).toBeVisible();
});

test('keeps the identifying columns in view while scrolling sideways', async ({ page }) => {
  // A rent roll read sideways with no tenant name against the row is how a
  // value gets typed into the wrong lease.
  const grid = page.getByRole('grid', { name: GRID });
  const tenant = grid.getByRole('columnheader', { name: 'Tenant' });
  await expect(tenant).toHaveCSS('position', 'sticky');
  await expect(grid.getByRole('columnheader', { name: 'Lease' })).toHaveCSS('position', 'sticky');
});

test('is operable and announced as a grid', async ({ page }) => {
  const grid = page.getByRole('grid', { name: GRID });
  // One tab stop, arrows inside: the pattern assistive technology expects of a
  // spreadsheet, and the reason the container rather than each cell is focusable.
  await expect(grid).toHaveAttribute('tabindex', '0');
  await expect(grid).toHaveAttribute('aria-multiselectable', 'true');

  await grid.focus();
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('ArrowRight');
  // Selection state is on the cells, so a screen reader can report the range
  // rather than re-reading the table.
  await expect(grid.locator('td[aria-selected="true"]').first()).toBeVisible();
});

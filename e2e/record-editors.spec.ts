import { expect, test, type Page } from '@playwright/test';
import { SEED, sessionFile } from './roles.js';

test.use({ storageState: sessionFile('owner') });

/**
 * The structured record editors.
 *
 * These replaced a JSON textarea. The unit tests hold the specs — which fields
 * apply to which method, what each accepts, what the summary says. What the
 * browser adds is the part a spec cannot state: that the form is reachable,
 * that changing a method actually changes what is on screen, that a save lands,
 * and that the raw record is still there for anything the form does not show.
 */

async function openAssumptions(page: Page): Promise<void> {
  await page.goto('/properties');
  await page.getByRole('link', { name: SEED.office.property }).click();
  await page.getByRole('link', { name: SEED.office.model }).click();
  await page.getByRole('link', { name: 'Assumptions' }).click();
  await expect(page.getByRole('grid', { name: 'Operating expenses' })).toBeVisible();
}

/**
 * Opens the record editor for the first row of a collection's grid.
 *
 * The card is found by its *heading*, not by its text: `hasText: 'Capital'`
 * also matches the operating-expenses card, because that grid has a
 * "Capitalised" column.
 */
function cardFor(page: Page, title: string) {
  return page
    .locator('.card')
    .filter({ has: page.getByRole('heading', { name: title, exact: true }) });
}

async function openEditor(page: Page, gridName: string): Promise<void> {
  const card = cardFor(page, gridName);
  await page.getByRole('grid', { name: gridName }).focus();
  await page.keyboard.press('Control+ArrowUp');
  await card.getByRole('button', { name: /in full$/ }).click();
}

test.beforeEach(async ({ page }) => {
  await openAssumptions(page);
});

test('opens a form rather than JSON for an operating expense', async ({ page }) => {
  await openEditor(page, 'Operating expenses');

  // Sections, not a blob. Each is a fieldset so a screen reader can say which
  // part of the record a field belongs to.
  await expect(page.getByRole('group', { name: 'What it is' })).toBeVisible();
  await expect(page.getByRole('group', { name: 'How much' })).toBeVisible();
  await expect(page.getByRole('group', { name: 'Recovery and behaviour' })).toBeVisible();
  await expect(page.getByLabel('Method')).toBeVisible();
});

test('shows the monthly schedule only to the method that reads one', async ({ page }) => {
  /*
   * The whole reason the JSON view was worth replacing. A fixed annual expense
   * displaying a twelve-month schedule invites somebody to fill it in and then
   * wonder why nothing moved.
   */
  await openEditor(page, 'Operating expenses');

  await page.getByLabel('Method').selectOption('fixed_annual');
  await expect(page.getByLabel('Monthly amounts')).toBeHidden();
  await expect(page.getByLabel(/^Amount/)).toBeVisible();

  await page.getByLabel('Method').selectOption('custom_monthly_schedule');
  await expect(page.getByLabel('Monthly amounts')).toBeVisible();
  await expect(page.getByLabel(/^Amount/)).toBeHidden();
});

test('shows index terms to a floating loan and a fixed rate to a fixed one', async ({ page }) => {
  await openEditor(page, 'Debt facilities');

  await page.getByLabel('Rate type').selectOption('fixed');
  await expect(page.getByLabel('Fixed rate')).toBeVisible();
  await expect(page.getByLabel('Spread')).toBeHidden();
  await expect(page.getByLabel('Index curve')).toBeHidden();

  await page.getByLabel('Rate type').selectOption('floating');
  await expect(page.getByLabel('Index curve')).toBeVisible();
  await expect(page.getByLabel('Spread')).toBeVisible();
  await expect(page.getByLabel('Floor')).toBeVisible();
  await expect(page.getByLabel('Fixed rate')).toBeHidden();
});

test('reads the loan back in words as the terms change', async ({ page }) => {
  await openEditor(page, 'Debt facilities');
  const summary = page.getByRole('complementary', { name: /debt facility summary/i });
  await expect(summary).toBeVisible();

  await page.getByLabel('Interest-only (months)').fill('0');
  await page.getByLabel('Amortisation (months)').fill('0');
  await expect(summary).toContainText('interest only');

  await page.getByLabel('Amortisation (months)').fill('360');
  await page.getByLabel('Interest-only (months)').fill('24');
  await expect(summary).toContainText('24 months interest only, then amortising over 360');

  // And it says plainly that it is not a calculation.
  await expect(summary).toContainText('not a calculation');
});

test('warns when a facility would amortise to nothing before it matures', async ({ page }) => {
  /*
   * Legal, and almost always a typo: somebody meant a 360-month schedule and
   * typed 60. The loan silently repays itself and the levered return looks
   * better than the deal is.
   */
  await openEditor(page, 'Debt facilities');
  await page.getByLabel('Term (months)').fill('120');
  await page.getByLabel('Interest-only (months)').fill('0');
  await page.getByLabel('Amortisation (months)').fill('60');

  const summary = page.getByRole('complementary', { name: /debt facility summary/i });
  await expect(summary).toContainText('Amortises to zero before maturity');
});

test('lays renewal and new-lease terms side by side', async ({ page }) => {
  // They answer one question — what do I give a tenant to stay versus to
  // arrive — so reading them means seeing them together.
  await openEditor(page, 'Market leasing assumptions');
  await expect(page.getByRole('group', { name: 'If the tenant renews' })).toBeVisible();
  await expect(page.getByRole('group', { name: 'If the tenant leaves' })).toBeVisible();
});

test('weights the cost of a rollover across both branches', async ({ page }) => {
  await openEditor(page, 'Market leasing assumptions');
  await page.getByLabel('Renewal probability').fill('0.7');
  await page
    .getByRole('group', { name: 'If the tenant renews' })
    .getByLabel('Tenant improvement, per area')
    .fill('10');
  await page
    .getByRole('group', { name: 'If the tenant leaves' })
    .getByLabel('Tenant improvement, per area')
    .fill('50');

  // 0.7 x 10 + 0.3 x 50 = 22, which is not "somewhere in between" by eye.
  const summary = page.getByRole('complementary', { name: /market leasing assumption summary/i });
  await expect(summary).toContainText('22.00');
});

test('refuses a rate typed as a whole number and says what to type', async ({ page }) => {
  await openEditor(page, 'Market leasing assumptions');
  await page.getByLabel('Renewal probability').fill('70');
  await page.getByRole('button', { name: /^Save market leasing assumption/ }).click();

  /*
   * Two alerts appear, which is the intended behaviour: a summary at the top of
   * the form and an inline error on the field itself. The summary is the one
   * being asserted, so it is addressed by its own text rather than by position.
   */
  const summary = page
    .locator('.record-editor')
    .getByRole('alert')
    .filter({ hasText: 'needs attention' });
  await expect(summary).toContainText('1 field needs attention');
  await expect(summary).toContainText('Enter 0.03 for 3%, not 3');

  // And the field itself is marked, so somebody navigating by field finds it.
  await expect(page.getByLabel('Renewal probability')).toHaveAttribute('aria-invalid', 'true');
});

test('saves a record from the form and the grid shows it', async ({ page }) => {
  await openEditor(page, 'Operating expenses');

  const grid = page.getByRole('grid', { name: 'Operating expenses' });
  const original = await page.getByLabel('Recoverable share').inputValue();

  await page.getByLabel('Recoverable share').fill('0.42');
  await page.getByRole('button', { name: /^Save operating expense/ }).click();

  // The editor closing is the server having accepted it.
  await expect(page.getByRole('group', { name: 'Recovery and behaviour' })).toBeHidden({
    timeout: 15_000,
  });
  await expect(grid.getByRole('row').nth(1)).toContainText('42.00%');

  // Put the seed back, so specs that follow read the model they expect.
  await openEditor(page, 'Operating expenses');
  await page.getByLabel('Recoverable share').fill(original);
  await page.getByRole('button', { name: /^Save operating expense/ }).click();
  await expect(page.getByRole('group', { name: 'Recovery and behaviour' })).toBeHidden({
    timeout: 15_000,
  });
});

test('keeps the raw record reachable for anything the form does not show', async ({ page }) => {
  /*
   * A structured form can only offer the fields somebody thought to put in the
   * spec. Taking the raw view away would make the product less capable than the
   * thing it replaced, so it is behind a control rather than deleted.
   */
  await openEditor(page, 'Operating expenses');
  await page.getByRole('button', { name: 'Edit the raw record instead' }).click();

  await expect(page.getByRole('textbox', { name: /^Edit / })).toBeVisible();
  await page.getByRole('button', { name: 'Back to the form' }).click();
  await expect(page.getByRole('group', { name: 'How much' })).toBeVisible();
});

test('does not offer a structured form where none is defined', async ({ page }) => {
  // Capital and other revenue are plain records; their grid covers every field
  // they have, so the raw view is still the record editor and the page does not
  // pretend otherwise.
  await openEditor(page, 'Capital');
  await expect(cardFor(page, 'Capital').getByRole('textbox', { name: /^Edit / })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Edit the raw record instead' })).toBeHidden();
});

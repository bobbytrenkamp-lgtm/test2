import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { SEED, sessionFile } from './roles.js';

test.use({ storageState: sessionFile('owner') });

/**
 * The things that make the interface fast for someone who lives in it.
 *
 * The palette is keyboard-first by design, so it is tested through the
 * keyboard rather than by clicking: a command palette that only works with a
 * mouse has missed its own point.
 */

/**
 * Opens the palette from the keyboard.
 *
 * The shell has to have rendered first: the shortcut is registered by a
 * component, so a keystroke sent while the bundle is still starting lands
 * nowhere. Waiting on the navigation is waiting on the thing that registers it.
 */
async function openPalette(page: Page, path = '/'): Promise<void> {
  await page.goto(path);
  await expect(page.getByRole('navigation', { name: 'Primary' })).toBeVisible();
  await page.keyboard.press('Control+k');
  await expect(page.getByRole('dialog', { name: 'Command palette' })).toBeVisible();
}

/** The palette's own input, which is not the only combobox on the page. */
function paletteInput(page: Page) {
  return page.getByRole('combobox', { name: 'Search properties, models and screens' });
}

test.describe('command palette', () => {
  test('opens on the keyboard and navigates to a property', async ({ page }) => {
    await openPalette(page);
    const palette = page.getByRole('dialog', { name: 'Command palette' });

    // The index loads once, so the first keystrokes must still filter it.
    await paletteInput(page).fill('Harborview');
    const option = palette.getByRole('option').filter({ hasText: SEED.office.property });
    await expect(option.first()).toBeVisible();

    await page.keyboard.press('Enter');
    await expect(page.getByRole('heading', { name: SEED.office.property, level: 1 })).toBeVisible();
    await expect(palette).toBeHidden();
  });

  test('moves the selection with the arrow keys', async ({ page }) => {
    await openPalette(page);
    const palette = page.getByRole('dialog', { name: 'Command palette' });

    const first = palette.getByRole('option').first();
    await expect(first).toHaveAttribute('aria-selected', 'true');

    await page.keyboard.press('ArrowDown');
    await expect(first).toHaveAttribute('aria-selected', 'false');
    await expect(palette.getByRole('option').nth(1)).toHaveAttribute('aria-selected', 'true');

    // The highlight is announced through aria-activedescendant, not only shown.
    const active = await paletteInput(page).getAttribute('aria-activedescendant');
    expect(active).toBeTruthy();
  });

  test('closes on Escape without navigating', async ({ page }) => {
    await openPalette(page, '/properties');

    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog', { name: 'Command palette' })).toBeHidden();
    await expect(page).toHaveURL(/\/properties$/);
  });

  test('says so when nothing matches, rather than showing an empty box', async ({ page }) => {
    await openPalette(page);
    await paletteInput(page).fill('zzzz-no-such-asset');
    await expect(page.getByText(/Nothing matches/)).toBeVisible();
  });

  test('is accessible', async ({ page }) => {
    await openPalette(page);

    const { violations } = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
      .analyze();
    const summary = violations.map(
      (violation) =>
        `${violation.id} (${violation.impact ?? 'unknown'}): ${violation.help}\n` +
        violation.nodes.map((node) => `      ${node.target.join(' ')}`).join('\n'),
    );
    expect(summary, summary.join('\n')).toEqual([]);
  });
});

test.describe('pasting a rent roll from a spreadsheet', () => {
  // Tab-separated, which is what a clipboard hands over from Excel.
  const PASTED = [
    'Suite\tTenant\tLease ID\tArea\tLease Start\tLease End\tBase Rent',
    '4100\tHalvorsen Legal\tE2E-PASTE-1\t5200\t2027-01-01\t2033-12-31\t44.00',
    '4200\tOrmsby Trading\tE2E-PASTE-2\t3100\t2027-04-01\t2026-03-31\t42.00',
  ].join('\n');

  test('parses the paste, reports the bad row, and writes only the good one', async ({ page }) => {
    await page.goto('/properties');
    await page.getByRole('link', { name: SEED.office.property }).click();
    await page.getByRole('link', { name: SEED.office.model }).click();
    await page.getByRole('link', { name: 'Rent roll' }).click();

    await page.getByRole('button', { name: 'Paste from spreadsheet' }).click();
    await expect(page.getByRole('heading', { name: 'Paste from a spreadsheet' })).toBeVisible();

    await page.getByLabel('Pasted rows').fill(PASTED);
    await page.getByRole('button', { name: 'Check the paste' }).click();

    // The second row ends before it begins, so it must be named and refused.
    const findings = page.getByRole('table', { name: 'Findings in the pasted rows' });
    await expect(findings).toBeVisible();
    await expect(findings.getByRole('row').filter({ hasText: 'Error' })).toHaveCount(1);

    await expect(page.getByRole('status', { name: 'Paste summary' })).toContainText('2 data rows');
    await page.getByRole('button', { name: /^Import 1 lease/ }).click();

    // The wizard's own report is not evidence. The rent roll is.
    const table = page.getByRole('grid', { name: 'Leases on this model' });
    await expect(table.getByRole('row').filter({ hasText: 'E2E-PASTE-1' })).toBeVisible();
    await expect(table.getByRole('row').filter({ hasText: 'E2E-PASTE-2' })).toHaveCount(0);
  });
});

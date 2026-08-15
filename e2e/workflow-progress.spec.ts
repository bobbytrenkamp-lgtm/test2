import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import { SEED, sessionFile } from './roles.js';

/**
 * The workflow/progress surface on the model workspace: Setup, Rent Roll,
 * Imports, Operating, Capital, Debt, Calculate, Scenarios, Review, Output —
 * each a real signal from `GET /models/:id/workflow`, not a "visited this
 * tab" flag. `tests/underwriting-workflow.test.ts` proves the step-by-step
 * state transitions at the API level; this only has to prove the strip
 * actually renders on a real model and reflects real state.
 */
const STANDARD = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'];

test.describe('as an analyst', () => {
  test.use({ storageState: sessionFile('analyst') });

  test('shows all ten steps, with the ones the seeded model already has marked done', async ({
    page,
  }) => {
    await page.goto('/properties');
    await page.getByRole('link', { name: SEED.office.property }).click();
    await page.getByRole('link', { name: SEED.office.model }).click();

    const strip = page.getByRole('list', { name: 'Underwriting workflow' });
    await expect(strip).toBeVisible();

    const items = strip.getByRole('listitem');
    await expect(items).toHaveCount(10);
    for (const label of [
      'Setup',
      'Rent Roll',
      'Imports',
      'Operating',
      'Capital',
      'Debt',
      'Calculate',
      'Scenarios',
      'Review',
      'Output',
    ]) {
      await expect(items.filter({ hasText: label })).toHaveCount(1);
    }

    // The seeded office model has spaces and a full rent roll (three
    // tenants), so both steps read as done — a real signal from the rows
    // that exist, not from having merely opened the page.
    await expect(items.filter({ hasText: 'Setup' })).toContainText('Done:');
    await expect(items.filter({ hasText: 'Rent Roll' })).toContainText('Done:');
  });

  test('is accessible', async ({ page }) => {
    await page.goto('/properties');
    await page.getByRole('link', { name: SEED.office.property }).click();
    await page.getByRole('link', { name: SEED.office.model }).click();
    await expect(page.getByRole('list', { name: 'Underwriting workflow' })).toBeVisible();

    const { violations } = await new AxeBuilder({ page }).withTags(STANDARD).analyze();
    const summary = violations.map(
      (violation) =>
        `${violation.id} (${violation.impact ?? 'unknown'}): ${violation.help}\n` +
        violation.nodes.map((node) => `      ${node.target.join(' ')}`).join('\n'),
    );
    expect(summary, summary.join('\n')).toEqual([]);
  });
});

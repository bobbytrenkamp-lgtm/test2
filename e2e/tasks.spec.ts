import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import { SEED, sessionFile } from './roles.js';

/**
 * The asset-management board.
 *
 * The path that matters is the whole loop: raise work against a building, see
 * it on the board, finish it, and have it leave the board — because a task
 * tracker people cannot clear down is one they stop opening.
 *
 * The overdue colouring is deliberately not asserted against a hard-coded date.
 * A test that pins "today" passes forever and tells you nothing; these use a
 * date computed relative to the run.
 */
const STANDARD = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'];

/** A date offset from today, as the YYYY-MM-DD the date input expects. */
function daysFromNow(days: number): string {
  const date = new Date();
  date.setDate(date.getDate() + days);
  return date.toISOString().slice(0, 10);
}

test.describe('as an analyst', () => {
  test.use({ storageState: sessionFile('analyst') });

  test('raises work against a building and clears it down', async ({ page }) => {
    const title = `Chase the estoppel (${Date.now()})`;

    await page.goto('/tasks');
    await expect(page.getByRole('heading', { name: 'Tasks', level: 1 })).toBeVisible();

    await page.getByRole('button', { name: 'Add task' }).click();
    await page.getByLabel('What needs doing').fill(title);
    await page.getByLabel('Due date').fill(daysFromNow(14));
    await page.getByLabel('Property').selectOption({ label: SEED.office.property });
    await page.getByRole('button', { name: 'Add task', exact: true }).last().click();

    const row = page.getByRole('row').filter({ hasText: title });
    await expect(row).toBeVisible({ timeout: 30_000 });
    // Filed against the asset, not floating: the link is the point.
    await expect(row.getByRole('link', { name: SEED.office.property })).toBeVisible();

    // Finishing it takes it off the board, because the board is what is left to
    // do. It has to still be findable, or "done" would mean "destroyed".
    await row.getByLabel(`Status of ${title}`).selectOption('done');
    await expect(page.getByRole('row').filter({ hasText: title })).toHaveCount(0, {
      timeout: 30_000,
    });

    await page.getByLabel('Show finished and cancelled').check();
    await expect(page.getByRole('row').filter({ hasText: title })).toBeVisible({ timeout: 30_000 });
  });

  test('counts what is late by the reader’s own calendar', async ({ page }) => {
    const overdue = `Serve the rent review notice (${Date.now()})`;

    await page.goto('/tasks');
    await page.getByRole('button', { name: 'Add task' }).click();
    await page.getByLabel('What needs doing').fill(overdue);
    await page.getByLabel('Due date').fill(daysFromNow(-3));
    await page.getByRole('button', { name: 'Add task', exact: true }).last().click();

    const row = page.getByRole('row').filter({ hasText: overdue });
    await expect(row).toBeVisible({ timeout: 30_000 });

    // The filter asks the server for work due on or before today, where "today"
    // is this browser's date — the whole reason the API takes a date instead of
    // deciding one.
    await page.getByLabel('Overdue or due today').check();
    await expect(page.getByRole('row').filter({ hasText: overdue })).toBeVisible({
      timeout: 30_000,
    });

    // And a task due well in the future is not swept up by it.
    await page.getByLabel('Overdue or due today').uncheck();
    const future = `Rebid the insurance (${Date.now()})`;
    await page.getByRole('button', { name: 'Add task' }).click();
    await page.getByLabel('What needs doing').fill(future);
    await page.getByLabel('Due date').fill(daysFromNow(120));
    await page.getByRole('button', { name: 'Add task', exact: true }).last().click();
    await expect(page.getByRole('row').filter({ hasText: future })).toBeVisible({
      timeout: 30_000,
    });

    await page.getByLabel('Overdue or due today').check();
    await expect(page.getByRole('row').filter({ hasText: future })).toHaveCount(0, {
      timeout: 30_000,
    });
  });

  test('is accessible', async ({ page }) => {
    await page.goto('/tasks');
    await expect(page.getByRole('heading', { name: 'Tasks', level: 1 })).toBeVisible();
    // With the form open too: a per-row status control and a date input are
    // both easy places to lose a label.
    await page.getByRole('button', { name: 'Add task' }).click();
    await expect(page.getByLabel('What needs doing')).toBeVisible();

    const { violations } = await new AxeBuilder({ page }).withTags(STANDARD).analyze();
    const summary = violations.map(
      (violation) =>
        `${violation.id} (${violation.impact ?? 'unknown'}): ${violation.help}\n` +
        violation.nodes.map((node) => `      ${node.target.join(' ')}`).join('\n'),
    );
    expect(summary, summary.join('\n')).toEqual([]);
  });
});

test.describe('as a reviewer', () => {
  test.use({ storageState: sessionFile('reviewer') });

  test('sees work another member raised', async ({ page }) => {
    const title = `Confirm the service charge cap (${Date.now()})`;

    await page.goto('/tasks');
    await page.getByRole('button', { name: 'Add task' }).click();
    await page.getByLabel('What needs doing').fill(title);
    await page.getByRole('button', { name: 'Add task', exact: true }).last().click();
    await expect(page.getByRole('row').filter({ hasText: title })).toBeVisible({ timeout: 30_000 });
  });
});

/*
 * Not covered here: that a read-only member is shown no way to add to the
 * board. The demonstration seed has an owner, an analyst and a reviewer, and
 * all three can raise a task, so there is no session to prove it with. The
 * server-side refusal — the part that is actually the control — is asserted in
 * tests/tasks.test.ts; hiding the button is only so a refusal is never how
 * somebody finds out.
 */

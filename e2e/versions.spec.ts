import { expect, test } from '@playwright/test';
import { SEED, sessionFile } from './roles.js';

/**
 * Comparing two frozen versions.
 *
 * The seed leaves each model with one version, so the test makes a second one:
 * it snapshots, edits an assumption, snapshots again, then compares. That is
 * the sequence an analyst actually performs, and it is the only way to prove
 * the comparison reports an edit rather than an empty diff.
 */
test.use({ storageState: sessionFile('owner') });

test('compares two versions and says both what was edited and what it did', async ({ page }) => {
  await page.goto('/properties');
  await page.getByRole('link', { name: SEED.office.property }).click();
  await page.getByRole('link', { name: SEED.office.model }).click();
  await page.getByRole('link', { name: 'Versions' }).click();
  await expect(page.getByRole('heading', { name: 'Versions' })).toBeVisible();

  // A second version, differing from the first by one assumption. The new rate
  // is derived from whatever the seed set rather than hard-coded, so the test
  // asserts an actual change instead of silently writing the same value back.
  await page.getByRole('link', { name: 'Assumptions' }).click();
  const discountRate = page.getByLabel('Discount rate');
  await expect(discountRate).toBeVisible();
  const original = Number(await discountRate.inputValue());
  const revised = (original + 0.02).toFixed(4);
  await discountRate.fill(revised);
  await page.getByRole('button', { name: /^Save/ }).click();

  // Confirmed by a full reload, not a tab switch: the workspace holds the model
  // in context and moving between tabs does not refetch it, so a stale field
  // would read as an unsaved edit.
  await page.reload();
  await page.getByRole('link', { name: 'Assumptions' }).click();
  await expect
    .poll(async () => Number(await page.getByLabel('Discount rate').inputValue()), {
      timeout: 30_000,
    })
    .toBeCloseTo(Number(revised), 6);

  await page.getByRole('link', { name: 'Versions' }).click();
  await page.getByRole('button', { name: 'Snapshot now' }).click();

  const rows = page.getByRole('row').filter({ hasText: /^v\d/ });
  await expect(rows).toHaveCount(2, { timeout: 30_000 });

  // Selecting two versions is what asks for the comparison.
  await page
    .getByRole('checkbox', { name: /Compare version/ })
    .nth(0)
    .check();
  await page
    .getByRole('checkbox', { name: /Compare version/ })
    .nth(1)
    .check();

  await expect(page.getByRole('heading', { name: 'What was edited' })).toBeVisible({
    timeout: 30_000,
  });

  // Both halves. A value that moved with no account of why is the artefact
  // this screen replaces.
  await expect(page.getByRole('heading', { name: 'What it did, year by year' })).toBeVisible();
  const edits = page.getByRole('table', { name: /Input differences/ });
  await expect(edits).toContainText('discountRate');
});

test('refuses to compare a version with itself', async ({ page }) => {
  // Only one box can be ticked for a single version, so the interface cannot
  // ask the question — checked here so a future change to the selection logic
  // cannot quietly reintroduce a page of zeroes.
  await page.goto('/properties');
  await page.getByRole('link', { name: SEED.industrial.property }).click();
  await page.getByRole('link', { name: SEED.industrial.model }).click();
  await page.getByRole('link', { name: 'Versions' }).click();

  const boxes = page.getByRole('checkbox', { name: /Compare version/ });
  await expect(boxes.first()).toBeVisible();
  await boxes.first().check();

  // One selection is not a comparison, so nothing is shown yet.
  await expect(page.getByRole('heading', { name: 'What was edited' })).toBeHidden();
});

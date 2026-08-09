import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { SEED, sessionFile } from './roles.js';

test.use({ storageState: sessionFile('owner') });

/**
 * Underwriting health and key value drivers.
 *
 * The rules and the ranking are tested as pure functions in the engine package.
 * What the browser adds is whether an analyst can act on them: does a finding
 * explain itself, does it lead somewhere, and does the driver measurement
 * actually run the model rather than showing a plausible-looking table.
 */

async function openHealth(page: Page): Promise<void> {
  await page.goto('/properties');
  await page.getByRole('link', { name: SEED.office.property }).click();
  await page.getByRole('link', { name: SEED.office.model }).click();
  await page.getByRole('button', { name: /^Calculat/ }).click();
  await expect(page.getByRole('status', { name: 'Model status' })).toContainText('Calculated', {
    timeout: 120_000,
  });
  await page.getByRole('link', { name: 'Health', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Model health' })).toBeVisible();
}

test.beforeEach(async ({ page }) => {
  await openHealth(page);
});

test('states each finding, its threshold, and where to change it', async ({ page }) => {
  const findings = page.locator('.finding');
  await expect(findings.first()).toBeVisible();

  // A finding is a sentence with a number in it, not a label. The threshold
  // has to be visible so a reader can disagree with it rather than with the
  // tool.
  const first = findings.first();
  await expect(first.locator('p')).toContainText('%');
  await expect(first.getByRole('link', { name: 'Go to the assumption' })).toBeVisible();
});

test('gives no overall score', async ({ page }) => {
  /*
   * A design decision worth pinning. A model reduced to "72 out of 100" invites
   * an argument about the 72 and hides the four things that matter.
   */
  await expect(page.getByText('deliberately no overall score')).toBeVisible();
  await expect(page.locator('.card').first()).not.toContainText(/\b\d{1,3}\s*\/\s*100\b/);
});

test('separates what crossed a threshold from what passed', async ({ page }) => {
  // Passing checks matter — they are the evidence the arithmetic hangs together
  // — but they are not what a reviewer opens the panel for, so they fold away.
  const passes = page.locator('details', { hasText: 'passed' }).first();
  await expect(passes).toBeVisible();
  // Hidden rather than absent: `details` keeps its children in the DOM, so
  // counting them would pass whether or not the disclosure worked.
  await expect(passes.locator('.finding').first()).toBeHidden();

  await passes.locator('summary').click();
  await expect(passes.locator('.finding').first()).toBeVisible();
});

test('a finding leads to the record it is about', async ({ page }) => {
  const link = page.locator('.finding').first().getByRole('link');
  const href = await link.getAttribute('href');
  expect(href).toMatch(/\/models\/[0-9a-f-]+\/(rent-roll|assumptions|returns|validation)/);
  await link.click();
  await expect(page).toHaveURL(new RegExp(href ?? ''));
});

test('measures drivers by running the model, and says how many runs it took', async ({ page }) => {
  /*
   * The claim that makes the ranking worth anything. A closed-form sensitivity
   * would be a second model, and these relationships are not linear — raising
   * renewal probability cuts downtime and leasing costs but also stops a
   * below-market lease rolling to market.
   */
  await expect(page.getByText('Nothing measured yet')).toBeVisible();

  await page.getByRole('button', { name: 'Measure' }).click();
  const table = page.getByRole('table', { name: /ranked by their effect/ });
  await expect(table).toBeVisible({ timeout: 60_000 });

  // Both directions reported, because a variable can be asymmetric.
  await expect(table.getByRole('columnheader', { name: 'Lower' })).toBeVisible();
  await expect(table.getByRole('columnheader', { name: 'Higher' })).toBeVisible();
  await expect(page.getByText(/\d+ engine runs? against \d+ drivers?/)).toBeVisible();
});

test('ranks the biggest mover first', async ({ page }) => {
  await page.getByRole('button', { name: 'Measure' }).click();
  const table = page.getByRole('table', { name: /ranked by their effect/ });
  await expect(table).toBeVisible({ timeout: 60_000 });

  const swings = await table.getByRole('row').evaluateAll((rows) =>
    rows
      .slice(1)
      .map((row) => row.querySelectorAll('td')[4]?.textContent ?? '')
      .map((text) => Math.abs(Number(text.replace(/[^0-9.-]/g, '')))),
  );
  expect(swings.length).toBeGreaterThan(2);
  for (let i = 1; i < swings.length; i += 1) {
    expect(swings[i - 1]).toBeGreaterThanOrEqual(swings[i] as number);
  }
});

test('re-measures against a different metric', async ({ page }) => {
  await page.getByRole('button', { name: 'Measure' }).click();
  await expect(page.getByRole('table', { name: /ranked by their effect/ })).toBeVisible({
    timeout: 60_000,
  });

  // Changing the metric clears the old answer rather than leaving a table that
  // silently belongs to a different question.
  await page.getByLabel('Metric to rank against').selectOption('year1Noi');
  await expect(page.getByRole('table', { name: /ranked by their effect/ })).toBeHidden();
  await expect(page.getByText('Nothing measured yet')).toBeVisible();

  await page.getByRole('button', { name: 'Measure' }).click();
  await expect(page.getByRole('table', { name: /ranked by their effect/ })).toBeVisible({
    timeout: 60_000,
  });
});

test('is accessible', async ({ page }) => {
  await page.getByRole('button', { name: 'Measure' }).click();
  await expect(page.getByRole('table', { name: /ranked by their effect/ })).toBeVisible({
    timeout: 60_000,
  });
  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .analyze();
  expect(
    results.violations.map((violation) => `${violation.id}: ${violation.help}`),
    results.violations.map((violation) => violation.id).join(', '),
  ).toEqual([]);
});

/* -------------------------------------------------------------------------- */

test.describe('the lease timeline', () => {
  test('shows where the holes are, alongside the modelled rollover', async ({ page }) => {
    /*
     * An expiration report answers "what expires in 2028". It cannot answer
     * "where are the holes", and the holes are what the downtime, tenant
     * improvement and leasing commission assumptions are applied to.
     */
    await page.getByRole('link', { name: 'Rent roll' }).click();
    await page.getByRole('button', { name: 'Timeline' }).click();

    const timeline = page.getByRole('table', { name: /Occupancy by lease/ });
    await expect(timeline).toBeVisible();
    await expect(timeline.locator('.timeline-bar').first()).toBeVisible();

    // Drawn from the calculation, so the engine's own leasing shows up beside
    // the signed leases. A view built from lease dates could not do this.
    await expect(page.getByText(/Drawn from the calculation/)).toBeVisible();
  });

  test('rescales when the horizon changes', async ({ page }) => {
    await page.getByRole('link', { name: 'Rent roll' }).click();
    await page.getByRole('button', { name: 'Timeline' }).click();

    const caption = page.getByRole('table', { name: /Occupancy by lease/ });
    await expect(caption).toBeVisible();
    await expect(page.getByText(/across 36 months/)).toBeVisible();

    await page.getByLabel('Timeline horizon').selectOption('12');
    await expect(page.getByText(/across 12 months/)).toBeVisible();
  });

  test('switches back to the grid without losing the search', async ({ page }) => {
    // The two answer different questions; neither should discard the other's
    // context on the way past.
    await page.getByRole('link', { name: 'Rent roll' }).click();
    await page.getByLabel('Search leases').fill('Kestrel');
    await page.getByRole('button', { name: 'Timeline' }).click();
    await expect(page.getByRole('table', { name: /Occupancy by lease/ })).toBeVisible();

    await page.getByRole('button', { name: 'Grid' }).click();
    await expect(page.getByRole('grid', { name: 'Leases on this model' })).toBeVisible();
    await expect(page.getByLabel('Search leases')).toHaveValue('Kestrel');
  });
});

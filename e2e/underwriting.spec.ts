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
  await expect(page.getByRole('status', { name: 'Model status' })).toContainText(
    'Calculated with engine',
    {
      timeout: 60_000,
    },
  );

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
  await expect(page.getByRole('status', { name: 'Model status' })).toContainText(
    'Calculated with engine',
    {
      timeout: 60_000,
    },
  );

  // Count the annual columns only once the annual view is the one on screen.
  // Granularity is remembered between visits, so "whatever is showing" is not a
  // safe baseline to compare the monthly view against.
  const annual = page.getByRole('button', { name: 'Annual', exact: true });
  await expect(annual).toBeVisible();
  if ((await annual.getAttribute('aria-pressed')) !== 'true') await annual.click();
  await expect(annual).toHaveAttribute('aria-pressed', 'true');

  const cashFlow = page.getByRole('table', { name: /cash flow/i });
  await expect(cashFlow).toBeVisible();
  const annualColumns = await cashFlow.locator('thead th').count();
  expect(annualColumns).toBeGreaterThan(1);

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

/**
 * Column virtualisation on the monthly view.
 *
 * A ten-year monthly forecast is 121 columns across 27 line items, and every
 * figure is a button. `pnpm profile:grid` measured that at 3,240 interactive
 * cells and a median of 429 ms to switch into — past the point an interaction
 * feels immediate. Only the columns near the viewport are now in the DOM.
 *
 * The risk in doing that is telling assistive technology the forecast is
 * shorter than it is, so these assert the reported dimensions as well as the
 * rendered ones.
 */
test.describe('the monthly grid at scale', () => {
  test('renders far fewer cells than the forecast has, while reporting its true width', async ({
    page,
  }) => {
    await page.goto('/properties');
    await page.getByRole('link', { name: SEED.office.property }).click();
    await page.getByRole('link', { name: SEED.office.model }).click();
    await page.getByRole('button', { name: 'Calculate' }).click();
    await expect(page.getByRole('status', { name: 'Model status' })).toContainText(
      'Calculated with engine',
      { timeout: 60_000 },
    );

    await page.getByRole('button', { name: 'Monthly', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Monthly', exact: true })).toHaveAttribute(
      'aria-pressed',
      'true',
    );

    const table = page.locator('table.freeze-first');
    // A 120-month forecast: the line-item column plus every period.
    await expect(table).toHaveAttribute('aria-colcount', '121');

    // But nothing like that many are drawn.
    await expect
      .poll(async () => table.locator('thead th[aria-colindex]').count())
      .toBeLessThan(60);
  });

  test('reveals later months as the grid is scrolled', async ({ page }) => {
    // The whole point of the technique is that the missing columns are missing
    // only until they are needed. If they never arrive, the forecast is
    // unreadable past the first screen.
    await page.goto('/properties');
    await page.getByRole('link', { name: SEED.office.property }).click();
    await page.getByRole('link', { name: SEED.office.model }).click();
    await page.getByRole('button', { name: 'Calculate' }).click();
    await expect(page.getByRole('status', { name: 'Model status' })).toContainText(
      'Calculated with engine',
      { timeout: 60_000 },
    );
    await page.getByRole('button', { name: 'Monthly', exact: true }).click();

    const table = page.locator('table.freeze-first');
    const firstHeaders = await table.locator('thead th[aria-colindex]').allTextContents();

    const scroller = page.locator('.table-scroll').first();
    await scroller.evaluate((element) => {
      element.scrollLeft = element.scrollWidth;
    });

    await expect
      .poll(async () => {
        const headers = await table.locator('thead th[aria-colindex]').allTextContents();
        return headers.some((header) => !firstHeaders.includes(header));
      })
      .toBe(true);
  });

  test('leaves the annual view alone, which needs no virtualisation', async ({ page }) => {
    await page.goto('/properties');
    await page.getByRole('link', { name: SEED.office.property }).click();
    await page.getByRole('link', { name: SEED.office.model }).click();
    await page.getByRole('button', { name: 'Calculate' }).click();
    await expect(page.getByRole('status', { name: 'Model status' })).toContainText(
      'Calculated with engine',
      { timeout: 60_000 },
    );
    await page.getByRole('button', { name: 'Annual', exact: true }).click();

    const table = page.locator('table.freeze-first');
    const reported = Number(await table.getAttribute('aria-colcount'));
    const drawn = await table.locator('thead th[aria-colindex]').count();
    // Ten fiscal years plus the line-item column: every one is drawn.
    expect(drawn).toBe(reported);
  });
});

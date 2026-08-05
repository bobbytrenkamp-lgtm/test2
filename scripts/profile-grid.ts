import { chromium, type Page } from '@playwright/test';

/**
 * Measures how long the cash-flow grid takes to render.
 *
 * Grid virtualisation has been on the roadmap with a condition attached —
 * "once profiling says where" — and this is the profiling. A monthly view of a
 * ten-year forecast draws 121 columns across 27 line items, and every figure is
 * a button so it can be opened in the calculation inspector. That is a little
 * over three thousand interactive elements, which is the sort of number that
 * either matters a great deal or not at all, and guessing which is not a
 * decision anyone should make about a screen analysts live in.
 *
 * Run it against a server already serving the built bundle:
 *
 *   pnpm test:e2e --grep nothing    # or any way of starting the servers
 *   pnpm profile:grid
 *
 * It reports the switch from annual to monthly, which is the expensive
 * direction: annual is a tenth of the columns.
 */

const BASE_URL = process.env.PROFILE_BASE_URL ?? 'http://127.0.0.1:5174';
const EMAIL = process.env.PROFILE_EMAIL ?? 'owner@example.invalid';
const PASSWORD = process.env.PROFILE_PASSWORD ?? 'demo-password-2026';

/** The seeded model with the longest forecast: 120 months. */
const PROPERTY = 'Harborview Tower';
const MODEL = 'Valuation - 31 December 2026';

/**
 * The threshold a change of technique would have to beat.
 *
 * Not a budget that fails the build — this is a measurement script, and a
 * render time on a shared runner is far noisier than the engine timings the
 * benchmark gates on. It is the line above which virtualisation is worth its
 * complexity: a hundred milliseconds is the point at which an interaction stops
 * feeling immediate.
 */
const IMMEDIATE_MS = 100;

async function signIn(page: Page): Promise<void> {
  await page.goto(BASE_URL);
  await page.getByLabel('Email').fill(EMAIL);
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.getByRole('navigation', { name: 'Primary' }).waitFor();
}

async function openModel(page: Page): Promise<void> {
  await page.goto(`${BASE_URL}/properties`);
  await page.getByRole('link', { name: PROPERTY }).click();
  await page.getByRole('link', { name: MODEL }).click();
  await page.getByRole('button', { name: 'Calculate' }).click();
  await page
    .getByRole('status', { name: 'Model status' })
    .filter({ hasText: 'Calculated with engine' })
    .waitFor({ timeout: 120_000 });
}

/**
 * Times one granularity switch.
 *
 * Measured inside the page rather than around the Playwright call, so the
 * figure is the browser's own work — layout and paint included — and not the
 * driver's round trip.
 */
async function timeSwitch(page: Page, to: 'Annual' | 'Monthly'): Promise<number> {
  await page.evaluate(() => performance.clearMarks());
  const started = await page.evaluate(() => performance.now());
  await page.getByRole('button', { name: to, exact: true }).click();
  await page.locator('table.freeze-first thead th').last().waitFor();
  // A frame after the DOM settles, so layout and paint are inside the figure.
  return page.evaluate(
    (start) =>
      new Promise<number>((resolve) => {
        requestAnimationFrame(() => resolve(performance.now() - start));
      }),
    started,
  );
}

async function main(): Promise<void> {
  const browser = await chromium.launch();
  const page = await browser.newPage();

  try {
    await signIn(page);
    await openModel(page);

    // One discarded pass: the first switch pays for code the bundle has not
    // executed yet, which is not what a repeated interaction costs.
    await timeSwitch(page, 'Monthly');
    await timeSwitch(page, 'Annual');

    const monthly: number[] = [];
    const annual: number[] = [];
    for (let i = 0; i < 5; i += 1) {
      monthly.push(await timeSwitch(page, 'Monthly'));
      annual.push(await timeSwitch(page, 'Annual'));
    }

    const columns = await page.evaluate(() => {
      const table = document.querySelector('table.freeze-first');
      return {
        headers: table?.querySelectorAll('thead th').length ?? 0,
        cells: table?.querySelectorAll('tbody button').length ?? 0,
      };
    });

    await page.getByRole('button', { name: 'Monthly', exact: true }).click();
    await page.locator('table.freeze-first thead th').last().waitFor();
    const monthlyShape = await page.evaluate(() => {
      const table = document.querySelector('table.freeze-first');
      return {
        headers: table?.querySelectorAll('thead th').length ?? 0,
        cells: table?.querySelectorAll('tbody button').length ?? 0,
      };
    });

    const median = (values: number[]): number =>
      [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)] as number;

    console.warn('\nCash-flow grid render');
    console.warn('─'.repeat(64));
    console.warn(`Annual view   ${columns.headers} columns, ${columns.cells} interactive cells`);
    console.warn(
      `Monthly view  ${monthlyShape.headers} columns, ${monthlyShape.cells} interactive cells`,
    );
    console.warn('');
    console.warn(`Switch to monthly  median ${median(monthly).toFixed(0)} ms of 5`);
    console.warn(`Switch to annual   median ${median(annual).toFixed(0)} ms of 5`);
    console.warn('');

    const worst = median(monthly);
    const virtualised = monthlyShape.headers < 121;
    if (worst > IMMEDIATE_MS) {
      console.warn(
        `The monthly switch is above ${IMMEDIATE_MS} ms, so the grid does not yet feel\n` +
          'immediate at this size.' +
          (virtualised
            ? ' Column virtualisation is already in place, so the\n' +
              'remaining time is the rows and the re-layout rather than the column\n' +
              'count; row virtualisation or a cheaper cell is where to look next.'
            : ' Virtualising the columns would be worth its\n' +
              'complexity; record the measurement in docs/architecture.md alongside it.'),
      );
    } else {
      console.warn(
        `The monthly switch is inside ${IMMEDIATE_MS} ms at ${monthlyShape.cells} interactive\n` +
          'cells. Re-run this when forecasts get longer or the row count grows.',
      );
    }
    console.warn(
      '\nMeasured on this machine, one browser, no contention. Absolute numbers\n' +
        'are not portable; the shape of the comparison is.',
    );
  } finally {
    await browser.close();
  }
}

await main();

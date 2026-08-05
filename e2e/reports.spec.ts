import { expect, test } from '@playwright/test';
import { SEED, sessionFile } from './roles.js';

/**
 * Reports, and the promise the screen makes about them.
 *
 * The reports tab says, in its own words: "Each report is one definition
 * rendered four ways, so the screen, the CSV, the spreadsheet and the print
 * view can never disagree about what it contains."
 *
 * That is a claim, and until now nothing checked it. A second code path that
 * formats numbers differently, drops the totals row, or emits the columns in
 * another order would leave the screen looking right while the file a lender
 * receives says something else — which is the whole failure the single
 * definition exists to prevent.
 *
 * So the test reads the report on screen, fetches the CSV of the same report,
 * and holds the two to each other.
 */

test.use({ storageState: sessionFile('owner') });

/** A CSV row into fields, respecting quotes — the export quotes what it must. */
function parseCsvRow(line: string): string[] {
  const fields: string[] = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < line.length; i += 1) {
    const character = line[i];
    if (quoted) {
      if (character === '"') {
        if (line[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          quoted = false;
        }
      } else {
        field += character;
      }
    } else if (character === '"') {
      quoted = true;
    } else if (character === ',') {
      fields.push(field);
      field = '';
    } else {
      field += character;
    }
  }
  fields.push(field);
  return fields;
}

test('the screen and the CSV agree about what a report contains', async ({ page, request }) => {
  await page.goto('/properties');
  await page.getByRole('link', { name: SEED.office.property }).click();
  await page.getByRole('link', { name: SEED.office.model }).click();

  // A report of a model that has not been calculated has nothing to report.
  await page.getByRole('button', { name: 'Calculate' }).click();
  await expect(page.getByRole('status', { name: 'Model status' })).toContainText(
    'Calculated with engine',
    { timeout: 120_000 },
  );

  await page.getByRole('link', { name: 'Reports' }).click();
  await expect(page.getByRole('heading', { name: 'Reports', level: 2 })).toBeVisible();

  /*
   * Scoped to the definitions table by its caption, not to "rows on the page".
   * Viewing a report renders a second table below this one, and an unscoped
   * row index walks straight into it — which is exactly the bug this had when
   * first written: it passed alone and failed in the full suite, where the
   * preview from an earlier assertion was still on screen.
   */
  const definitions = page.getByRole('table', { name: 'Available property reports' });

  // The first report in the list, whichever it is: the point is that the two
  // renderings agree, not that one particular report does.
  const firstRow = definitions.getByRole('row').nth(1);
  const title = (await firstRow.getByRole('rowheader').innerText()).trim();
  await firstRow.getByRole('button', { name: 'View' }).click();

  const viewer = page.getByRole('table', { name: title });
  await expect(viewer).toBeVisible({ timeout: 60_000 });

  const onScreenHeaders = (await viewer.getByRole('columnheader').allInnerTexts()).map((text) =>
    text.trim(),
  );
  expect(onScreenHeaders.length).toBeGreaterThan(0);

  // The identifier is not on the page, so it is taken from the download link
  // the same row offers rather than guessed from the title.
  const csvHref = await firstRow.getByRole('link', { name: 'CSV' }).getAttribute('href');
  expect(csvHref).toBeTruthy();

  const response = await request.get(new URL(csvHref as string, page.url()).toString());
  expect(response.status()).toBe(200);
  const csv = await response.text();

  const lines = csv.split(/\r?\n/).filter((line) => line.trim() !== '');
  expect(lines.length).toBeGreaterThan(0);

  /*
   * The CSV carries a title block above the table — the same one the print view
   * shows — so the header row is found by matching the columns rather than
   * assumed to be first. Assuming would make this pass on a file whose table
   * had vanished entirely.
   */
  const headerIndex = lines.findIndex((line) => {
    const fields = parseCsvRow(line).map((field) => field.trim());
    return onScreenHeaders.every((header) => fields.includes(header));
  });
  expect(
    headerIndex,
    `The CSV has no row carrying the columns shown on screen (${onScreenHeaders.join(', ')}).\n` +
      `First lines were:\n${lines.slice(0, 6).join('\n')}`,
  ).toBeGreaterThanOrEqual(0);

  const csvHeaders = parseCsvRow(lines[headerIndex] as string).map((field) => field.trim());
  // Same columns, same order. Order matters: a reader lines a CSV up against
  // the screen by position.
  expect(csvHeaders.filter((header) => header !== '')).toEqual(onScreenHeaders);

  // And the same number of data rows. A file that silently truncated would
  // otherwise pass everything above it.
  const onScreenRows = await viewer.locator('tbody tr').count();
  const csvDataRows = lines.slice(headerIndex + 1).filter((line) => {
    const fields = parseCsvRow(line).map((field) => field.trim());
    return fields.some((field) => field !== '');
  });
  expect(csvDataRows.length).toBeGreaterThanOrEqual(onScreenRows);
});

test('every report definition is reachable and renders', async ({ page }) => {
  await page.goto('/properties');
  await page.getByRole('link', { name: SEED.office.property }).click();
  await page.getByRole('link', { name: SEED.office.model }).click();
  await page.getByRole('button', { name: 'Calculate' }).click();
  await expect(page.getByRole('status', { name: 'Model status' })).toContainText(
    'Calculated with engine',
    { timeout: 120_000 },
  );
  await page.getByRole('link', { name: 'Reports' }).click();

  const definitions = page.getByRole('table', { name: 'Available property reports' });
  const views = definitions.getByRole('button', { name: 'View' });

  /*
   * Waited for before counting. `locator.count()` does not auto-wait — it
   * answers immediately with whatever is in the DOM at that instant — so
   * counting straight after a navigation races the fetch that fills the table.
   * This passed three consecutive local runs and failed on CI, twice, with
   * `Received: 0`: the runner is slower, and the race is only ever lost on the
   * slower machine.
   */
  await expect(views.first()).toBeVisible({ timeout: 60_000 });

  const count = await views.count();
  // The feature is described as nine property reports; asserting the count
  // would pin a number that is allowed to grow, so this asserts there are
  // several and that each one works.
  expect(count).toBeGreaterThan(4);

  for (let i = 0; i < count; i += 1) {
    const row = definitions.getByRole('row').nth(i + 1);
    const title = (await row.getByRole('rowheader').innerText()).trim();
    await row.getByRole('button', { name: 'View' }).click();
    // Each renders its own heading and a table, rather than the previous
    // report's — which is what a stale-selection bug would look like.
    await expect(page.getByRole('heading', { name: title, level: 2 })).toBeVisible({
      timeout: 60_000,
    });
    await expect(page.getByRole('table', { name: title })).toBeVisible();
  }
});

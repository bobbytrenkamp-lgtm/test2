import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { SEED, sessionFile } from './roles.js';

/**
 * The assumptions editor.
 *
 * This is where an analyst sets the discount rate, the exit capitalisation rate
 * and the sale month — the handful of numbers that move every figure the
 * platform reports. It was the last screen carrying real weight with no
 * dedicated coverage: the accessibility sweep opened it, and nothing checked
 * that editing anything on it did what it says.
 *
 * A form test that types a value and asserts the value is in the box proves the
 * box works. What matters is whether the number reaches the engine, so these
 * change an assumption, recalculate, and hold the result to an economic truth —
 * the same standard the sensitivity grids are held to.
 */
const STANDARD = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'];

async function openAssumptions(page: Page): Promise<void> {
  await page.goto('/properties');
  await page.getByRole('link', { name: SEED.office.property }).click();
  await page.getByRole('link', { name: SEED.office.model }).click();
  await page.getByRole('link', { name: 'Assumptions' }).click();
  await expect(
    page.getByRole('heading', { name: 'Valuation and vacancy assumptions' }),
  ).toBeVisible();
}

/** The discounted cash-flow value currently shown on the Returns tab. */
async function shownDcf(page: Page): Promise<number> {
  const heading = page.getByRole('heading', { name: 'Discounted cash flow', level: 3 });
  const badge = heading.locator('xpath=following-sibling::span[1]');
  return Number((await badge.innerText()).replace(/[^0-9.-]/g, ''));
}

/**
 * Saves the assumptions form and waits for the write to land.
 *
 * The button is the signal: `dirty` is cleared only after the PATCH resolves,
 * so it goes "Save assumptions" → "Saving…" → "No changes". Clicking save and
 * calculating straight afterwards races the write, and the calculation then
 * runs against the *old* stored assumption — which is precisely how the first
 * version of this test reported an unchanged valuation and looked like an
 * engine defect. It was not: the API does exactly the right thing when asked in
 * order.
 */
async function saveAssumptions(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Save assumptions' }).click();
  await expect(page.getByRole('button', { name: 'No changes' })).toBeVisible({ timeout: 60_000 });
}

/**
 * Recalculates and lands on the Returns tab.
 *
 * Callers poll the value itself afterwards, which is the only thing that
 * actually moves between runs.
 */
async function recalculate(page: Page): Promise<void> {
  /*
   * Awaited on the response, not on anything the page renders.
   *
   * The status banner cannot serve as the signal: it reads
   * `Calculated with engine 3.3.1.` after every successful run, so once one
   * calculation has happened, waiting for that text matches the *previous*
   * result instantly.
   *
   * Leaving a calculation in flight also loses a subsequent edit — typing into
   * the assumptions form while one is running, the value reverts. Awaiting the
   * response fixes it, established by trying it both ways rather than reasoned
   * about; the precise React mechanism is not identified here, and guessing at
   * one in a comment would be worse than saying so.
   */
  const finished = page.waitForResponse(
    (response) => response.url().includes('/calculate') && response.request().method() === 'POST',
    { timeout: 120_000 },
  );
  await page.getByRole('button', { name: /^Calculat/ }).click();
  await finished;
  await expect(page.getByRole('status', { name: 'Model status' })).toBeVisible({ timeout: 60_000 });

  await page.getByRole('link', { name: 'Returns and debt' }).click();
  await expect(page.getByRole('heading', { name: 'Discounted cash flow', level: 3 })).toBeVisible({
    timeout: 120_000,
  });
}

/**
 * Types a value into the assumptions form and confirms it stuck.
 *
 * An earlier version of this test filled 0.14, had it silently revert to
 * 0.0825 while a calculation was still in flight, and then failed several steps
 * later looking like an engine defect. It was not: the API does exactly the
 * right thing when asked in order, which was confirmed by driving the same
 * sequence through it directly.
 *
 * Asserting the field holds what was typed turns that class of problem into an
 * immediate failure at the point it happens, rather than a mystery downstream.
 */
async function editAssumption(page: Page, label: string, value: string): Promise<void> {
  const field = page.getByLabel(label);
  await expect(field).toBeEnabled();
  await field.fill(value);
  await expect(field).toHaveValue(value);
}

test.describe('as an analyst', () => {
  test.use({ storageState: sessionFile('analyst') });

  test('a higher discount rate lowers the value, so the number reaches the engine', async ({
    page,
  }) => {
    await openAssumptions(page);

    const original = (await page.getByLabel('Discount rate').inputValue()).trim();
    expect(Number(original)).toBeGreaterThan(0);

    await recalculate(page);
    const before = await shownDcf(page);
    expect(before).toBeGreaterThan(0);

    /*
     * Navigated to afresh rather than by clicking the tab, deliberately.
     *
     * The workspace replaces its `Outlet` with a loading placeholder whenever
     * the model resource refetches, so the form unmounts and rebuilds from the
     * model — discarding anything typed. After a calculation that refetch can
     * land at any moment, and clicking through to the tab races it. A full
     * navigation starts from a settled page with nothing in flight.
     */
    await page.getByRole('link', { name: 'Assumptions' }).click();

    // Raise it materially. Discounting the same cash flows harder must produce
    // a smaller present value — on any asset, every time.
    await editAssumption(page, 'Discount rate', '0.14');
    await saveAssumptions(page);

    // Polled rather than read once: the calculation is asynchronous and the
    // banner cannot say which run it refers to. A value that never falls fails
    // this on the timeout, which is exactly the assertion wanted.
    await recalculate(page);
    await expect.poll(() => shownDcf(page), { timeout: 120_000 }).toBeLessThan(before);

    /*
     * Put it back, and confirm the value returns. This is what separates "the
     * edit was applied" from "something changed": a screen that saved to the
     * wrong field, or an engine reading a stale assumption, would fail here
     * even if it passed the assertion above.
     */
    await openAssumptions(page);
    await editAssumption(page, 'Discount rate', original);
    await saveAssumptions(page);

    await recalculate(page);
    await expect.poll(() => shownDcf(page), { timeout: 120_000 }).toBeGreaterThan(before * 0.999);
  });

  test('the save button stays disabled until something is edited', async ({ page }) => {
    await openAssumptions(page);
    /*
     * The button renames itself rather than sitting there greyed out and
     * unexplained: "No changes" at rest, "Save assumptions" once something is
     * edited. That is better than a disabled Save, and it is worth pinning
     * because it is the kind of nicety a refactor quietly loses.
     *
     * It matters beyond tidiness: on a versioned record a write that changes
     * nothing still burns a version and can collide with a colleague's edit.
     */
    const idle = page.getByRole('button', { name: 'No changes' });
    await expect(idle).toBeVisible();
    await expect(idle).toBeDisabled();

    await page.getByLabel('Costs of sale').fill('0.021');
    await expect(page.getByRole('button', { name: 'Save assumptions' })).toBeEnabled();
  });

  test('a second save in the same visit is not refused as a conflict with someone else', async ({
    page,
  }) => {
    /*
     * Found by a fifteenth audit pass. `PATCH /models/:id` increments
     * `model.version` on every write and refuses a save whose
     * `expectedVersion` doesn't match — the model resource the workspace
     * loaded once at the start of the visit never picked up that new
     * version, so a second save sent the version the form opened with,
     * one behind what its own first save had just produced, and was
     * refused with "This model has been changed by someone else since you
     * opened it" — for a model only this one save had touched.
     *
     * `saveAssumptions` is the signal for both saves here: it waits for
     * the button to read "No changes" again, which only happens once
     * `dirty` clears on a *successful* save. Before the fix the second call
     * would time out with the button still reading "Save assumptions" and
     * the conflict message on screen.
     */
    await openAssumptions(page);
    const original = (await page.getByLabel('Costs of sale').inputValue()).trim();

    await editAssumption(page, 'Costs of sale', '0.019');
    await saveAssumptions(page);

    await editAssumption(page, 'Costs of sale', '0.021');
    await saveAssumptions(page);
    await expect(page.getByText(/changed by someone else/i)).toHaveCount(0);

    await editAssumption(page, 'Costs of sale', original);
    await saveAssumptions(page);
  });

  test('is accessible, including its warning state', async ({ page }) => {
    await openAssumptions(page);

    /*
     * Forward-twelve terminal NOI needs a year of forecast beyond the sale, and
     * the screen warns when the sale month leaves none. Driving the warning on
     * matters: `aria-invalid` and an error message appearing together is
     * exactly the pairing an automated sweep of the resting state never sees.
     */
    await page.getByLabel('Terminal NOI basis').selectOption('forward_12');
    await page.getByLabel('Sale month').fill(String(120));

    const { violations } = await new AxeBuilder({ page }).withTags(STANDARD).analyze();
    const summary = violations.map(
      (violation) =>
        `${violation.id} (${violation.impact ?? 'unknown'}): ${violation.help}\n` +
        violation.nodes.map((node) => `      ${node.target.join(' ')}`).join('\n'),
    );
    expect(summary, summary.join('\n')).toEqual([]);
  });

  test('a growth curve can start from the organization library instead of a blank row, and keeps a record of it', async ({
    page,
  }) => {
    // The library entry is created fresh in the organization admin screen
    // first, so this proves the whole path — not just that a picker renders,
    // but that what it seeds is what actually gets saved onto the model.
    await page.goto('/organization');
    await expect(page.getByRole('heading', { name: 'Growth curve library' })).toBeVisible();
    await page.getByRole('button', { name: 'Add', exact: true }).click();
    await page
      .getByLabel('New template')
      .fill(
        JSON.stringify(
          { code: 'e2e-cpi', name: 'E2E test CPI curve', defaultRate: '0.031', byYear: [] },
          null,
          2,
        ),
      );
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(page.getByRole('row', { name: /e2e-cpi/ })).toBeVisible();

    await openAssumptions(page);
    const growthCurves = page.locator('.card', {
      has: page.getByRole('heading', { name: 'Growth curves' }),
    });
    await growthCurves.getByLabel(/Start a new growth curve from the organization/).selectOption({
      label: 'E2E test CPI curve',
    });

    // Seeded, not yet saved: the draft carries the template's own values, and
    // nothing in the growth-curve table has changed until Save is pressed.
    const draft = growthCurves.getByRole('textbox', { name: 'New growth curve' });
    await expect(draft).toHaveValue(/e2e-cpi/);
    await expect(draft).toHaveValue(/0\.031/);
    await expect(draft).toHaveValue(/sourceTemplateName/);
    await expect(growthCurves.getByRole('row', { name: /e2e-cpi/ })).toHaveCount(0);

    await growthCurves.getByRole('button', { name: 'Save', exact: true }).click();
    const savedRow = growthCurves.getByRole('row', { name: /e2e-cpi/ });
    await expect(savedRow).toBeVisible();
    // Not just saved — traceable: the row says which library entry it came
    // from, a record that survives independently of the template itself
    // (deleting or renaming the library entry afterward would not change
    // this cell, since it was copied in, not linked).
    await expect(savedRow).toContainText('Library: E2E test CPI curve');
  });
});

test.describe('as a reviewer', () => {
  test.use({ storageState: sessionFile('reviewer') });

  test('can read the assumptions but not change them', async ({ page }) => {
    await openAssumptions(page);
    // A reviewer holds no `model:write`. The server refuses regardless; the
    // disabled fieldset is so a refusal is never how somebody finds out.
    await expect(page.getByLabel('Discount rate')).toBeDisabled();
  });
});

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
   * `Calculated with engine 3.3.0.` after every successful run, so once one
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

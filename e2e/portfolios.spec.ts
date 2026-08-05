import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import { sessionFile } from './roles.js';

/**
 * The portfolio roll-up.
 *
 * The screen states the rule the whole module rests on: "Rates are rebuilt from
 * portfolio numerators and denominators, and the portfolio IRR is solved from
 * combined cash flows rather than averaged from property returns."
 *
 * That distinction is not decoration. Averaging a going-in capitalisation rate
 * across five assets of different sizes gives a number no investor earns, and
 * it is wrong in the direction that flatters a portfolio holding one large
 * low-yielding asset. The unit tests hold the aggregation function to it; these
 * hold the screen to it, which is where somebody actually reads the figure.
 *
 * The check is arithmetic rather than a fixed expected number: NOI over value
 * has to equal the rate shown, whatever the seed happens to contain. A fixture
 * that pinned a literal would break every time the demonstration data changed,
 * and would be quietly rewritten to match rather than investigated.
 */

const PORTFOLIO = 'Meridian Diversified Fund I';
const STANDARD = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'];

test.use({ storageState: sessionFile('owner') });

/** A displayed figure back to a number. Handles the compact "$12.3M" form. */
function toNumber(text: string): number {
  const cleaned = text.trim().replace(/[^0-9.KMBT-]/gi, '');
  const scale = /K$/i.test(cleaned)
    ? 1e3
    : /M$/i.test(cleaned)
      ? 1e6
      : /B$/i.test(cleaned)
        ? 1e9
        : /T$/i.test(cleaned)
          ? 1e12
          : 1;
  return Number(cleaned.replace(/[KMBT]$/i, '')) * scale;
}

async function metric(page: import('@playwright/test').Page, term: string): Promise<string> {
  // Read the value beside its own label rather than by position: a metric grid
  // reorders easily, and reading the wrong tile would make this test assert
  // something true about a figure nobody asked about.
  const tile = page.locator('.metric').filter({ has: page.getByText(term, { exact: true }) });
  const text = await tile.locator('dd').first().innerText();
  /*
   * The first line only. A tile's `dd` also carries its note — "5 assets",
   * "LTV 45.00%" — and reading the whole element folds that into the figure.
   * It cost a debugging round: "assets" ends in a T, which the compact-notation
   * scale suffix matched, and the amount came back as NaN.
   */
  return (text.split('\n')[0] ?? '').trim();
}

test('rolls up the portfolio and rebuilds the rate rather than averaging it', async ({ page }) => {
  await page.goto('/portfolios');
  await expect(page.getByRole('heading', { name: 'Portfolios', level: 1 })).toBeVisible();

  await page
    .getByRole('row')
    .filter({ hasText: PORTFOLIO })
    .getByRole('button', { name: 'Roll up' })
    .click();

  await expect(page.getByRole('heading', { name: PORTFOLIO, level: 2 })).toBeVisible({
    timeout: 120_000,
  });

  const grossText = await metric(page, 'Gross asset value');
  const noiText = await metric(page, 'Year 1 NOI');
  const capText = await metric(page, 'Going-in cap rate');

  const gross = toNumber(grossText);
  const noi = toNumber(noiText);
  const cap = Number(capText.replace('%', '')) / 100;

  expect(gross).toBeGreaterThan(0);
  expect(noi).toBeGreaterThan(0);
  expect(cap).toBeGreaterThan(0);

  /*
   * The rule, checked: the rate shown is the portfolio's own NOI over its own
   * value. Tolerance is wide because both inputs are read from the screen in
   * compact form ("$12.3M"), so this is meant to catch a wrong method rather
   * than a rounding difference.
   *
   * It does. Replacing the aggregation with a plain mean of each property's own
   * cap rate — the mistake the rule exists to forbid — moves the figure by 2.64
   * percentage points on the demonstration portfolio, more than five times this
   * tolerance, and the assertion fails. Recorded because a tolerance nobody has
   * tested against the error it is meant to catch is a guess.
   */
  const rebuilt = noi / gross;
  expect(Math.abs(rebuilt - cap)).toBeLessThan(0.005);

  // The screen says so in words beside the figure, and that sentence is part of
  // what makes the number readable by someone who did not write it.
  await expect(page.getByText('NOI over value, not an average')).toBeVisible();
});

test('net asset value is gross less debt, as the labels claim', async ({ page }) => {
  await page.goto('/portfolios');
  await page
    .getByRole('row')
    .filter({ hasText: PORTFOLIO })
    .getByRole('button', { name: 'Roll up' })
    .click();
  await expect(page.getByRole('heading', { name: PORTFOLIO, level: 2 })).toBeVisible({
    timeout: 120_000,
  });

  const gross = toNumber(await metric(page, 'Gross asset value'));
  const net = toNumber(await metric(page, 'Net asset value'));
  const debt = toNumber(await metric(page, 'Debt'));

  expect(debt).toBeGreaterThan(0);
  // Sign errors on debt are the classic failure here, and they would show as
  // a net value above the gross rather than below it.
  expect(net).toBeLessThan(gross);
  expect(Math.abs(gross - debt - net)).toBeLessThan(Math.max(gross * 0.01, 1));
});

test('is accessible', async ({ page }) => {
  await page.goto('/portfolios');
  await page
    .getByRole('row')
    .filter({ hasText: PORTFOLIO })
    .getByRole('button', { name: 'Roll up' })
    .click();
  await expect(page.getByRole('heading', { name: PORTFOLIO, level: 2 })).toBeVisible({
    timeout: 120_000,
  });

  const { violations } = await new AxeBuilder({ page }).withTags(STANDARD).analyze();
  const summary = violations.map(
    (violation) =>
      `${violation.id} (${violation.impact ?? 'unknown'}): ${violation.help}\n` +
      violation.nodes.map((node) => `      ${node.target.join(' ')}`).join('\n'),
  );
  expect(summary, summary.join('\n')).toEqual([]);
});

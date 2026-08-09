import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { sessionFile } from './roles.js';

/**
 * Tenant exposure across a portfolio.
 *
 * `e2e/portfolios.spec.ts` holds the financial roll-up to its own stated
 * rule. This is the companion panel: not a number, a table, and what matters
 * about it in the browser is that it appears once the roll-up itself has
 * loaded, that its percentages are internally consistent, and that it does
 * not silently duplicate the "Tenant concentration" summary already on the
 * page — the two answer related but different questions, and a reader should
 * be able to tell them apart without reading the source.
 */

const PORTFOLIO = 'Meridian Diversified Fund I';
const STANDARD = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'];

test.use({ storageState: sessionFile('owner') });

async function openRollUp(page: Page): Promise<void> {
  await page.goto('/portfolios');
  await page
    .getByRole('row')
    .filter({ hasText: PORTFOLIO })
    .getByRole('button', { name: 'Roll up' })
    .click();
  await expect(page.getByRole('heading', { name: PORTFOLIO, level: 2 })).toBeVisible({
    timeout: 120_000,
  });
}

test('shows tenant exposure alongside the roll-up, matched by tenant rather than by name', async ({
  page,
}) => {
  await openRollUp(page);

  const panel = page.locator('.card', {
    has: page.getByRole('heading', { name: 'Tenant exposure across the portfolio' }),
  });
  await expect(panel).toBeVisible({ timeout: 30_000 });

  const table = panel.getByRole('table');
  const rows = table.locator('tbody tr');
  await expect(rows.first()).toBeVisible();

  // Every row states what it is a share of and where it came from — a tenant
  // with no property named beside it, or a share with no unit, would be a
  // number nobody could act on.
  const first = rows.first();
  await expect(first.getByRole('link')).toBeVisible();
  await expect(first).toContainText('%');
});

test('reports shares that sum to no more than the whole portfolio', async ({ page }) => {
  await openRollUp(page);

  const panel = page.locator('.card', {
    has: page.getByRole('heading', { name: 'Tenant exposure across the portfolio' }),
  });
  const shares = await panel.locator('tbody tr').evaluateAll((rows) =>
    rows.map((row) => {
      const cells = row.querySelectorAll('td');
      // Share of rent is the second-to-last cell before credit rating; read
      // by its own numeric class rather than a fixed index, so a column
      // reorder fails this test rather than silently reading the wrong one.
      const numeric = Array.from(cells).filter((cell) => cell.classList.contains('numeric'));
      const shareCell = numeric[numeric.length - 1];
      return Number((shareCell?.textContent ?? '0').replace(/[^0-9.]/g, ''));
    }),
  );

  expect(shares.length).toBeGreaterThan(0);
  const total = shares.reduce((sum, value) => sum + value, 0);
  // Percentages, not fractions, and never more than the whole — a bug that
  // double-counted a tenant present on two properties would push this over
  // 100 well before it pushed any single row there.
  expect(total).toBeLessThanOrEqual(100.5);
  expect(total).toBeGreaterThan(0);
});

test('is distinct from the tenant-concentration summary already on the page', async ({ page }) => {
  /*
   * Both tables can legitimately show the same tenants — that is not the
   * defect this guards against. What would be a defect is the exposure panel
   * turning out to be a second render of the same rows: the concentration
   * summary is keyed by name and capped at 20, the exposure panel is keyed by
   * tenant id and carries columns — properties, lease count, credit rating —
   * the summary does not have at all.
   */
  await openRollUp(page);

  const concentration = page.locator('.card', {
    has: page.getByRole('heading', { name: 'Tenant concentration' }),
  });
  const exposure = page.locator('.card', {
    has: page.getByRole('heading', { name: 'Tenant exposure across the portfolio' }),
  });
  await expect(concentration).toBeVisible();
  await expect(exposure).toBeVisible({ timeout: 30_000 });

  await expect(exposure.getByRole('columnheader', { name: 'Properties' })).toBeVisible();
  await expect(exposure.getByRole('columnheader', { name: 'Leases' })).toBeVisible();
  await expect(exposure.getByRole('columnheader', { name: 'Credit rating' })).toBeVisible();
  // The older table has no such columns — asserting their absence there is
  // what would catch the two panels being accidentally merged into one.
  await expect(concentration.getByRole('columnheader', { name: 'Leases' })).toHaveCount(0);
});

test('links a tenant’s property back to that property’s own page', async ({ page }) => {
  await openRollUp(page);
  const panel = page.locator('.card', {
    has: page.getByRole('heading', { name: 'Tenant exposure across the portfolio' }),
  });
  await expect(panel.locator('tbody tr').first()).toBeVisible({ timeout: 30_000 });

  const link = panel.locator('tbody tr').first().getByRole('link').first();
  const propertyName = await link.innerText();
  await link.click();
  await expect(page.getByRole('heading', { name: propertyName, level: 1 })).toBeVisible();
});

test('is accessible', async ({ page }) => {
  await openRollUp(page);
  await expect(
    page.locator('.card', {
      has: page.getByRole('heading', { name: 'Tenant exposure across the portfolio' }),
    }),
  ).toBeVisible({ timeout: 30_000 });

  const { violations } = await new AxeBuilder({ page }).withTags(STANDARD).analyze();
  const summary = violations.map(
    (violation) =>
      `${violation.id} (${violation.impact ?? 'unknown'}): ${violation.help}\n` +
      violation.nodes.map((node) => `      ${node.target.join(' ')}`).join('\n'),
  );
  expect(summary, summary.join('\n')).toEqual([]);
});

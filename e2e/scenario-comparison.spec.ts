import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { SEED, sessionFile } from './roles.js';

/**
 * The scenario comparison table on a property's own page: what each of its
 * models actually calculated to, side by side. `e2e/scenarios.spec.ts`
 * already proves cloning works; these tests are only about the table that
 * was missing once two or more scenarios exist to compare.
 */

test.use({ storageState: sessionFile('owner') });

const HEADERS = { 'X-Requested-With': 'cre-platform' };
const STANDARD = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'];

async function officeIds(page: Page): Promise<{ propertyId: string; modelId: string }> {
  await page.goto('/properties');
  await page.getByRole('link', { name: SEED.office.property }).click();
  await expect(page).toHaveURL(/\/properties\/[0-9a-f-]+/);
  const propertyId = /\/properties\/([0-9a-f-]+)/.exec(page.url())?.[1] as string;

  await page.getByRole('link', { name: SEED.office.model }).click();
  await expect(page).toHaveURL(/\/models\/[0-9a-f-]+/);
  const modelId = /\/models\/([0-9a-f-]+)/.exec(page.url())?.[1] as string;

  return { propertyId, modelId };
}

async function clone(page: Page, modelId: string, name: string): Promise<string> {
  const response = await page.request.post(`/api/v1/models/${modelId}/clone`, {
    headers: HEADERS,
    data: { name },
  });
  expect(response.status(), await response.text()).toBe(201);
  return ((await response.json()) as { model: { id: string } }).model.id;
}

function comparisonCard(page: Page) {
  return page.locator('.card', {
    has: page.getByRole('heading', { name: 'Scenario comparison', level: 2, exact: true }),
  });
}

test('shows scenarios side by side once a property has more than one model', async ({ page }) => {
  const { propertyId, modelId } = await officeIds(page);
  const name = `Comparison downside ${Date.now()}`;
  await clone(page, modelId, name);

  await page.goto(`/properties/${propertyId}`);
  const card = comparisonCard(page);
  await expect(card).toBeVisible();

  // The seeded office model has already been calculated (other specs read
  // its cash flow), so its row carries real figures rather than the
  // "not calculated yet" placeholder.
  const baseRow = card.locator('tr', { hasText: SEED.office.model });
  await expect(baseRow).toBeVisible();
  await expect(baseRow).not.toContainText('Not calculated yet');

  // The clone is a distinct scenario that has never itself been run, even
  // though it started as a copy of an already-calculated model — a clone is
  // a new draft, not a live view of the one it came from.
  const cloneRow = card.locator('tr', { hasText: name });
  await expect(cloneRow).toBeVisible();
  await expect(cloneRow).toContainText('Not calculated yet');

  // The scenario name here is deliberately plain text, not a second link:
  // the "Models" table above already links every model by that exact name,
  // and a second link with the same accessible name would be ambiguous to
  // anything that finds a model that way -- including officeIds() in this
  // very file. Navigating to the clone goes through that existing link.
  await page.getByRole('link', { name }).click();
  await expect(page).toHaveURL(/\/models\/[0-9a-f-]+/);
});

test('stays hidden when a property has only its one model', async ({ page }) => {
  // A fresh property with exactly one model, so nothing on the shared
  // seeded data (which other specs keep adding siblings to) can affect
  // this assertion either way.
  const property = await page.request.post('/api/v1/properties', {
    headers: HEADERS,
    data: {
      name: `Single-model check ${Date.now()}`,
      propertyType: 'office',
      rentableArea: '40000',
    },
  });
  expect(property.status(), await property.text()).toBe(201);
  const soloPropertyId = ((await property.json()) as { property: { id: string } }).property.id;

  const model = await page.request.post('/api/v1/models', {
    headers: HEADERS,
    data: {
      propertyId: soloPropertyId,
      name: 'Only case',
      classification: 'valuation',
      valuationDate: '2026-01-01',
      forecastStartDate: '2026-01-01',
      forecastMonths: 36,
      discountRate: '0.08',
      terminalCapRate: '0.07',
      generalVacancyRate: '0.05',
      saleMonth: 36,
    },
  });
  expect(model.status(), await model.text()).toBe(201);

  await page.goto(`/properties/${soloPropertyId}`);
  await expect(page.getByRole('link', { name: 'Only case' })).toBeVisible();
  await expect(comparisonCard(page)).toHaveCount(0);
});

test('is accessible with more than one scenario to compare', async ({ page }) => {
  const { propertyId, modelId } = await officeIds(page);
  await clone(page, modelId, `Accessibility check ${Date.now()}`);

  await page.goto(`/properties/${propertyId}`);
  await expect(comparisonCard(page)).toBeVisible();

  const { violations } = await new AxeBuilder({ page }).withTags(STANDARD).analyze();
  const summary = violations.map(
    (violation) =>
      `${violation.id} (${violation.impact ?? 'unknown'}): ${violation.help}\n` +
      violation.nodes.map((node) => `      ${node.target.join(' ')}`).join('\n'),
  );
  expect(summary, summary.join('\n')).toEqual([]);
});

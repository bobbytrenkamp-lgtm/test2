import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { SEED, sessionFile } from './roles.js';

/**
 * The organization-wide queue on the dashboard: what needs deciding, without
 * already knowing which model has it. `provenance.spec.ts` covers the
 * per-model decision screen this links to; these tests are only about the
 * dashboard surface itself — that a pending proposal shows up there, that
 * its link actually opens the right model, and that deciding it makes it
 * disappear from the dashboard the same way it disappears from the model's
 * own list.
 */

test.use({ storageState: sessionFile('owner') });

const HEADERS = { 'X-Requested-With': 'cre-platform' };
const STANDARD = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'];

async function officeModelId(page: Page): Promise<string> {
  await page.goto('/properties');
  await page.getByRole('link', { name: SEED.office.property }).click();
  await page.getByRole('link', { name: SEED.office.model }).click();
  await expect(page).toHaveURL(/\/models\/[0-9a-f-]+/);
  const match = /\/models\/([0-9a-f-]+)/.exec(page.url());
  return match?.[1] as string;
}

async function propose(
  page: Page,
  modelId: string,
  target: string,
  value: string,
  sourceName: string,
): Promise<void> {
  const response = await page.request.post(`/api/v1/models/${modelId}/assumption-proposals`, {
    headers: HEADERS,
    data: { proposals: [{ target, value, sourceKind: 'market_data', sourceName, evidence: {} }] },
  });
  expect(response.status(), await response.text()).toBe(201);
}

/**
 * Decides whatever this test posted, by source name, so a stray pending
 * proposal from this spec never lingers to confuse a later one — the same
 * discipline `provenance.spec.ts` uses for the model fields it restores,
 * applied here to a row instead of a field.
 */
async function decide(page: Page, modelId: string, sourceName: string): Promise<void> {
  const list = await page.request.get(
    `/api/v1/models/${modelId}/assumption-proposals?status=pending`,
    { headers: HEADERS },
  );
  const proposals = (await list.json()).proposals as Array<{ id: string; source_name: string }>;
  const mine = proposals.find((entry) => entry.source_name === sourceName);
  if (!mine) return;
  const response = await page.request.post(
    `/api/v1/models/${modelId}/assumption-proposals/${mine.id}/decision`,
    { headers: HEADERS, data: { decision: 'rejected', note: 'cleanup' } },
  );
  expect(response.ok(), await response.text()).toBe(true);
}

function decisionsCard(page: Page) {
  return page.locator('.card', {
    has: page.getByRole('heading', { name: 'Assumption decisions waiting', level: 2, exact: true }),
  });
}

test('shows a pending decision on the dashboard, and its link opens the right model', async ({
  page,
}) => {
  const modelId = await officeModelId(page);
  await propose(page, modelId, 'valuation.terminalCapRate', '0.0525', 'dashboard-queue-check');

  await page.goto('/');
  const card = decisionsCard(page);
  await expect(card).toBeVisible();
  await expect(card).toContainText(SEED.office.property);
  await expect(card).toContainText(SEED.office.model);
  await expect(card).toContainText('dashboard-queue-check');

  // Scoped to the one row this test posted: several pending proposals can
  // land on the same model at once (this suite's own provenance tests leave
  // a couple behind by design), each rendering a link with the same
  // property-and-model text, so finding "the" link by that text alone would
  // be ambiguous. The row itself, found by this test's own unique source
  // name, is not.
  const row = card.locator('li', { hasText: 'dashboard-queue-check' });
  await row.getByRole('link').click();
  await expect(page).toHaveURL(/\/models\/[0-9a-f-]+\/provenance/);
  await expect(page.locator('.proposal', { hasText: 'dashboard-queue-check' })).toBeVisible();

  await decide(page, modelId, 'dashboard-queue-check');
});

test('drops off the dashboard once decided', async ({ page }) => {
  const modelId = await officeModelId(page);
  await propose(page, modelId, 'valuation.discountRate', '0.091', 'dashboard-drop-check');
  await decide(page, modelId, 'dashboard-drop-check');

  await page.goto('/');
  // Absence is checked as specific text, not as the whole card being gone:
  // other pending proposals this suite's own provenance tests leave behind
  // by design can legitimately keep the card on the page.
  await expect(page.getByText('dashboard-drop-check')).toHaveCount(0);
});

test('is accessible with a decision pending', async ({ page }) => {
  const modelId = await officeModelId(page);
  await propose(page, modelId, 'vacancy.creditLossRate', '0.02', 'dashboard-axe-check');

  await page.goto('/');
  await expect(page.getByText('dashboard-axe-check')).toBeVisible();

  const { violations } = await new AxeBuilder({ page }).withTags(STANDARD).analyze();
  const summary = violations.map(
    (violation) =>
      `${violation.id} (${violation.impact ?? 'unknown'}): ${violation.help}\n` +
      violation.nodes.map((node) => `      ${node.target.join(' ')}`).join('\n'),
  );
  expect(summary, summary.join('\n')).toEqual([]);

  await decide(page, modelId, 'dashboard-axe-check');
});

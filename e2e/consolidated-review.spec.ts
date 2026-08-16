import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { SEED, sessionFile } from './roles.js';

/**
 * The consolidated Review screen: status, health warnings, what changed and
 * comments, together instead of spread across the Versions, Health and
 * Review tabs. Each card reads the same endpoint its old, separate tab
 * already used, so these tests only have to prove the screen actually pulls
 * them together and that the approval workflow, moved off Versions, does
 * not leave a stray copy behind.
 */

test.use({ storageState: sessionFile('owner') });

const HEADERS = { 'X-Requested-With': 'cre-platform' };
const STANDARD = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'];

async function officeModelId(page: Page): Promise<string> {
  await page.goto('/properties');
  await page.getByRole('link', { name: SEED.office.property }).click();
  await page.getByRole('link', { name: SEED.office.model }).click();
  await expect(page).toHaveURL(/\/models\/[0-9a-f-]+/);
  return /\/models\/([0-9a-f-]+)/.exec(page.url())?.[1] as string;
}

async function snapshot(page: Page, modelId: string, label: string): Promise<void> {
  const response = await page.request.post(`/api/v1/models/${modelId}/versions`, {
    headers: HEADERS,
    data: { label },
  });
  expect(response.status(), await response.text()).toBe(201);
}

/**
 * A fresh property and model, isolated from the shared seeded office model.
 * `e2e/versions.spec.ts` counts version rows on that shared model exactly,
 * so any test here that snapshots more than once needs its own model rather
 * than risk making that count wrong for a test file this one has nothing to
 * do with.
 */
async function isolatedModel(page: Page): Promise<string> {
  const property = await page.request.post('/api/v1/properties', {
    headers: HEADERS,
    data: {
      name: `Consolidated review check ${Date.now()}`,
      propertyType: 'office',
      rentableArea: '50000',
    },
  });
  expect(property.status(), await property.text()).toBe(201);
  const propertyId = ((await property.json()) as { property: { id: string } }).property.id;

  const model = await page.request.post('/api/v1/models', {
    headers: HEADERS,
    data: {
      propertyId,
      name: 'Base case',
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
  return ((await model.json()) as { model: { id: string } }).model.id;
}

test('pulls status, health and comments onto one screen', async ({ page }) => {
  await officeModelId(page);
  await page.getByRole('link', { name: 'Review' }).click();

  await expect(
    page.getByRole('heading', { name: 'Approval workflow', level: 2, exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole('heading', { name: 'Model health', level: 2, exact: true }),
  ).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Comments on this model' })).toBeVisible();
});

test('shows a real comparison of the two most recent versions, not a manual pick', async ({
  page,
}) => {
  const modelId = await isolatedModel(page);
  await snapshot(page, modelId, 'Review screen check A');
  await snapshot(page, modelId, 'Review screen check B');

  await page.goto(`/models/${modelId}/review`);
  await expect(page.getByRole('heading', { name: /^v\d+ → v\d+$/ })).toBeVisible({
    timeout: 30_000,
  });
  await expect(page.getByRole('heading', { name: 'What was edited', exact: true })).toBeVisible();
});

test('the approval workflow moved off the Versions tab, not duplicated onto it', async ({
  page,
}) => {
  await officeModelId(page);
  await page.getByRole('link', { name: 'Versions' }).click();
  await expect(
    page.getByRole('heading', { name: 'Versions', level: 2, exact: true }),
  ).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Approval workflow' })).toHaveCount(0);
});

test('is accessible with a real version comparison rendered', async ({ page }) => {
  const modelId = await isolatedModel(page);
  await snapshot(page, modelId, 'Accessibility check A');
  await snapshot(page, modelId, 'Accessibility check B');

  await page.goto(`/models/${modelId}/review`);
  await expect(page.getByRole('heading', { name: /^v\d+ → v\d+$/ })).toBeVisible({
    timeout: 30_000,
  });

  const { violations } = await new AxeBuilder({ page }).withTags(STANDARD).analyze();
  const summary = violations.map(
    (violation) =>
      `${violation.id} (${violation.impact ?? 'unknown'}): ${violation.help}\n` +
      violation.nodes.map((node) => `      ${node.target.join(' ')}`).join('\n'),
  );
  expect(summary, summary.join('\n')).toEqual([]);
});

/**
 * Found by a repository-wide correctness audit: every approval-workflow
 * button (Submit, Approve, Reject, Publish, Withdraw, Archive) was gated
 * only by `model:read` — a capability nearly every role has — instead of
 * the transition-specific capability
 * (`packages/domain-models/src/permissions.ts`'s own `TRANSITIONS` table,
 * the same table `POST /models/:id/transition` enforces server-side) each
 * button actually requires. An analyst has `model:submit` but not
 * `model:approve`, so on a model awaiting analyst review they would see
 * both "Send to manager review" (real) and "Return to draft" (`model
 * :approve`, which they lack) as equally clickable — a button that does
 * nothing but a rejected request when pressed.
 */
test.describe('as an analyst without approval capability', () => {
  test.use({ storageState: sessionFile('analyst') });

  test('sees only the transition it can actually perform enabled', async ({ page }) => {
    const modelId = await isolatedModel(page);
    // `model:submit` is exactly the capability this transition requires, and
    // exactly what the analyst role holds -- this call is the same "Submit
    // for analyst review" action the UI itself would perform.
    const submitted = await page.request.post(`/api/v1/models/${modelId}/transition`, {
      headers: HEADERS,
      data: { to: 'analyst_review' },
    });
    expect(submitted.status(), await submitted.text()).toBe(200);

    await page.goto(`/models/${modelId}/review`);
    await expect(page.getByRole('heading', { name: 'Approval workflow' })).toBeVisible();

    // Real transition this role can make: enabled.
    await expect(page.getByRole('button', { name: 'Send to manager review' })).toBeEnabled();

    // "Return to draft" from analyst_review requires `model:approve`
    // (`TRANSITIONS` in permissions.ts), which the analyst role does not
    // hold. Before the fix this was enabled, because every button shared
    // the same `model:read` gate.
    const returnToDraft = page.getByRole('button', { name: 'Return to draft' });
    await expect(returnToDraft).toBeDisabled();
    await expect(returnToDraft).toHaveAttribute(
      'title',
      'You do not have permission to make this change.',
    );
  });
});

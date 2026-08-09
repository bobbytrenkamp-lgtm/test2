import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { SEED, sessionFile } from './roles.js';

test.use({ storageState: sessionFile('owner') });

/**
 * Importing structured assumptions from a Claude Skill's extraction.
 *
 * The contract and the analyzer are tested at the API and in
 * `packages/domain-models`. What the browser has to prove is the part that
 * cannot be asserted from a payload: that pasting and analyzing never writes
 * anything, that the review table shows current-vs-extracted the way an
 * analyst can act on, that a rejected paste keeps the text so nothing is
 * retyped, and that applying actually moves the model and says what changed.
 */

const HEADERS = { 'X-Requested-With': 'cre-platform' };

async function industrialModelId(page: Page): Promise<string> {
  await page.goto('/properties');
  await page.getByRole('link', { name: SEED.industrial.property }).click();
  await page.getByRole('link', { name: SEED.industrial.model }).click();
  await expect(page).toHaveURL(/\/models\/[0-9a-f-]+/);
  const match = /\/models\/([0-9a-f-]+)/.exec(page.url());
  return match?.[1] as string;
}

async function readModel(page: Page, modelId: string): Promise<Record<string, unknown>> {
  const response = await page.request.get(`/api/v1/models/${modelId}`, { headers: HEADERS });
  return (await response.json()).model as Record<string, unknown>;
}

async function restore(
  page: Page,
  modelId: string,
  fields: Record<string, unknown>,
): Promise<void> {
  const response = await page.request.patch(`/api/v1/models/${modelId}`, {
    headers: HEADERS,
    data: fields,
  });
  expect(response.ok(), await response.text()).toBe(true);
}

/** A well-formed document a browser test can paste, with one distinguishing target. */
function pasteFor(documentName: string, saleCostPercent: string): string {
  return JSON.stringify({
    format: 'cre-assumption-import',
    version: 1,
    source: { kind: 'imported', system: 'Claude Skill', documentName },
    assumptions: [
      {
        target: 'valuation.saleCostPercent',
        value: saleCostPercent,
        valueType: 'decimal',
        unit: 'rate',
        displayValue: `${Number(saleCostPercent) * 100}%`,
        confidence: 0.93,
        extraction: { method: 'explicit' },
        evidence: [{ page: 6, section: 'Disposition Assumptions', label: 'Sale Costs', sourceValue: '2.25%' }],
      },
    ],
  });
}

test('analyzing changes nothing until an assumption is applied', async ({ page }) => {
  const modelId = await industrialModelId(page);
  const before = await readModel(page, modelId);

  await page.goto(`/models/${modelId}/assumption-import`);
  await page.getByLabel('Pasted output').fill(pasteFor('untouched-check.pdf', '0.0225'));
  await page.getByRole('button', { name: 'Analyze' }).click();

  await expect(page.getByText(/1 assumption found/)).toBeVisible();
  await expect(page.locator('tr', { hasText: 'Sale cost' })).toBeVisible();

  const after = await readModel(page, modelId);
  expect(Number(after.sale_cost_percent)).toBeCloseTo(Number(before.sale_cost_percent), 8);
  expect(after.version).toBe(before.version);
});

test('shows current, extracted and the difference on the same row', async ({ page }) => {
  const modelId = await industrialModelId(page);
  const before = await readModel(page, modelId);
  const currentPercent = Number(before.sale_cost_percent);
  // A value guaranteed different from whatever the seed holds today.
  const extracted = (currentPercent + 0.01).toFixed(4);

  await page.goto(`/models/${modelId}/assumption-import`);
  await page.getByLabel('Pasted output').fill(pasteFor('display-check.pdf', extracted));
  await page.getByRole('button', { name: 'Analyze' }).click();

  const row = page.locator('tr', { hasText: 'Sale cost' });
  await expect(row).toBeVisible();
  await expect(row.locator('.badge', { hasText: 'Changed' })).toBeVisible();
  await expect(row).toContainText('bps');
});

test('a malformed paste explains itself and keeps the text', async ({ page }) => {
  const modelId = await industrialModelId(page);
  await page.goto(`/models/${modelId}/assumption-import`);

  const textarea = page.getByLabel('Pasted output');
  await textarea.fill('{ this is not json');
  await page.getByRole('button', { name: 'Analyze' }).click();

  await expect(page.getByRole('alert')).toContainText('not valid JSON');
  // Nothing was cleared. Retyping a paste an analyst already made would be
  // exactly the kind of lost work this contract exists to avoid.
  await expect(textarea).toHaveValue('{ this is not json');
});

test('applying writes the model, recalculates, and shows what changed', async ({ page }) => {
  const modelId = await industrialModelId(page);
  const before = await readModel(page, modelId);
  const original = String(before.sale_cost_percent ?? '0');
  const extracted = (Number(original) + 0.015).toFixed(4);

  await page.goto(`/models/${modelId}/assumption-import`);
  await page.getByLabel('Pasted output').fill(pasteFor('acceptance-check.pdf', extracted));
  await page.getByRole('button', { name: 'Analyze' }).click();

  const row = page.locator('tr', { hasText: 'Sale cost' });
  await expect(row).toBeVisible();
  await row.getByRole('checkbox').check();

  await page.getByRole('button', { name: /^Apply 1 assumption$/ }).click();
  await expect(page.getByRole('heading', { name: 'Applied' })).toBeVisible();
  await expect(page.getByText(/1 assumption written to the model/)).toBeVisible();

  const after = await readModel(page, modelId);
  expect(Number(after.sale_cost_percent)).toBeCloseTo(Number(extracted), 6);

  await restore(page, modelId, { saleCostPercent: original });
  expect(Number((await readModel(page, modelId)).sale_cost_percent)).toBeCloseTo(
    Number(original),
    8,
  );
});

test('a conflicting paste is shown, not silently resolved', async ({ page }) => {
  const modelId = await industrialModelId(page);
  const paste = JSON.stringify({
    format: 'cre-assumption-import',
    version: 1,
    source: { kind: 'imported', system: 'Claude Skill', documentName: 'conflict-check.pdf' },
    assumptions: [
      {
        target: 'valuation.discountRate',
        value: '0.08',
        valueType: 'decimal',
        evidence: [{ page: 5 }],
      },
      {
        target: 'valuation.discountRate',
        value: '0.09',
        valueType: 'decimal',
        evidence: [{ page: 41 }],
      },
    ],
  });

  await page.goto(`/models/${modelId}/assumption-import`);
  await page.getByLabel('Pasted output').fill(paste);
  await page.getByRole('button', { name: 'Analyze' }).click();

  const row = page.locator('tr', { hasText: 'Discount rate' });
  await expect(row.locator('.badge', { hasText: 'Conflict' })).toBeVisible();
  // A conflict is never selectable: there is no checkbox to apply it with.
  await expect(row.getByRole('checkbox')).toHaveCount(0);

  await row.click();
  await expect(page.getByText('Choose which is correct by hand')).toBeVisible();
});

test('is accessible', async ({ page }) => {
  const modelId = await industrialModelId(page);
  await page.goto(`/models/${modelId}/assumption-import`);
  await page.getByLabel('Pasted output').fill(pasteFor('axe-check.pdf', '0.03'));
  await page.getByRole('button', { name: 'Analyze' }).click();
  await expect(page.locator('tr', { hasText: 'Sale cost' })).toBeVisible();

  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .analyze();
  expect(
    results.violations.map((violation) => `${violation.id}: ${violation.help}`),
    results.violations.map((violation) => violation.id).join(', '),
  ).toEqual([]);
});

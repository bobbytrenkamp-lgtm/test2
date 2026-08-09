import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { SEED, sessionFile } from './roles.js';

test.use({ storageState: sessionFile('owner') });

/**
 * Proposals from outside the platform, and the decision on each.
 *
 * The contract itself is tested at the API. What the browser has to prove is
 * the part that cannot be asserted from a payload: that an analyst sees the
 * proposed number *beside* their own, that nothing moves until they choose, and
 * that choosing to keep their own is as available and as final as accepting.
 *
 * The last point is a design claim, not a nicety. If the screen presents the
 * external number as the answer and the analyst's as the thing to be corrected,
 * the tool has replaced their judgement while appearing to ask for it.
 */

const HEADERS = { 'X-Requested-With': 'cre-platform' };

/** The model these tests work against, resolved once from the seeded name. */
async function officeModelId(page: Page): Promise<string> {
  await page.goto('/properties');
  await page.getByRole('link', { name: SEED.office.property }).click();
  await page.getByRole('link', { name: SEED.office.model }).click();
  await expect(page).toHaveURL(/\/models\/[0-9a-f-]+/);
  const match = /\/models\/([0-9a-f-]+)/.exec(page.url());
  return match?.[1] as string;
}

/**
 * Posts proposals the way an outside system would.
 *
 * Through the real endpoint with the real session, so the test exercises the
 * contract rather than a fixture. Every proposal a test posts names its own
 * source, so one test's proposals never supersede another's.
 */
async function propose(page: Page, modelId: string, proposals: unknown[]): Promise<void> {
  const response = await page.request.post(`/api/v1/models/${modelId}/assumption-proposals`, {
    headers: HEADERS,
    data: { proposals },
  });
  expect(response.status(), await response.text()).toBe(201);
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

test('shows the proposal beside the underwritten number, with the difference', async ({ page }) => {
  const modelId = await officeModelId(page);
  await propose(page, modelId, [
    {
      target: 'valuation.terminalCapRate',
      value: '0.0545',
      sourceKind: 'market_data',
      sourceName: 'display-check',
      confidence: 0.81,
      evidence: { comparables: 11, submarket: 'Wake County, NC' },
      notes: 'Eleven office trades in the trailing two quarters.',
    },
  ]);

  await page.goto(`/models/${modelId}/provenance`);
  const proposal = page.locator('.proposal', { hasText: 'display-check' });
  await expect(proposal).toBeVisible();

  // All three, together: the number in the model, the number proposed, and the
  // gap. A screen that showed only the proposal would be asking for a decision
  // while hiding half of what it is between.
  await expect(proposal.getByText('Underwritten')).toBeVisible();
  await expect(proposal.getByText('display-check proposes')).toBeVisible();
  await expect(proposal.getByText('Difference')).toBeVisible();
  await expect(proposal).toContainText('5.45%');

  // Provenance a reader can weigh: who said it, how sure they were, and what
  // they were looking at.
  await expect(proposal).toContainText('81%');
  // `summary` is a disclosure, not a button — the accessibility tree exposes it
  // as generic, so it is reached by element rather than by role.
  await proposal.locator('summary').click();
  await expect(proposal.getByText('Wake County, NC')).toBeVisible();
});

test('changes nothing until somebody decides', async ({ page }) => {
  /*
   * The promise the whole feature rests on. A source reported an exit yield
   * three hundred basis points away from the underwriting and the model is
   * exactly as its analyst left it.
   */
  const modelId = await officeModelId(page);
  const before = await readModel(page, modelId);

  await propose(page, modelId, [
    {
      target: 'valuation.terminalCapRate',
      value: '0.0300',
      sourceKind: 'market_data',
      sourceName: 'untouched-check',
      evidence: {},
    },
  ]);

  await page.goto(`/models/${modelId}/provenance`);
  await expect(page.locator('.proposal', { hasText: 'untouched-check' })).toBeVisible();

  const after = await readModel(page, modelId);
  expect(Number(after.terminal_cap_rate)).toBeCloseTo(Number(before.terminal_cap_rate), 8);
  expect(after.version).toBe(before.version);
});

test('keeping your own number is recorded, not discarded', async ({ page }) => {
  /*
   * "We saw the market number and stayed at 6.00%" is a defensible position and
   * the answer to the question a reviewer actually asks. It only exists if the
   * tool keeps it.
   */
  const modelId = await officeModelId(page);
  const before = await readModel(page, modelId);

  await propose(page, modelId, [
    {
      target: 'vacancy.creditLossRate',
      value: '0.035',
      sourceKind: 'market_data',
      sourceName: 'rejection-check',
      evidence: {},
    },
  ]);

  await page.goto(`/models/${modelId}/provenance`);
  const proposal = page.locator('.proposal', { hasText: 'rejection-check' });
  await proposal.getByLabel(/^Why, for/).fill('Our own collections history is better than this.');
  await proposal.getByRole('button', { name: /^Keep / }).click();

  await page.getByRole('button', { name: /^Show \d/ }).click();
  const decided = page.locator('.proposal', { hasText: 'rejection-check' });
  await expect(decided.getByText('Kept your own')).toBeVisible();
  await expect(decided).toContainText('collections history');

  const after = await readModel(page, modelId);
  expect(Number(after.credit_loss_rate)).toBeCloseTo(Number(before.credit_loss_rate), 8);
});

test('accepting applies the value and says so', async ({ page }) => {
  const modelId = await officeModelId(page);
  const before = await readModel(page, modelId);
  const original = String(before.credit_loss_rate ?? '0');

  await propose(page, modelId, [
    {
      target: 'vacancy.creditLossRate',
      value: '0.0125',
      sourceKind: 'historical',
      sourceName: 'acceptance-check',
      evidence: {},
    },
  ]);

  await page.goto(`/models/${modelId}/provenance`);
  const proposal = page.locator('.proposal', { hasText: 'acceptance-check' });
  await proposal.getByRole('button', { name: /^Apply / }).click();

  await page.getByRole('button', { name: /^Show \d/ }).click();
  await expect(
    page.locator('.proposal', { hasText: 'acceptance-check' }).locator('.badge', {
      hasText: 'Applied',
    }),
  ).toBeVisible();

  // Applied means applied: the model itself moved, not a status field.
  const after = await readModel(page, modelId);
  expect(Number(after.credit_loss_rate)).toBeCloseTo(0.0125, 8);

  // Put the seed back. This suite shares one database and later specs assert on
  // this model's returns; leaving a credit loss rate behind would make them
  // fail somewhere that has nothing to do with provenance.
  await restore(page, modelId, { creditLossRate: original });
  expect(Number((await readModel(page, modelId)).credit_loss_rate)).toBeCloseTo(
    Number(original),
    8,
  );
});

test('a proposal it cannot apply is kept, and the button says why', async ({ page }) => {
  const modelId = await officeModelId(page);
  await propose(page, modelId, [
    {
      target: 'dataCentre.powerCostPerKw',
      value: '0.11',
      sourceKind: 'market_data',
      sourceName: 'gap-check',
      evidence: {},
      notes: 'Reported for the submarket; no equivalent assumption in the model.',
    },
  ]);

  await page.goto(`/models/${modelId}/provenance`);
  const proposal = page.locator('.proposal', { hasText: 'gap-check' });
  // Information about something the product does not model is still
  // information. Dropping it silently would be the worst of the options.
  await expect(proposal).toContainText('does not model');
  await expect(proposal.getByRole('button', { name: /^Apply / })).toBeDisabled();
  // Rejecting is still open: the decision is the analyst's view, not a question
  // about what the software can do.
  await expect(proposal.getByRole('button', { name: /^Keep / })).toBeEnabled();
});

test('is accessible', async ({ page }) => {
  const modelId = await officeModelId(page);
  await propose(page, modelId, [
    {
      target: 'valuation.discountRate',
      value: '0.0875',
      sourceKind: 'recommended',
      sourceName: 'axe-check',
      evidence: { note: 'Rendered as given.' },
    },
  ]);
  await page.goto(`/models/${modelId}/provenance`);
  await expect(page.locator('.proposal', { hasText: 'axe-check' })).toBeVisible();

  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .analyze();
  expect(
    results.violations.map((violation) => `${violation.id}: ${violation.help}`),
    results.violations.map((violation) => violation.id).join(', '),
  ).toEqual([]);
});

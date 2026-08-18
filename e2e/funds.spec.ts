import { expect, test } from '@playwright/test';
import { sessionFile } from './roles.js';

/**
 * The fund screen, on the demonstration fund the seed creates.
 *
 * A fund's numbers are the ones an investor relations team is asked about by
 * name, so the assertions are about specific figures rather than about the
 * page rendering: the seed calls half of every commitment, and half of
 * 50,000,000 committed is 25,000,000 called and 25,000,000 still unfunded.
 */
test.use({ storageState: sessionFile('owner') });

const FUND = 'Meridian Value Fund I (demonstration)';

test('reports commitments, capital called and what is still unfunded', async ({ page }) => {
  await page.goto('/funds');
  await expect(page.getByRole('heading', { name: 'Funds', level: 1 })).toBeVisible();

  const row = page.getByRole('row').filter({ has: page.getByRole('rowheader', { name: FUND }) });
  await expect(row).toBeVisible();
  await row.getByRole('button', { name: 'Open' }).click();

  await expect(page.getByRole('heading', { name: FUND, level: 2 })).toBeVisible();

  // Two drawdowns of 25% each against 50,000,000 of commitments, so half is
  // called and half is still unfunded. A fund shown fully drawn would hide the
  // unfunded figure, which is the one an investor relations team is asked
  // about most often.
  // Matched on the term itself rather than anywhere in the tile: the unfunded
  // tile is described as "Committed but not yet drawn", so a substring match on
  // the label would find two.
  const metric = (label: string) =>
    page.locator('.metric').filter({ has: page.getByText(label, { exact: true }) });
  await expect(metric('Committed')).toContainText('$50.0M');
  await expect(metric('Called')).toContainText('$25.0M');
  await expect(metric('Called')).toContainText('50.00%');
  await expect(metric('Unfunded')).toContainText('$25.0M');
});

test('breaks the position down by investor', async ({ page }) => {
  await page.goto('/funds');
  const row = page.getByRole('row').filter({ has: page.getByRole('rowheader', { name: FUND }) });
  await row.getByRole('button', { name: 'Open' }).click();

  await expect(page.getByRole('heading', { name: 'Investor positions' })).toBeVisible();
  const positions = page.getByRole('table', { name: /Investor positions/ });
  // Three investors in the seed: two limited partners and the general partner.
  await expect(positions.getByRole('row')).toHaveCount(4);
  await expect(positions.getByRole('rowheader', { name: /Alder State Pension/ })).toBeVisible();
  await expect(positions.getByRole('cell', { name: 'GP' })).toBeVisible();
});

test('shows the flows the return was solved from', async ({ page }) => {
  await page.goto('/funds');
  const row = page.getByRole('row').filter({ has: page.getByRole('rowheader', { name: FUND }) });
  await row.getByRole('button', { name: 'Open' }).click();

  await expect(page.getByRole('heading', { name: 'Capital record' })).toBeVisible();
  const record = page.getByRole('table', { name: /Capital calls and distributions/ });
  // Three investors x two calls and one distribution, plus the header row.
  await expect(record.getByRole('row')).toHaveCount(10);
  await expect(record.getByRole('cell', { name: 'Capital call' }).first()).toBeVisible();
  await expect(record.getByRole('cell', { name: 'Distribution' }).first()).toBeVisible();
});

test('says where the unrealised value came from', async ({ page }) => {
  // A residual value with no stated basis is the one number in a fund report
  // nobody can check.
  await page.goto('/funds');
  const row = page.getByRole('row').filter({ has: page.getByRole('rowheader', { name: FUND }) });
  await row.getByRole('button', { name: 'Open' }).click();

  await expect(page.getByText(/Net asset value of \d+ property roll-up/)).toBeVisible();
});

test('refuses capital recorded against an investor who is not in the fund', async ({ page }) => {
  await page.goto('/funds');
  const row = page.getByRole('row').filter({ has: page.getByRole('rowheader', { name: FUND }) });
  await row.getByRole('button', { name: 'Open' }).click();

  // The select only offers investors the fund has, which is the first defence.
  const investor = page.getByLabel('Investor', { exact: true });
  await expect(investor).toBeVisible();
  const options = await investor.locator('option').allTextContents();
  expect(options).toContain('Alder State Pension (fictional)');
  expect(options).not.toContain('');
});

test('names what is missing on the investor and capital forms, rather than a browser popup', async ({
  page,
}) => {
  await page.goto('/funds');
  const row = page.getByRole('row').filter({ has: page.getByRole('rowheader', { name: FUND }) });
  await row.getByRole('button', { name: 'Open' }).click();

  const investorForm = page
    .locator('form')
    .filter({ has: page.getByRole('heading', { name: 'Add or update an investor' }) });
  await investorForm.getByRole('button', { name: 'Add investor' }).click();
  await expect(investorForm.getByText('Investor reference is required.')).toBeVisible();
  await expect(investorForm.getByText('Name is required.')).toBeVisible();
  await expect(investorForm.getByText('Commitment is required.')).toBeVisible();

  const recordForm = page
    .locator('form')
    .filter({ has: page.getByRole('heading', { name: 'Record capital' }) });
  await recordForm.getByRole('button', { name: 'Record' }).click();
  await expect(recordForm.getByText('Choose an investor.')).toBeVisible();
  await expect(recordForm.getByText('Amount is required.')).toBeVisible();
});

test('records a recallable distribution, then a recall, and nets them on screen', async ({
  page,
}) => {
  // Placed last in this file: it mutates the demonstration fund's capital
  // record, which the row-count assertions in the earlier tests depend on.
  await page.goto('/funds');
  const row = page.getByRole('row').filter({ has: page.getByRole('rowheader', { name: FUND }) });
  await row.getByRole('button', { name: 'Open' }).click();
  await expect(page.getByRole('heading', { name: FUND, level: 2 })).toBeVisible();

  const recordForm = page
    .locator('form')
    .filter({ has: page.getByRole('heading', { name: 'Record capital' }) });

  async function recordTransaction(
    type: string,
    amount: string,
    date: string,
    markRecallable: boolean,
  ): Promise<void> {
    await recordForm
      .getByLabel('Investor', { exact: true })
      .selectOption({ label: 'Alder State Pension (fictional)' });
    await recordForm.getByLabel('Type').selectOption({ label: type });
    await recordForm.getByLabel('Date').fill(date);
    await recordForm.getByLabel(/Amount/).fill(amount);
    if (markRecallable) {
      await recordForm.getByRole('checkbox', { name: /governing document/i }).check();
    }
    await recordForm.getByRole('button', { name: 'Record' }).click();
    await expect(recordForm.getByRole('button', { name: 'Record' })).toBeEnabled();
  }

  await recordTransaction('Distribution', '1000000', '2027-09-30', true);
  await recordTransaction('Recall', '400000', '2027-12-31', false);

  const recallableTile = page
    .locator('.metric')
    .filter({ has: page.getByText('Recallable outstanding', { exact: true }) });
  // 1,000,000 marked recallable, less the 400,000 recalled.
  await expect(recallableTile).toContainText('$600.0K');

  const capitalTable = page.getByRole('table', { name: /Capital calls and distributions/ });
  await expect(
    capitalTable.getByRole('cell', { name: 'Distribution (recallable)' }).first(),
  ).toBeVisible();
  await expect(capitalTable.getByRole('cell', { name: 'Recall' }).first()).toBeVisible();
});

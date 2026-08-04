import { expect, test, type Page } from '@playwright/test';
import { SEED, sessionFile } from './roles.js';

/**
 * What a role may do decides what it is shown.
 *
 * The server is the authority and re-checks every route, so hiding a control is
 * a courtesy rather than a security boundary — but it is the courtesy that
 * stops someone filling in a form for ten minutes only to be refused. These
 * tests assert both directions: a reviewer loses the controls that write, and
 * keeps the ones their role genuinely carries. Asserting only the absences
 * would pass just as well for a screen that showed a reviewer nothing at all.
 */

async function openOfficeModel(page: Page): Promise<void> {
  await page.goto('/properties');
  await page.getByRole('link', { name: SEED.office.property }).click();
  await page.getByRole('link', { name: SEED.office.model }).click();
  await expect(page.getByRole('heading', { name: SEED.office.model, level: 1 })).toBeVisible();
}

test.describe('an organization owner', () => {
  test.use({ storageState: sessionFile('owner') });

  test('can create properties and edit the rent roll', async ({ page }) => {
    await page.goto('/properties');
    await expect(page.getByRole('button', { name: 'New property' })).toBeVisible();

    await openOfficeModel(page);
    await expect(page.getByRole('button', { name: 'Calculate' })).toBeVisible();

    await page.getByRole('link', { name: 'Rent roll' }).click();
    await expect(page.getByRole('button', { name: 'Add lease' })).toBeVisible();
  });
});

test.describe('a reviewer', () => {
  test.use({ storageState: sessionFile('reviewer') });

  test('sees the role they hold', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByText('reviewer', { exact: true })).toBeVisible();
  });

  test('cannot create a property', async ({ page }) => {
    await page.goto('/properties');
    await expect(page.getByRole('heading', { name: 'Properties', level: 1 })).toBeVisible();
    await expect(page.getByRole('button', { name: 'New property' })).toBeHidden();
  });

  test('cannot create a model but can still calculate one', async ({ page }) => {
    await page.goto('/properties');
    await page.getByRole('link', { name: SEED.office.property }).click();
    await expect(page.getByRole('button', { name: 'New model' })).toBeHidden();

    await page.getByRole('link', { name: SEED.office.model }).click();
    // A reviewer holds model:calculate: reviewing a valuation means being able
    // to re-run it, not merely to look at someone else's output.
    await expect(page.getByRole('button', { name: 'Calculate' })).toBeVisible();
  });

  test('gets a read-only rent roll', async ({ page }) => {
    await openOfficeModel(page);
    await page.getByRole('link', { name: 'Rent roll' }).click();

    await expect(page.getByRole('button', { name: 'Add lease' })).toBeHidden();
    await expect(page.getByRole('button', { name: 'Edit' })).toHaveCount(0);
    await expect(page.getByText('read-only')).toBeVisible();
  });
});

test.describe('an analyst', () => {
  test.use({ storageState: sessionFile('analyst') });

  test('can write models but cannot manage the organization', async ({ page }) => {
    await page.goto('/properties');
    await expect(page.getByRole('button', { name: 'New property' })).toBeVisible();

    await openOfficeModel(page);
    await page.getByRole('link', { name: 'Rent roll' }).click();
    await expect(page.getByRole('button', { name: 'Add lease' })).toBeVisible();

    // Audit history requires audit:read, which an analyst does not hold. The
    // link is in the primary navigation for everyone, so this proves the server
    // refuses rather than the interface merely hiding the door.
    await page.goto('/audit');
    await expect(page.getByRole('alert')).toBeVisible();
  });
});

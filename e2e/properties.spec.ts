import { expect, test } from '@playwright/test';
import { sessionFile } from './roles.js';

test.use({ storageState: sessionFile('owner') });

/**
 * The New property form: creation, and what happens when Name is left blank.
 *
 * Name is the form's only required field, and it used to be a bare `required`
 * attribute — the browser's own "Please fill out this field" popup, which
 * disappears if the person looks away and names nothing when they look back.
 * `noValidate` plus the platform's own inline `Field` error fixes that; the
 * point of the second test is that the specific message actually appears.
 */

test('creates a property and lands on its detail page', async ({ page }) => {
  await page.goto('/properties');
  await page.getByRole('button', { name: 'New property' }).click();

  const form = page
    .locator('form')
    .filter({ has: page.getByRole('heading', { name: 'New property' }) });
  await form.getByLabel('Name', { exact: true }).fill('E2E Validation Court');
  await form.getByLabel('Property type').selectOption('office');
  await form.getByLabel('Rentable area').fill('42000');

  await form.getByRole('button', { name: 'Create property' }).click();

  await expect(page.getByRole('heading', { name: 'E2E Validation Court', level: 1 })).toBeVisible();
});

test('names the missing field instead of a generic browser popup', async ({ page }) => {
  await page.goto('/properties');
  await page.getByRole('button', { name: 'New property' }).click();

  const form = page
    .locator('form')
    .filter({ has: page.getByRole('heading', { name: 'New property' }) });
  await form.getByRole('button', { name: 'Create property' }).click();

  await expect(form.getByText('Name is required.')).toBeVisible();
  // No navigation happened: the form is still on screen, and still empty.
  await expect(page.getByRole('heading', { name: 'New property' })).toBeVisible();

  await form.getByLabel('Name', { exact: true }).fill('E2E Second Attempt Tower');
  await form.getByRole('button', { name: 'Create property' }).click();
  await expect(
    page.getByRole('heading', { name: 'E2E Second Attempt Tower', level: 1 }),
  ).toBeVisible();
});

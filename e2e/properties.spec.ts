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

test('refuses a non-numeric rentable area instead of silently discarding it', async ({ page }) => {
  await page.goto('/properties');
  await page.getByRole('button', { name: 'New property' }).click();

  const form = page
    .locator('form')
    .filter({ has: page.getByRole('heading', { name: 'New property' }) });
  await form.getByLabel('Name', { exact: true }).fill('E2E Bad Area Plaza');
  // This used to feed `form.rentableArea || null` straight into the request —
  // text that isn't a number at all was sent as-is, which the server itself
  // then had to reject with a generic error, or (for `Number(...) || 0`
  // fields like Units) silently became 0 with nothing said about it.
  await form.getByLabel('Rentable area').fill('lots');

  await form.getByRole('button', { name: 'Create property' }).click();
  await expect(form.getByText('Rentable area must be a number.')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'New property' })).toBeVisible();
  // Every `Field` with an `error` marks its own control `aria-invalid`, not
  // just the error text itself — the same fix `SignIn.tsx` needed by hand,
  // but here for free from `Field` (apps/web/src/components.tsx).
  await expect(form.getByLabel('Rentable area')).toHaveAttribute('aria-invalid', 'true');

  await form.getByLabel('Rentable area').fill('42000');
  await form.getByRole('button', { name: 'Create property' }).click();
  await expect(page.getByRole('heading', { name: 'E2E Bad Area Plaza', level: 1 })).toBeVisible();
});

test('search narrows the list to a matching name, debounced but not lost', async ({ page }) => {
  await page.goto('/properties');
  await page.getByRole('button', { name: 'New property' }).click();
  const form = page
    .locator('form')
    .filter({ has: page.getByRole('heading', { name: 'New property' }) });
  await form.getByLabel('Name', { exact: true }).fill('E2E Search Findable Court');
  await form.getByRole('button', { name: 'Create property' }).click();
  await expect(
    page.getByRole('heading', { name: 'E2E Search Findable Court', level: 1 }),
  ).toBeVisible();

  await page.goto('/properties');
  // The search box does not fire a request on every keystroke — it waits for
  // typing to pause (`useDebouncedValue` in hooks.ts) — so this asserts the
  // eventual result, not an immediate one, which is exactly what a debounced
  // search should look like from the outside.
  await page.getByLabel('Search', { exact: true }).fill('Findable');
  await expect(page.getByRole('link', { name: 'E2E Search Findable Court' })).toBeVisible();

  await page.getByLabel('Search', { exact: true }).fill('No Such Property Exists At All');
  await expect(page.getByText('No properties match')).toBeVisible();
  await expect(page.getByRole('link', { name: 'E2E Search Findable Court' })).toBeHidden();
});

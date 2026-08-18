import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import { SEED, sessionFile } from './roles.js';

test.use({ storageState: sessionFile('owner') });

/**
 * The trail back out of a model.
 *
 * Nothing else on a model's own screen names the property it belongs to as a
 * link, or offers a click back to the properties list — only the header's own
 * org switcher orients the reader, and it scrolls out of view on any of the
 * longer tabs. This is the fix, and the point of the test is the click, not
 * just the text: each link has to land where it says it does.
 */
const STANDARD = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'];

test('names the property and links back to it from a model, and back to the list from the property', async ({
  page,
}) => {
  await page.goto('/properties');
  await page.getByRole('link', { name: SEED.office.property }).click();
  await expect(page.getByRole('heading', { name: SEED.office.property, level: 1 })).toBeVisible();

  const propertyBreadcrumb = page.getByRole('navigation', { name: 'Breadcrumb' });
  await expect(propertyBreadcrumb.getByRole('link', { name: 'All properties' })).toBeVisible();
  await expect(propertyBreadcrumb.getByText(SEED.office.property, { exact: true })).toBeVisible();

  await page.getByRole('link', { name: SEED.office.model }).click();
  await expect(page.getByRole('heading', { name: SEED.office.model, level: 1 })).toBeVisible();

  const modelBreadcrumb = page.getByRole('navigation', { name: 'Breadcrumb' });
  await expect(modelBreadcrumb.getByRole('link', { name: 'All properties' })).toBeVisible();
  await expect(modelBreadcrumb.getByRole('link', { name: SEED.office.property })).toBeVisible();
  await expect(modelBreadcrumb.getByText(SEED.office.model, { exact: true })).toBeVisible();

  // The click, not just the text: each breadcrumb link has to actually land
  // where it names.
  await modelBreadcrumb.getByRole('link', { name: SEED.office.property }).click();
  await expect(page.getByRole('heading', { name: SEED.office.property, level: 1 })).toBeVisible();

  await propertyBreadcrumb.getByRole('link', { name: 'All properties' }).click();
  await expect(page.getByRole('heading', { name: 'Properties', level: 1 })).toBeVisible();
});

test('is accessible on both the property and the model screen', async ({ page }) => {
  await page.goto('/properties');
  await page.getByRole('link', { name: SEED.office.property }).click();
  await expect(page.getByRole('navigation', { name: 'Breadcrumb' })).toBeVisible();

  const propertyViolations = (await new AxeBuilder({ page }).withTags(STANDARD).analyze())
    .violations;
  expect(propertyViolations, JSON.stringify(propertyViolations, null, 2)).toEqual([]);

  await page.getByRole('link', { name: SEED.office.model }).click();
  await expect(page.getByRole('navigation', { name: 'Breadcrumb' })).toBeVisible();

  const modelViolations = (await new AxeBuilder({ page }).withTags(STANDARD).analyze()).violations;
  expect(modelViolations, JSON.stringify(modelViolations, null, 2)).toEqual([]);
});

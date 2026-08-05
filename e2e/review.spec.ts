import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import { SEED, sessionFile } from './roles.js';

/**
 * The review conversation on a model.
 *
 * The approval workflow could record that a model was sent back but not why.
 * These drive the path a reviewer actually takes — open the model, say what is
 * wrong, and see it waiting for the analyst.
 */
const STANDARD = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'];

async function openReview(page: import('@playwright/test').Page): Promise<void> {
  await page.goto('/properties');
  await page.getByRole('link', { name: SEED.office.property }).click();
  await page.getByRole('link', { name: SEED.office.model }).click();
  await page.getByRole('link', { name: 'Review' }).click();
  await expect(page.getByRole('heading', { name: 'Comments on this model' })).toBeVisible();
}

test.describe('as a reviewer', () => {
  test.use({ storageState: sessionFile('reviewer') });

  test('records why a model was sent back, where the analyst will find it', async ({ page }) => {
    await openReview(page);

    const objection = `The exit cap rate is inside the market and nothing explains it (${Date.now()}).`;
    await page.getByLabel('Add a comment').fill(objection);
    await page.getByRole('button', { name: 'Post comment' }).click();

    await expect(page.getByText(objection)).toBeVisible({ timeout: 30_000 });
  });

  test('is accessible', async ({ page }) => {
    // The newest screen and the one with a free-text form, so the most likely
    // to reintroduce an unlabelled control.
    await openReview(page);
    const { violations } = await new AxeBuilder({ page }).withTags(STANDARD).analyze();
    const summary = violations.map(
      (violation) =>
        `${violation.id} (${violation.impact ?? 'unknown'}): ${violation.help}\n` +
        violation.nodes.map((node) => `      ${node.target.join(' ')}`).join('\n'),
    );
    expect(summary, summary.join('\n')).toEqual([]);
  });
});

test.describe('as the analyst who was criticised', () => {
  test.use({ storageState: sessionFile('analyst') });

  test('can read the objection but not dismiss it', async ({ page }) => {
    // The rule the whole feature rests on. If the person criticised could close
    // the criticism, the review would be decorative.
    await openReview(page);

    const comments = page.locator('.comment');
    await expect(comments.first()).toBeVisible({ timeout: 30_000 });

    // Their own comments can be resolved; someone else's cannot, so no Resolve
    // control is offered on the reviewer's.
    const reviewerComment = comments.filter({ hasText: 'exit cap rate' }).first();
    await expect(reviewerComment).toBeVisible();
    await expect(reviewerComment.getByRole('button', { name: 'Resolve' })).toHaveCount(0);
  });

  test('can answer it, and resolve their own', async ({ page }) => {
    await openReview(page);

    const reply = `Adjusted to 6.75% and noted the comparable set (${Date.now()}).`;
    await page.getByLabel('Add a comment').fill(reply);
    await page.getByRole('button', { name: 'Post comment' }).click();

    const own = page.locator('.comment').filter({ hasText: reply }).first();
    await expect(own).toBeVisible({ timeout: 30_000 });
    await own.getByRole('button', { name: 'Resolve' }).click();

    // Resolved comments leave the open list, because the open ones are the work.
    await expect(page.getByText(reply)).toBeHidden({ timeout: 30_000 });
    await page.getByLabel('Show resolved').check();
    await expect(page.getByText(reply)).toBeVisible();
  });
});

import { expect, test } from '@playwright/test';

/**
 * Sign-in's own field-invalid marking: only a genuine credentials rejection
 * says the email or password was actually wrong. A network failure or a
 * rate limit are real ApiErrors too, but they say nothing about what was
 * typed — mismarking either would misleadingly tell a screen-reader user
 * (via `aria-invalid`) that their credentials were wrong when they were not.
 *
 * `POST /api/v1/auth/login` is intercepted rather than driven for real: this
 * is about `SignIn.tsx`'s own error-handling logic, not the server's auth
 * behaviour, which `tests/mfa.test.ts` and `tests/rate-limiting.test.ts`
 * already cover against the real route.
 */
test.describe('signed out', () => {
  test.use({ storageState: { cookies: [], origins: [] } });

  test('a wrong password marks both fields invalid', async ({ page }) => {
    await page.route('**/api/v1/auth/login', async (route) => {
      await route.fulfill({
        status: 401,
        contentType: 'application/json',
        body: JSON.stringify({
          error: { code: 'INVALID_CREDENTIALS', message: 'That email or password is not correct.' },
        }),
      });
    });

    await page.goto('/');
    await page.getByLabel('Email address').fill('owner@example.invalid');
    await page.getByLabel('Password').fill('wrong-password');
    await page.getByRole('button', { name: 'Sign in' }).click();

    await expect(page.getByRole('alert')).toHaveText('That email or password is not correct.');
    await expect(page.getByLabel('Email address')).toHaveAttribute('aria-invalid', 'true');
    await expect(page.getByLabel('Password')).toHaveAttribute('aria-invalid', 'true');
  });

  test('a rate limit or an unreachable server does not mark either field invalid', async ({
    page,
  }) => {
    await page.route('**/api/v1/auth/login', async (route) => {
      await route.fulfill({
        status: 429,
        contentType: 'application/json',
        body: JSON.stringify({
          error: { code: 'RATE_LIMITED', message: 'Too many requests. Try again shortly.' },
        }),
      });
    });

    await page.goto('/');
    await page.getByLabel('Email address').fill('owner@example.invalid');
    await page.getByLabel('Password').fill('the-real-password');
    await page.getByRole('button', { name: 'Sign in' }).click();

    await expect(page.getByRole('alert')).toHaveText('Too many requests. Try again shortly.');
    // Neither field is a screen-reader-announced "invalid" for a failure that
    // says nothing about what was actually typed.
    await expect(page.getByLabel('Email address')).not.toHaveAttribute('aria-invalid', 'true');
    await expect(page.getByLabel('Password')).not.toHaveAttribute('aria-invalid', 'true');

    // A genuinely unreachable server (aborted request, not even an HTTP
    // response) goes through the same `else` branch by a different path —
    // `signIn()` throws before `cause instanceof ApiError` is even true.
    await page.unroute('**/api/v1/auth/login');
    await page.route('**/api/v1/auth/login', (route) => route.abort('failed'));
    await page.getByRole('button', { name: 'Sign in' }).click();

    await expect(page.getByRole('alert')).toHaveText('The server could not be reached. Try again.');
    await expect(page.getByLabel('Email address')).not.toHaveAttribute('aria-invalid', 'true');
    await expect(page.getByLabel('Password')).not.toHaveAttribute('aria-invalid', 'true');
  });
});

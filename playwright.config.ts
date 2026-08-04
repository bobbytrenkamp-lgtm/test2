import { defineConfig, devices } from '@playwright/test';

/**
 * End-to-end configuration.
 *
 * The suite drives a real browser against a real API and a real PostgreSQL
 * database, on the built bundle rather than the dev server. Everything it needs
 * runs locally: no hosted browser grid, no external service, no account. See
 * `docs/zero-cost-operation.md`.
 *
 * `pnpm test:e2e` prepares a dedicated database from the migrations and the
 * demonstration seed, then starts the API and a preview server for the browser
 * to talk to.
 */

const WEB_PORT = Number(process.env.E2E_WEB_PORT ?? 5174);
const API_PORT = Number(process.env.E2E_API_PORT ?? 4100);

export const DATABASE_URL =
  process.env.E2E_DATABASE_URL ?? 'postgres://cre:cre@127.0.0.1:5432/cre_platform_e2e';

export const BASE_URL = `http://127.0.0.1:${WEB_PORT}`;

export default defineConfig({
  testDir: './e2e',
  // Signing in is rate limited by the API, exactly as it should be. The suite
  // authenticates once per role in the setup project and reuses the session, so
  // parallel workers never race for the login route's budget.
  fullyParallel: false,
  workers: 1,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : [['list']],
  timeout: 60_000,
  expect: { timeout: 10_000 },

  use: {
    baseURL: BASE_URL,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'off',
  },

  projects: [
    { name: 'setup', testMatch: /auth\.setup\.ts$/ },
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
      dependencies: ['setup'],
      testIgnore: /auth\.setup\.ts$/,
    },
  ],

  webServer: [
    {
      // The database is rebuilt here rather than in a global setup hook because
      // Playwright starts the web servers first: the API's health check touches
      // the database, so the schema has to exist before it is asked. Chaining
      // the two also means every way of launching the suite — the pnpm script,
      // a bare `playwright test`, an editor's run button — starts from the same
      // known state.
      command: 'pnpm exec tsx e2e/prepare-database.ts && pnpm --filter @cre/api run start',
      url: `http://127.0.0.1:${API_PORT}/api/v1/health`,
      // Never inherit a server left over from an earlier run: it would be
      // talking to a database this run has just rebuilt underneath it.
      reuseExistingServer: false,
      timeout: 120_000,
      stdout: 'pipe',
      stderr: 'pipe',
      env: {
        NODE_ENV: 'test',
        DATABASE_URL,
        API_PORT: String(API_PORT),
        API_HOST: '127.0.0.1',
        WEB_ORIGIN: BASE_URL,
        E2E_DATABASE_URL: DATABASE_URL,
        SESSION_SECRET: 'end-to-end-session-secret-long-enough-for-the-validator',
        SESSION_COOKIE_SECURE: 'false',
        // The seed provides every account these tests use, so the open
        // registration path stays closed here as it would in production.
        ALLOW_SELF_REGISTRATION: 'false',
        STORAGE_DRIVER: 'local',
        AI_ASSISTANT_PROVIDER: 'none',
      },
    },
    {
      command: 'pnpm --filter @cre/web run build && pnpm --filter @cre/web run preview',
      url: BASE_URL,
      reuseExistingServer: false,
      timeout: 180_000,
      stdout: 'pipe',
      stderr: 'pipe',
      env: {
        API_ORIGIN: `http://127.0.0.1:${API_PORT}`,
      },
    },
  ],
});

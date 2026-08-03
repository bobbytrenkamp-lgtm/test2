import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['packages/**/*.test.ts', 'apps/**/*.test.ts', 'tests/**/*.test.ts'],
    exclude: ['**/node_modules/**', '**/dist/**'],
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
  resolve: {
    alias: {
      '@cre/domain-models': new URL('./packages/domain-models/src/index.ts', import.meta.url).pathname,
      '@cre/calculation-engine': new URL('./packages/calculation-engine/src/index.ts', import.meta.url).pathname,
      '@cre/database': new URL('./packages/database/src/index.ts', import.meta.url).pathname,
    },
  },
});

import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/node_modules/**',
      '**/coverage/**',
      '**/*.config.js',
      '**/*.config.ts',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/no-explicit-any': 'error',
      'no-console': ['warn', { allow: ['warn', 'error'] }],
      eqeqeq: ['error', 'always', { null: 'ignore' }],
    },
  },
  {
    files: [
      '**/*.test.ts',
      '**/__fixtures__/**',
      'packages/database/src/seed.ts',
      'apps/worker/**',
    ],
    rules: { 'no-console': 'off' },
  },
  {
    // Maintenance scripts are Node command-line tools: they run outside any
    // bundler, and printing to stdout is their entire purpose.
    files: ['scripts/**/*.mjs', 'scripts/**/*.js'],
    languageOptions: {
      globals: { console: 'readonly', process: 'readonly' },
    },
    rules: { 'no-console': 'off' },
  },
);

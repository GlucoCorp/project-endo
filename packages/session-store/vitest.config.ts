import { defineConfig } from 'vitest/config';

// The store is covered by integration tests (ENDO_TEST_DATABASE_URL, always set in CI).
const dbCode = process.env['ENDO_TEST_DATABASE_URL'] ? [] : ['src/session-table.ts'];

export default defineConfig({
  test: {
    testTimeout: 15_000,
    hookTimeout: 60_000,
    coverage: {
      provider: 'v8',
      include: ['src/**'],
      exclude: ['src/**/*.test.ts', 'src/migrate-cli.ts', 'src/testing.ts', ...dbCode],
      // Sessions authenticate every request: security-critical, 90%.
      thresholds: { lines: 90, branches: 90, functions: 90, statements: 90 },
    },
  },
});

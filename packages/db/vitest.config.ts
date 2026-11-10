import { defineConfig } from 'vitest/config';

// Database code is covered by integration tests, which need ENDO_TEST_DATABASE_URL. CI always sets
// it (and testDatabaseUrl() fails if it is missing there), so CI always measures this code.
// Locally without a test database, those files are left out of the coverage denominator.
const dbCode = process.env['ENDO_TEST_DATABASE_URL']
  ? []
  : ['src/migrate.ts', 'src/outbox.ts', 'src/pool.ts', 'src/test-support.ts'];

export default defineConfig({
  test: {
    // Generous: packages test in parallel with coverage, and cold imports are slow on dev machines.
    testTimeout: 15_000,
    coverage: {
      provider: 'v8',
      include: ['src/**'],
      exclude: ['src/**/*.test.ts', ...dbCode],
      thresholds: { lines: 90, branches: 90, functions: 90, statements: 90 },
    },
  },
});

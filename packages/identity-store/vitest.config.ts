import { defineConfig } from 'vitest/config';

// The Postgres key store is covered by integration tests (ENDO_TEST_DATABASE_URL, always set in CI).
const dbCode = process.env['ENDO_TEST_DATABASE_URL'] ? [] : ['src/key-store.ts'];

export default defineConfig({
  test: {
    testTimeout: 15_000,
    // Integration setup creates roles, a schema and runs migrations; slow when packages run in parallel.
    hookTimeout: 60_000,
    coverage: {
      provider: 'v8',
      include: ['src/**'],
      // migrate-cli.ts is a process entrypoint, exercised by the CI migration step.
      exclude: ['src/**/*.test.ts', 'src/migrate-cli.ts', ...dbCode],
      // Identity vault and crypto-shredding: security-critical (spec 0 DoD), 90%.
      thresholds: { lines: 90, branches: 90, functions: 90, statements: 90 },
    },
  },
});

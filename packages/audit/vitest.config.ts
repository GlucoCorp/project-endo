import { defineConfig } from 'vitest/config';

// postgres-store.ts is covered by integration tests (ENDO_TEST_DATABASE_URL, always set in CI).
const dbCode = process.env['ENDO_TEST_DATABASE_URL'] ? [] : ['src/postgres-store.ts'];

export default defineConfig({
  test: {
    // Generous: packages test in parallel with coverage, and cold imports are slow on dev machines.
    testTimeout: 15_000,
    // Integration setup creates a schema and runs migrations; slow when packages run in parallel.
    hookTimeout: 60_000,
    coverage: {
      provider: 'v8',
      include: ['src/**'],
      // migrate-cli.ts is a process entrypoint, exercised by the CI migration step.
      exclude: ['src/**/*.test.ts', 'src/migrate-cli.ts', ...dbCode],
      // Security-critical package (spec 0 DoD): 90% on changed lines.
      thresholds: { lines: 90, branches: 90, functions: 90, statements: 90 },
    },
  },
});

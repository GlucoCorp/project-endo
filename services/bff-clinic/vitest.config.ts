import { defineConfig } from 'vitest/config';

// The durable session adapter is covered by integration tests (ENDO_TEST_DATABASE_URL, set in CI).
const dbCode = process.env['ENDO_TEST_DATABASE_URL'] ? [] : ['src/pg-sessions.ts'];

export default defineConfig({
  test: {
    // Browser tests run with Playwright (pnpm test:e2e), not with Vitest.
    exclude: ['e2e/**', 'node_modules/**'],
    testTimeout: 15_000,
    coverage: {
      provider: 'v8',
      include: ['src/**'],
      exclude: ['src/**/*.test.ts', 'src/main.ts', ...dbCode], // main.ts is the process entrypoint
      // Clinician authentication: security-critical (spec 0 DoD), 90%.
      thresholds: { lines: 90, branches: 90, functions: 90, statements: 90 },
    },
  },
});

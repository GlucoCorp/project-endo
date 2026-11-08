import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Generous: packages test in parallel with coverage, and cold imports are slow on dev machines.
    testTimeout: 15_000,
    coverage: {
      provider: 'v8',
      include: ['src/**'],
      exclude: ['src/**/*.test.ts'],
      // Security-critical package (spec 0 DoD): 90% on changed lines.
      thresholds: { lines: 90, branches: 90, functions: 90, statements: 90 },
    },
  },
});

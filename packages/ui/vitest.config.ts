import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Generous: packages test in parallel with coverage, and cold imports are slow on dev machines.
    testTimeout: 15_000,
    coverage: {
      provider: 'v8',
      include: ['src/**'],
      // Components are covered by the apps' browser tests; their logic (model.ts) is covered here.
      exclude: ['src/**/*.test.ts', 'src/**/index.ts', 'src/**/*.tsx'],
      thresholds: { lines: 90, branches: 90, functions: 90, statements: 90 },
    },
  },
});

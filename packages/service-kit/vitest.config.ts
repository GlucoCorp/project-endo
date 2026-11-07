import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    coverage: {
      provider: 'v8',
      include: ['src/**'],
      exclude: ['src/**/*.test.ts'],
      // Security-critical package (spec 0 DoD): 90% on changed lines.
      thresholds: { lines: 90, branches: 90, functions: 90, statements: 90 },
    },
  },
});

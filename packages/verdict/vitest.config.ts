import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    testTimeout: 15_000,
    coverage: {
      provider: 'v8',
      include: ['src/**'],
      exclude: ['src/**/*.test.ts'],
      // CLAUDE.md: verdict is security-critical (90% and a named human reviewer).
      thresholds: { lines: 90, branches: 90, functions: 90, statements: 90 },
    },
  },
});

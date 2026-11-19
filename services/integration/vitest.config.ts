import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    testTimeout: 15_000,
    coverage: {
      provider: 'v8',
      include: ['src/**'],
      exclude: ['src/**/*.test.ts', 'src/main.ts'],
      // The record-system boundary authenticates external clients: security-critical, 90%.
      thresholds: { lines: 90, branches: 90, functions: 90, statements: 90 },
    },
  },
});

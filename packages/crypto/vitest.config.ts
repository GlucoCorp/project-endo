import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    coverage: {
      provider: 'v8',
      include: ['src/**'],
      exclude: ['src/**/*.test.ts'],
      // Crypto is security-critical: held to the same bar as authz and verdict.
      thresholds: { lines: 90, branches: 90, functions: 90, statements: 90 },
    },
  },
});

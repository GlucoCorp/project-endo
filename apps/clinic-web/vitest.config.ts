import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    testTimeout: 15_000,
    include: ['src/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      // Components are covered by the browser tests (e2e); the logic they use is covered here.
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.test.ts', 'src/vite-env.d.ts', 'src/i18n.ts'],
      thresholds: { lines: 90, branches: 90, functions: 90, statements: 90 },
    },
  },
});

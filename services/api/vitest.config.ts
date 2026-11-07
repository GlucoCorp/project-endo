import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Generous: packages test in parallel with coverage, and cold imports are slow on dev machines.
    testTimeout: 15_000,
    coverage: {
      provider: 'v8',
      include: ['src/**'],
      exclude: ['src/**/*.test.ts', 'src/main.ts'], // main.ts is the process entrypoint, exercised by the smoke run
      // Spec 0 DoD: 80% outside the security-critical packages.
      thresholds: { lines: 80, branches: 80, functions: 80, statements: 80 },
    },
  },
});

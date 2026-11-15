import { defineConfig } from '@playwright/test';

/**
 * ADR-0021 slice 8: the real Keycloak, identity service, API and patient BFF (stack.ts). Needs
 * Docker, the endo-keycloak image and ENDO_TEST_DATABASE_URL; run with `pnpm test:e2e:keycloak`.
 */
export default defineConfig({
  testDir: '.',
  workers: 1,
  timeout: 300_000,
  reporter: 'list',
  outputDir: '../test-results-keycloak',
  use: { headless: true, browserName: 'chromium' },
});

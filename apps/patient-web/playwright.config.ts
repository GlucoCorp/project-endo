import { defineConfig } from '@playwright/test';

/** Browser tests for the patient app (ADR-0020). Headless Chromium only; one worker. */
export default defineConfig({
  testDir: 'e2e',
  workers: 1,
  timeout: 30_000,
  reporter: 'list',
  use: { headless: true, browserName: 'chromium' },
});

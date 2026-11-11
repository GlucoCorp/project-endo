import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * Clinic portal build (spec 21.8, ADR-0024). The output has no inline scripts and no eval, so it runs
 * under the BFF's CSP (`script-src 'self' 'strict-dynamic'`, Trusted Types). In development the
 * BFF is reached through the dev server's proxy so the app and `/v1` share one origin, as in
 * production.
 */
export default defineConfig({
  plugins: [react()],
  build: {
    // The module-preload polyfill injects an inline script; modern browsers do not need it.
    modulePreload: { polyfill: false },
    sourcemap: false,
    target: 'es2022',
  },
  server: {
    host: '127.0.0.1',
    proxy: {
      '/v1': { target: process.env['BFF_URL'] ?? 'http://127.0.0.1:8081' },
      '/auth': { target: process.env['BFF_URL'] ?? 'http://127.0.0.1:8081' },
    },
  },
});

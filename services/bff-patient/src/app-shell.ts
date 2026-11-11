import { randomBytes } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { extname, join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { htmlCsp, withScriptNonce } from '@endo/service-kit';

/** The patient app's page paths (its router's routes). Anything else is not the app. */
export const APP_PATHS = ['/', '/enrol'] as const;

const TYPES = new Map([
  ['.js', 'text/javascript; charset=utf-8'],
  ['.css', 'text/css; charset=utf-8'],
  ['.woff2', 'font/woff2'],
  ['.svg', 'image/svg+xml'],
  ['.png', 'image/png'],
  ['.webmanifest', 'application/manifest+json'],
]);
// Names come from the build directory's listing, never from a request; requests match exactly.
const ASSET = /^[\w-][\w.-]*$/;

/** The built app (`vite build` output), read once at start-up. */
export interface AppShell {
  readonly index: string;
  readonly assets: ReadonlyMap<string, { readonly body: Buffer; readonly type: string }>;
}

/** Loads `dir/index.html` and the files of `dir/assets` with known types into memory. */
export function loadAppShell(dir: string): AppShell {
  // `dir` is the operator's start-up setting (BFF_PATIENT_APP_DIR), never request input.
  /* eslint-disable security/detect-non-literal-fs-filename */
  const index = readFileSync(join(dir, 'index.html'), 'utf8');
  const names = readdirSync(join(dir, 'assets'));
  const read = (name: string) => readFileSync(join(dir, 'assets', name));
  /* eslint-enable security/detect-non-literal-fs-filename */
  const assets = new Map<string, { body: Buffer; type: string }>();
  for (const name of names) {
    const type = TYPES.get(extname(name));
    if (type && ASSET.test(name)) assets.set(name, { body: read(name), type });
  }
  return { index, assets };
}

/**
 * Serves the patient app from the BFF's own origin (spec 8.4, 12.2), so `/v1` calls are
 * same-origin and the CSP is set by one service.
 * - Each page response gets a fresh 128-bit nonce, on its script tags and in its CSP
 *   (`script-src 'nonce-…' 'strict-dynamic'`), and is never cached.
 * - Assets are content-hashed build files with no personal data: cached for a year.
 * - Nothing is read from disk per request; a request names a file only by an exact key.
 */
export function registerAppShell(app: FastifyInstance, shell: AppShell): void {
  for (const path of APP_PATHS) {
    app.get(
      path,
      { config: { auth: { kind: 'public', reason: 'app-shell' } } },
      (_request, reply) => {
        const nonce = randomBytes(16).toString('base64');
        return reply
          .header('content-security-policy', htmlCsp(nonce))
          .type('text/html; charset=utf-8')
          .send(withScriptNonce(shell.index, nonce));
      },
    );
  }
  app.get(
    '/assets/:file',
    { config: { auth: { kind: 'public', reason: 'app-shell' } } },
    (request, reply) => {
      const { file } = request.params as { file: string };
      const asset = shell.assets.get(file);
      if (!asset) return reply.code(404).send();
      return reply
        .header('cache-control', 'public, max-age=31536000, immutable')
        .type(asset.type)
        .send(asset.body);
    },
  );
}

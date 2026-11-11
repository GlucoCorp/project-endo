import { describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ServiceTokenSigner, generateServiceKeyPair } from '@endo/service-kit';
import { buildBff } from './app.ts';
import { APP_PATHS, loadAppShell } from './app-shell.ts';
import { DevSessionStore } from './sessions.ts';

function builtApp() {
  const dir = mkdtempSync(join(tmpdir(), 'endo-app-'));
  mkdirSync(join(dir, 'assets'));
  writeFileSync(
    join(dir, 'index.html'),
    '<!doctype html><html><body><script type="module" src="/assets/index-abc.js"></script></body></html>',
  );
  writeFileSync(join(dir, 'assets', 'index-abc.js'), 'export {};');
  writeFileSync(join(dir, 'assets', 'index-abc.css'), 'body{}');
  writeFileSync(join(dir, 'assets', 'notes.txt'), 'not served');
  writeFileSync(join(dir, 'assets', '.hidden.js'), 'not served');
  return dir;
}

async function app(rateLimitPerMinute = 100) {
  const keys = await generateServiceKeyPair();
  return buildBff({
    logLevel: 'silent',
    sessions: new DevSessionStore('test'),
    signer: new ServiceTokenSigner(keys.privateJwk, 'bff-patient'),
    apiBaseUrl: 'http://api.internal',
    fetch: () => Promise.reject(new Error('unused')),
    appShell: loadAppShell(builtApp()),
    rateLimitPerMinute,
  });
}

describe('spec 12.2, 14: the BFF serves the patient app', () => {
  it('serves each page with a fresh nonce in its CSP and on its scripts, never cached', async () => {
    const a = await app();
    const nonces = new Set<string>();
    for (const path of APP_PATHS) {
      const res = await a.inject({ url: path });
      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toMatch(/^text\/html/);
      expect(res.headers['cache-control']).toBe('no-store');
      const csp = String(res.headers['content-security-policy']);
      const nonce = /'nonce-([^']+)'/.exec(csp)?.[1] ?? '';
      expect(csp).toContain(`script-src 'nonce-${nonce}' 'strict-dynamic'`);
      expect(res.body).toContain(`<script nonce="${nonce}" type="module"`);
      nonces.add(nonce);
    }
    expect(nonces.size).toBe(APP_PATHS.length);
  });

  it('serves only known build assets, cached as immutable', async () => {
    const a = await app();
    const js = await a.inject({ url: '/assets/index-abc.js' });
    expect(js.statusCode).toBe(200);
    expect(js.headers['content-type']).toMatch(/^text\/javascript/);
    expect(js.headers['cache-control']).toBe('public, max-age=31536000, immutable');
    expect((await a.inject({ url: '/assets/index-abc.css' })).statusCode).toBe(200);
    for (const bad of ['notes.txt', '.hidden.js', '..%2Findex.html', 'missing.js'])
      expect((await a.inject({ url: `/assets/${bad}` })).statusCode).toBe(404);
    // Not an app page: not served as one.
    expect((await a.inject({ url: '/admin' })).statusCode).toBe(404);
  });

  it('rate limits the app shell like any other route (only liveness is exempt)', async () => {
    const a = await app(3);
    const codes = [];
    for (let i = 0; i < 5; i++) codes.push((await a.inject({ url: '/' })).statusCode);
    expect(codes).toEqual([200, 200, 200, 429, 429]);
    expect((await a.inject({ url: '/healthz' })).statusCode).toBe(200);
  });
});

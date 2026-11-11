import { describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify from 'fastify';
import { loadAppShell, registerAppShell } from './app-shell.ts';

function built() {
  const dir = mkdtempSync(join(tmpdir(), 'endo-shell-'));
  mkdirSync(join(dir, 'assets'));
  writeFileSync(
    join(dir, 'index.html'),
    '<html><script type="module" src="/assets/a-1.js"></script></html>',
  );
  writeFileSync(join(dir, 'assets', 'a-1.js'), 'export {};');
  writeFileSync(join(dir, 'assets', 'font-1.woff2'), 'x');
  writeFileSync(join(dir, 'assets', 'readme.txt'), 'not served');
  return dir;
}

describe('spec 12.2, 14: app shell served by a BFF', () => {
  it('loads only known asset types, and serves pages with a fresh nonce each time', async () => {
    const shell = loadAppShell(built());
    expect([...shell.assets.keys()].sort()).toEqual(['a-1.js', 'font-1.woff2']);
    const app = Fastify();
    registerAppShell(app, shell, { paths: ['/', '/x'], config: {} });
    const a = await app.inject({ url: '/' });
    const b = await app.inject({ url: '/x' });
    const nonceOf = (csp: unknown) => /'nonce-([^']+)'/.exec(String(csp))?.[1];
    expect(nonceOf(a.headers['content-security-policy'])).not.toBe(
      nonceOf(b.headers['content-security-policy']),
    );
    expect(a.body).toContain(`nonce="${nonceOf(a.headers['content-security-policy']) ?? ''}"`);
    const font = await app.inject({ url: '/assets/font-1.woff2' });
    expect(font.headers['content-type']).toBe('font/woff2');
    expect(font.headers['cache-control']).toBe('public, max-age=31536000, immutable');
    expect((await app.inject({ url: '/assets/readme.txt' })).statusCode).toBe(404);
    expect((await app.inject({ url: '/other' })).statusCode).toBe(404);
  });
});

import { describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import { WEB_SECURITY_HEADERS, htmlCsp, withScriptNonce } from './security-headers.ts';

const nonce = () => randomBytes(16).toString('base64');

describe('spec 12.2 CSP for HTML responses', () => {
  it('allows only this response nonce for scripts, and keeps every other directive', () => {
    const n = nonce();
    const csp = htmlCsp(n);
    expect(csp).toContain(`script-src 'nonce-${n}' 'strict-dynamic'`);
    expect(csp).not.toContain("script-src 'self'");
    const others = (s: string) => s.split('; ').filter((d) => !d.startsWith('script-src'));
    expect(others(csp)).toEqual(others(String(WEB_SECURITY_HEADERS['content-security-policy'])));
    expect(csp).toContain("require-trusted-types-for 'script'");
  });

  it('puts the nonce on every script tag of a built page', () => {
    const n = nonce();
    const html = '<script type="module" src="/a.js"></script><script src="/b.js"></script>';
    expect(withScriptNonce(html, n)).toBe(
      `<script nonce="${n}" type="module" src="/a.js"></script><script nonce="${n}" src="/b.js"></script>`,
    );
  });

  it('refuses a weak or malformed nonce, so it cannot inject into the header or page', () => {
    for (const bad of [
      'abc',
      randomBytes(8).toString('base64'),
      `x'; script-src *; '${'A'.repeat(10)}`,
      '"><script>',
    ])
      expect(() => htmlCsp(bad)).toThrow(TypeError);
    expect(() => withScriptNonce('<script ></script>', '"onload="x')).toThrow(TypeError);
  });
});

import { describe, expect, it } from 'vitest';
import { isSecurityContact, securityTxt } from './security-txt.ts';

describe('spec 12.7 security.txt (RFC 9116)', () => {
  const now = new Date('2026-11-16T00:00:00Z');

  it('lists the contact, an expiry under a year, and the policy when given', () => {
    expect(securityTxt({ contact: 'mailto:security@example.test', now })).toBe(
      'Contact: mailto:security@example.test\nExpires: 2027-05-15T00:00:00.000Z\nPreferred-Languages: en\n',
    );
    expect(
      securityTxt({
        contact: 'https://example.test/report',
        policy: 'https://example.test/disclosure',
        now,
      }),
    ).toContain('Policy: https://example.test/disclosure\n');
  });

  it('refuses anything that is not a mailto: or https: contact, or an http policy', () => {
    expect(isSecurityContact('security@example.test')).toBe(false);
    expect(isSecurityContact('http://example.test')).toBe(false);
    expect(() => securityTxt({ contact: 'call us', now })).toThrow(TypeError);
    expect(() =>
      securityTxt({ contact: 'mailto:a@b.test', policy: 'http://example.test', now }),
    ).toThrow(TypeError);
  });
});

import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { isRole, isUuid, isUuidV7, ROLES, uuidv7 } from './index.ts';

describe('uuidv7', () => {
  it('produces RFC 9562 version 7 UUIDs', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 0xffff_ffff_ffff }), (ms) => {
        const id = uuidv7(ms);
        expect(isUuidV7(id)).toBe(true);
        expect(isUuid(id)).toBe(true);
        expect(Number.parseInt(id.replaceAll('-', '').slice(0, 12), 16)).toBe(ms);
      }),
    );
  });

  it('is time-ordered across milliseconds', () => {
    const a = uuidv7(1_700_000_000_000);
    const b = uuidv7(1_700_000_000_001);
    expect(a < b).toBe(true);
  });

  it('does not repeat', () => {
    const ids = new Set(Array.from({ length: 10_000 }, () => uuidv7(1)));
    expect(ids.size).toBe(10_000);
  });

  it.each([-1, 1.5, 2 ** 48, Number.NaN])('rejects out-of-range timestamp %s', (ms) => {
    expect(() => uuidv7(ms)).toThrow(RangeError);
  });

  it('uses the current time by default', () => {
    const before = Date.now();
    const id = uuidv7();
    const ms = Number.parseInt(id.replaceAll('-', '').slice(0, 12), 16);
    expect(ms).toBeGreaterThanOrEqual(before);
  });
});

describe('isUuid', () => {
  it.each([
    '',
    'not-a-uuid',
    '00000000-0000-0000-0000-000000000000',
    'ABCDEF00-0000-4000-8000-000000000000',
  ])('rejects %j', (v) => {
    expect(isUuid(v)).toBe(false);
  });
});

describe('roles', () => {
  it('recognises every spec 3.1 role and nothing else', () => {
    for (const r of ROLES) expect(isRole(r)).toBe(true);
    expect(isRole('admin')).toBe(false);
    expect(isRole(1)).toBe(false);
  });
});

describe('REQ-007 red-flag report key', () => {
  it('is the same for the same check-in, different for another, and shaped as a UUID', async () => {
    const { redFlagKeyFor } = await import('./index.ts');
    const a = '0190a000-0000-4000-8000-000000000001';
    const k = await redFlagKeyFor(a);
    expect(k).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(await redFlagKeyFor(a)).toBe(k);
    expect(await redFlagKeyFor('0190a000-0000-4000-8000-000000000002')).not.toBe(k);
    expect(k).not.toBe(a);
    await expect(redFlagKeyFor('not-a-uuid')).rejects.toThrow(TypeError);
  });
});

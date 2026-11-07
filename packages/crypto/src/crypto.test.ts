import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import {
  DecryptionError,
  DevKeyManager,
  FieldCipher,
  InMemoryPatientKeyStore,
  KeyDestroyedError,
  type FieldContext,
} from './index.ts';

const ctx: FieldContext = {
  patientId: '01900000-0000-7000-8000-000000000001',
  field: 'goal.text',
  recordId: '01900000-0000-7000-8000-0000000000aa',
};

function setup() {
  const kms = new DevKeyManager('test');
  const store = new InMemoryPatientKeyStore();
  return { kms, store, cipher: new FieldCipher(kms, store) };
}

describe('DevKeyManager', () => {
  it.each(['staging', 'production'] as const)('refuses to run in %s (RISK-I01)', (env) => {
    expect(() => new DevKeyManager(env)).toThrow(/not allowed/);
  });

  it('wraps and unwraps a data key', async () => {
    const kms = new DevKeyManager('dev');
    const dk = await kms.generateDataKey('kms/clinical');
    expect(dk.plaintext).toHaveLength(32);
    const unwrapped = await kms.unwrapDataKey('kms/clinical', dk.wrapped);
    expect(Buffer.from(unwrapped).equals(Buffer.from(dk.plaintext))).toBe(true);
  });

  it('binds wrapped keys to their KeyRef', async () => {
    const kms = new DevKeyManager('dev');
    const dk = await kms.generateDataKey('kms/clinical');
    await expect(kms.unwrapDataKey('kms/identity', dk.wrapped)).rejects.toThrow(/authentication/);
  });

  it('rejects malformed wrapped keys', async () => {
    const kms = new DevKeyManager('dev');
    await expect(kms.unwrapDataKey('kms/clinical', new Uint8Array(5))).rejects.toThrow(/length/);
  });
});

describe('FieldCipher (spec 11.2)', () => {
  it('round-trips arbitrary unicode text', async () => {
    const { cipher } = setup();
    await fc.assert(
      fc.asyncProperty(fc.string({ unit: 'grapheme', maxLength: 140 }), async (text) => {
        const env = await cipher.encrypt(text, ctx);
        expect(await cipher.decrypt(env, ctx)).toBe(text);
      }),
      { numRuns: 50 },
    );
  });

  it('never contains the plaintext and is randomised per call', async () => {
    const { cipher } = setup();
    const secret = 'Walk my daughter to school';
    const a = await cipher.encrypt(secret, ctx);
    const b = await cipher.encrypt(secret, ctx);
    expect(a).not.toContain(secret);
    expect(a).not.toBe(b);
    expect(a.startsWith('v1.')).toBe(true);
  });

  it.each([
    ['patient', { ...ctx, patientId: '01900000-0000-7000-8000-000000000002' }],
    ['field', { ...ctx, field: 'review_decision.note' }],
    ['record', { ...ctx, recordId: '01900000-0000-7000-8000-0000000000bb' }],
  ])('fails when moved to another %s (AAD binding)', async (_label, other) => {
    const { cipher } = setup();
    const env = await cipher.encrypt('x', ctx);
    // Make sure the other patient has a key so the failure is the AAD check, not a missing key.
    await cipher.encrypt('y', other);
    await expect(cipher.decrypt(env, other)).rejects.toBeInstanceOf(DecryptionError);
  });

  it('detects tampering', async () => {
    const { cipher } = setup();
    const env = await cipher.encrypt('take it every day', ctx);
    const parts = env.split('.');
    const body = Buffer.from(parts[2]!, 'base64url');
    body[0] = body[0]! ^ 0x01;
    parts[2] = body.toString('base64url');
    await expect(cipher.decrypt(parts.join('.'), ctx)).rejects.toBeInstanceOf(DecryptionError);
  });

  it.each(['', 'v1.a.b', 'v2.a.b.c', 'v1.AAAA.AAAA.AAAA'])(
    'rejects malformed envelope %j',
    async (env) => {
      const { cipher } = setup();
      await cipher.encrypt('seed', ctx);
      await expect(cipher.decrypt(env, ctx)).rejects.toBeInstanceOf(DecryptionError);
    },
  );

  it('does not create a key on decrypt for an unknown patient', async () => {
    const { cipher, store } = setup();
    const other = setup().cipher;
    const env = await other.encrypt('x', ctx);
    await expect(cipher.decrypt(env, ctx)).rejects.toBeInstanceOf(DecryptionError);
    expect(await store.get(ctx.patientId)).toBeNull();
  });

  it('uses one stable data key per patient', async () => {
    const { cipher, store } = setup();
    await cipher.encrypt('a', ctx);
    const first = await store.get(ctx.patientId);
    await cipher.encrypt('b', ctx);
    expect(await store.get(ctx.patientId)).toBe(first);
  });

  describe('REQ-009 crypto-shredding', () => {
    it('makes existing ciphertext unrecoverable and blocks new writes', async () => {
      const { cipher } = setup();
      const env = await cipher.encrypt('my goal', ctx);
      await cipher.shredPatient(ctx.patientId);
      await expect(cipher.decrypt(env, ctx)).rejects.toBeInstanceOf(KeyDestroyedError);
      await expect(cipher.encrypt('again', ctx)).rejects.toBeInstanceOf(KeyDestroyedError);
    });

    it('store refuses to recreate a shredded key', async () => {
      const store = new InMemoryPatientKeyStore();
      await store.destroy('p');
      await expect(store.putIfAbsent('p', new Uint8Array(1))).rejects.toThrow(/shredded/);
    });
  });
});

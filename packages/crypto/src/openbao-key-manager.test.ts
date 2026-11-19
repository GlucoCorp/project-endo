import { describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { FieldCipher } from './field-cipher.ts';
import { KeyManagerError, OpenBaoKeyManager } from './openbao-key-manager.ts';
import { InMemoryPatientKeyStore } from './patient-key-store.ts';

/** A tiny Transit stand-in: wraps keys under the named key, as OpenBao would. */
function fakeOpenBao() {
  const keys = new Map<string, string>(); // ciphertext -> base64 plaintext
  const calls: { url: string; token: string | null; body: unknown }[] = [];
  const f = ((url: string, init?: RequestInit) => {
    const body = JSON.parse(init?.body as string) as Record<string, unknown>;
    calls.push({ url, token: new Headers(init?.headers).get('x-vault-token'), body });
    const name = url.split('/').at(-1) ?? '';
    if (url.includes('/datakey/plaintext/')) {
      const plaintext = randomBytes(32).toString('base64');
      const ciphertext = `vault:v1:${Buffer.from(`${name}:${plaintext}`).toString('base64')}`;
      keys.set(ciphertext, plaintext);
      return Promise.resolve(Response.json({ data: { plaintext, ciphertext } }));
    }
    const c = body['ciphertext'] as string;
    const decoded = Buffer.from(c.slice('vault:v1:'.length), 'base64').toString();
    // Transit refuses a ciphertext made under another key.
    if (!decoded.startsWith(`${name}:`))
      return Promise.resolve(new Response('{}', { status: 400 }));
    return Promise.resolve(Response.json({ data: { plaintext: keys.get(c) } }));
  }) as unknown as typeof fetch;
  return { f, calls };
}

const answering = (r: Response | Error) =>
  new OpenBaoKeyManager({
    address: 'https://bao.test',
    token: () => 't',
    fetch: () => (r instanceof Error ? Promise.reject(r) : Promise.resolve(r)),
  });
const transit = Buffer.from('vault:v1:QQ==');

describe('spec 11.2 OpenBao Transit key manager', () => {
  it('mints and unwraps data keys under one Transit key per store, with the token', async () => {
    const { f, calls } = fakeOpenBao();
    const kms = new OpenBaoKeyManager({
      address: 'https://bao.test:8200',
      token: () => 'tok',
      fetch: f,
    });
    const dk = await kms.generateDataKey('kms/clinical');
    expect(dk.plaintext).toHaveLength(32);
    expect(Buffer.from(dk.wrapped).toString()).toMatch(/^vault:v1:/);
    expect(calls[0]).toMatchObject({
      url: 'https://bao.test:8200/v1/transit/datakey/plaintext/endo-clinical',
      token: 'tok',
      body: { bits: 256 },
    });
    expect(await kms.unwrapDataKey('kms/clinical', dk.wrapped)).toEqual(dk.plaintext);
    // A key wrapped for one store does not unwrap as another.
    await expect(kms.unwrapDataKey('kms/identity', dk.wrapped)).rejects.toBeInstanceOf(
      KeyManagerError,
    );
  });

  it('works under FieldCipher end to end', async () => {
    const { f } = fakeOpenBao();
    const kms = new OpenBaoKeyManager({ address: 'https://bao.test', token: () => 't', fetch: f });
    const cipher = new FieldCipher(kms, new InMemoryPatientKeyStore());
    const ctx = { patientId: 'p', field: 'goal.text', recordId: 'r' };
    const sealed = await cipher.encrypt('SYNTHETIC goal', ctx);
    expect(await cipher.decrypt(sealed, ctx)).toBe('SYNTHETIC goal');
  });

  it('reads the token from a file on every call (rotation)', async () => {
    const { f, calls } = fakeOpenBao();
    const file = join(mkdtempSync(join(tmpdir(), 'bao-')), 'token');
    writeFileSync(file, 'first\n');
    const kms = new OpenBaoKeyManager({ address: 'http://127.0.0.1:8200', token: file, fetch: f });
    await kms.generateDataKey('kms/identity');
    writeFileSync(file, 'second\n');
    await kms.generateDataKey('kms/identity');
    expect(calls.map((c) => c.token)).toEqual(['first', 'second']);
  });

  it('spec 11.2 allows plain http to an in-cluster OpenBao only in dev and test', () => {
    for (const environment of ['dev', 'test'] as const)
      expect(
        () =>
          new OpenBaoKeyManager({ address: 'http://openbao:8200', environment, token: () => 't' }),
      ).not.toThrow();
    for (const environment of ['staging', 'production'] as const)
      expect(
        () =>
          new OpenBaoKeyManager({ address: 'http://openbao:8200', environment, token: () => 't' }),
      ).toThrow(KeyManagerError);
  });

  it('refuses plain http off loopback and a bad mount', () => {
    expect(() => new OpenBaoKeyManager({ address: 'http://bao.test', token: () => 't' })).toThrow(
      KeyManagerError,
    );
    expect(
      () =>
        new OpenBaoKeyManager({ address: 'https://bao.test', mount: '../sys', token: () => 't' }),
    ).toThrow(KeyManagerError);
  });

  it('fails closed on outages and odd answers, without echoing them', async () => {
    await expect(answering(new TypeError('down')).generateDataKey('kms/clinical')).rejects.toThrow(
      'not reachable',
    );
    const refused = answering(new Response('{"errors":["permission denied"]}', { status: 403 }));
    await expect(refused.generateDataKey('kms/clinical')).rejects.toThrow(
      /refused the request \(403\)$/,
    );
    await expect(answering(Response.json({})).generateDataKey('kms/clinical')).rejects.toThrow(
      'unexpectedly',
    );
    await expect(
      answering(Response.json({ data: { plaintext: 1 } })).generateDataKey('kms/clinical'),
    ).rejects.toThrow('unexpectedly');
    const short = Buffer.alloc(16).toString('base64');
    await expect(
      answering(
        Response.json({ data: { plaintext: short, ciphertext: 'vault:v1:x' } }),
      ).generateDataKey('kms/clinical'),
    ).rejects.toThrow('wrong size');
    await expect(
      answering(Response.json({ data: {} })).unwrapDataKey('kms/clinical', transit),
    ).rejects.toThrow('unexpectedly');
    await expect(
      answering(Response.json({ data: { plaintext: 'QQ==' } })).unwrapDataKey(
        'kms/clinical',
        transit,
      ),
    ).rejects.toThrow('wrong size');
    await expect(
      answering(Response.json({})).unwrapDataKey('kms/clinical', Buffer.from('not-transit')),
    ).rejects.toThrow('not a Transit ciphertext');
  });
});

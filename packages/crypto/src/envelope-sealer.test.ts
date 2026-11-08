import { describe, expect, it } from 'vitest';
import { DecryptionError, DevKeyManager, EnvelopeSealer } from './index.ts';

const SYNTHETIC_PHI_MARKER = 'SYNTHETIC_PHI_MARKER-7f3a';

describe('REQ-001, spec 11.2 EnvelopeSealer (fresh data key per value)', () => {
  const sealer = () => new EnvelopeSealer(new DevKeyManager('test'), 'kms/clinical');

  it('round-trips and never stores the plaintext', async () => {
    const s = sealer();
    const sealed = await s.seal(SYNTHETIC_PHI_MARKER, 'ctx-1');
    expect(JSON.stringify(sealed)).not.toContain(SYNTHETIC_PHI_MARKER);
    await expect(s.open(sealed, 'ctx-1')).resolves.toBe(SYNTHETIC_PHI_MARKER);
  });

  it('uses a different data key and IV every time', async () => {
    const s = sealer();
    const a = await s.seal('same', 'ctx');
    const b = await s.seal('same', 'ctx');
    expect(a.wrappedKey).not.toBe(b.wrappedKey);
    expect(a.envelope).not.toBe(b.envelope);
  });

  it('refuses to open in another context (moved to another record)', async () => {
    const s = sealer();
    const sealed = await s.seal('secret', 'ctx-1');
    await expect(s.open(sealed, 'ctx-2')).rejects.toBeInstanceOf(DecryptionError);
  });

  it.each([
    [
      'tampered body',
      (e: string) => e.replace(/\.([A-Za-z0-9_-])/, (_m, c: string) => `.${c === 'A' ? 'B' : 'A'}`),
    ],
    ['wrong version', (e: string) => e.replace(/^v1/, 'v9')],
    ['missing part', (e: string) => e.split('.').slice(0, 3).join('.')],
    ['short tag', (e: string) => `${e.split('.').slice(0, 3).join('.')}.AAAA`],
  ])('refuses a %s', async (_n, mutate) => {
    const s = sealer();
    const sealed = await s.seal('secret', 'ctx');
    await expect(
      s.open({ ...sealed, envelope: mutate(sealed.envelope) }, 'ctx'),
    ).rejects.toBeInstanceOf(DecryptionError);
  });

  it('refuses a key wrapped by another master key', async () => {
    const sealed = await sealer().seal('secret', 'ctx');
    await expect(sealer().open(sealed, 'ctx')).rejects.toBeInstanceOf(DecryptionError);
  });
});

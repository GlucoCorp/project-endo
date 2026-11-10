import { describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { DevKeyManager } from '@endo/crypto';
import { EnrolmentCodes } from './code.ts';

const kms = new DevKeyManager('test');
const bind = () => ({ invitationId: randomUUID(), transactionId: randomUUID() });

describe('REQ-001, RISK-S05 ADR-0021 enrolment code', () => {
  it('issues a 6-digit code that matches only where it was issued', async () => {
    const codes = new EnrolmentCodes(kms);
    const b = bind();
    const { code, sealed } = await codes.issue(b, []);
    expect(code).toMatch(/^[0-9]{6}$/);
    expect(await codes.matches(code, b, sealed)).toBe(true);
    // Bound to its invitation and transaction.
    expect(await codes.matches(code, { ...b, transactionId: randomUUID() }, sealed)).toBe(false);
    expect(await codes.matches(code, { ...b, invitationId: randomUUID() }, sealed)).toBe(false);
  });

  it('stores neither the code nor a plain hash of it, and uses a fresh key per code', async () => {
    const codes = new EnrolmentCodes(kms, () => '000042');
    const a = await codes.issue(bind(), []);
    const b = await codes.issue(bind(), []);
    expect(a.code).toBe('000042');
    expect(JSON.stringify(a.sealed)).not.toContain('000042');
    expect(a.sealed.wrappedKey).not.toBe(b.sealed.wrappedKey);
  });

  it('never matches malformed or wrong input', async () => {
    const codes = new EnrolmentCodes(kms, () => '123456');
    const b = bind();
    const { sealed } = await codes.issue(b, []);
    for (const bad of ['', '12345', '1234567', '12345a', ' 123456', '123456\n', '654321']) {
      expect(await codes.matches(bad, b, sealed)).toBe(false);
    }
    expect(await codes.matches('123456', b, { ...sealed, mac: 'AA' })).toBe(false);
  });

  it('pads short draws to six digits', async () => {
    const codes = new EnrolmentCodes(kms, () => '7');
    expect((await codes.issue(bind(), [])).code).toBe('000007');
  });

  it("draws again until the code differs from the invitation's other pending codes", async () => {
    const draws = ['111111', '111111', '222222', '333333'];
    const codes = new EnrolmentCodes(kms, () => draws.shift()!);
    const invitationId = randomUUID();
    const first = { invitationId, transactionId: randomUUID() };
    const one = await codes.issue(first, []);
    const second = { invitationId, transactionId: randomUUID() };
    const two = await codes.issue(second, [{ binding: first, sealed: one.sealed }]);
    expect(two.code).toBe('222222');
  });

  it('gives up rather than issue a duplicate', async () => {
    const codes = new EnrolmentCodes(kms, () => '999999');
    const first = bind();
    const one = await codes.issue(first, []);
    await expect(
      codes.issue({ ...first, transactionId: randomUUID() }, [
        { binding: first, sealed: one.sealed },
      ]),
    ).rejects.toThrow(/distinct/);
  });
});

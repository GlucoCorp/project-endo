import { createHmac, randomInt, timingSafeEqual } from 'node:crypto';
import type { KeyManager } from '@endo/crypto';

/**
 * The 6-digit confirmation code (ADR-0021 section 3; REQ-001, RISK-S05). Her phone shows it and the
 * clinician types it. It is a comparison aid, never a credential on its own.
 *
 * Each code is verified with HMAC-SHA-256 under its own data key from `kms/identity`, and the
 * transaction stores only the wrapped key and the MAC. With 10^6 possible codes a plain or
 * single-key hash could be brute-forced by anyone holding the database; here that also needs the
 * KMS. The MAC binds the invitation and transaction, so a code only matches where it was issued.
 */
export interface SealedCode {
  /** Data key wrapped by `kms/identity` (base64url). */
  readonly wrappedKey: string;
  /** HMAC-SHA-256 of the bound code (base64url). */
  readonly mac: string;
}

export interface CodeBinding {
  readonly invitationId: string;
  readonly transactionId: string;
}

const CODE = /^[0-9]{6}$/;
/** Pending transactions of one invitation are at most 3, so a few draws always suffice. */
const MAX_DRAWS = 20;

const message = (code: string, b: CodeBinding) =>
  `endo-enrolment-code:v1:${b.invitationId}:${b.transactionId}:${code}`;

export class EnrolmentCodes {
  readonly #kms: KeyManager;
  readonly #draw: () => string;

  /** `draw` exists for tests only; the default uses a cryptographically secure generator. */
  constructor(kms: KeyManager, draw: () => string = () => randomInt(0, 1_000_000).toString()) {
    this.#kms = kms;
    this.#draw = draw;
  }

  /**
   * Issues a code distinct from those of the invitation's other pending transactions (section 3),
   * so a typed code can never match two of them.
   */
  async issue(
    binding: CodeBinding,
    pending: readonly { binding: CodeBinding; sealed: SealedCode }[],
  ): Promise<{ code: string; sealed: SealedCode }> {
    for (let i = 0; i < MAX_DRAWS; i++) {
      const code = this.#draw().padStart(6, '0');
      let taken = false;
      for (const p of pending) {
        if (await this.matches(code, p.binding, p.sealed)) taken = true;
      }
      if (!taken) return { code, sealed: await this.#seal(code, binding) };
    }
    throw new Error('could not draw a distinct enrolment code');
  }

  /** Constant-time check of a typed code. Malformed input never matches. */
  async matches(candidate: string, binding: CodeBinding, sealed: SealedCode): Promise<boolean> {
    if (!CODE.test(candidate)) return false;
    const key = await this.#kms.unwrapDataKey(
      'kms/identity',
      Buffer.from(sealed.wrappedKey, 'base64url'),
    );
    try {
      const expected = Buffer.from(sealed.mac, 'base64url');
      const actual = createHmac('sha256', key).update(message(candidate, binding)).digest();
      return expected.length === actual.length && timingSafeEqual(expected, actual);
    } finally {
      key.fill(0);
    }
  }

  async #seal(code: string, binding: CodeBinding): Promise<SealedCode> {
    const key = await this.#kms.generateDataKey('kms/identity');
    try {
      return {
        wrappedKey: Buffer.from(key.wrapped).toString('base64url'),
        mac: createHmac('sha256', key.plaintext).update(message(code, binding)).digest('base64url'),
      };
    } finally {
      key.plaintext.fill(0);
    }
  }
}

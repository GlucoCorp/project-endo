import type { WorkloadTokenSigner } from '@endo/service-kit';
import type { KeycloakFinaliser } from './activation.ts';
import type { EmailSender } from '../email/routes.ts';

/** The Keycloak extension's admin scope (ADR-0021 section 13); nothing else carries it. */
type Answer = { finalised?: unknown; deleted?: unknown };

export const KEYCLOAK_ADMIN_SCOPE = 'keycloak.enrolment.admin';

/**
 * Calls the extension's narrow admin endpoint, `/realms/{realm}/endo-enrolment/...`
 * (ADR-0021 sections 10, 11 and 13). Only a 200 counts as done; anything else, including a
 * network failure, is "not yet" and activation retries on the next run. A 409 (the user is not
 * quarantined for this transaction) never becomes done: it needs a person to look.
 */
/** Keycloak's mail sender, through the extension (ADR-0026); its own scope. */
export const KEYCLOAK_EMAIL_SCOPE = 'keycloak.email.send';

/** REQ-009: removing an erased patient's account; its own scope. */
export const KEYCLOAK_ERASE_SCOPE = 'keycloak.user.erase';

/** Removes her identity-provider account at erasure (ADR-0029). True once it is gone. */
export interface AccountEraser {
  eraseUser(subject: string): Promise<boolean>;
}

export class HttpKeycloakAdmin implements KeycloakFinaliser, EmailSender, AccountEraser {
  readonly #base: string;
  readonly #signer: WorkloadTokenSigner;
  readonly #fetch: typeof fetch;

  constructor(opts: { realmUrl: string; signer: WorkloadTokenSigner; fetch: typeof fetch }) {
    this.#base = `${opts.realmUrl.replace(/\/+$/, '')}/endo-enrolment`;
    this.#signer = opts.signer;
    this.#fetch = opts.fetch;
  }

  finalise(subject: string, transactionId: string): Promise<boolean> {
    return this.#post('finalise', subject, transactionId, (b) => b?.finalised === true);
  }

  /** Sends one code email with Keycloak's SMTP sender (ADR-0026). True once handed over. */
  async send(to: string, code: string, purpose: 'sign-in' | 'confirm'): Promise<boolean> {
    const token = await this.#signer.sign([KEYCLOAK_EMAIL_SCOPE], 'keycloak');
    try {
      const res = await this.#fetch(`${this.#base}/send-email`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ to, code, purpose }),
        redirect: 'error',
        signal: AbortSignal.timeout(10_000),
      });
      if (res.status !== 200) return false;
      const body = (await res.json().catch(() => null)) as { sent?: unknown } | null;
      return body?.sent === true;
    } catch {
      return false;
    }
  }

  /**
   * REQ-009: removes her account, passkeys and sessions. True once gone (an unknown subject
   * counts); a staff account is refused (409) and anything else is "not yet".
   */
  async eraseUser(subject: string): Promise<boolean> {
    const token = await this.#signer.sign([KEYCLOAK_ERASE_SCOPE], 'keycloak');
    try {
      const res = await this.#fetch(`${this.#base}/erase`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ subject }),
        redirect: 'error',
        signal: AbortSignal.timeout(5_000),
      });
      if (res.status !== 200) return false;
      const body = (await res.json().catch(() => null)) as { erased?: unknown } | null;
      return body?.erased === true;
    } catch {
      return false;
    }
  }

  /** Deletes a provisional user quarantined for this transaction (cleanup, section 11). */
  deleteProvisional(subject: string, transactionId: string): Promise<boolean> {
    return this.#post('delete', subject, transactionId, (b) => b?.deleted === true);
  }

  async #post(
    path: string,
    subject: string,
    transactionId: string,
    ok: (body: Answer | null) => boolean,
  ) {
    const token = await this.#signer.sign([KEYCLOAK_ADMIN_SCOPE], 'keycloak');
    try {
      const res = await this.#fetch(`${this.#base}/${path}`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ subject, transaction_id: transactionId }),
        redirect: 'error',
        signal: AbortSignal.timeout(5_000),
      });
      if (res.status !== 200) return false;
      const body = (await res.json().catch(() => null)) as Answer | null;
      return ok(body);
    } catch {
      return false;
    }
  }
}

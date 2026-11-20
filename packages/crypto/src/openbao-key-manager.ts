import { readFileSync } from 'node:fs';
import { isDeployedEnvironment, type EnvironmentName } from '@endo/config';
import type { DataKey, KeyManager, KeyRef } from './key-manager.ts';

export class KeyManagerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'KeyManagerError';
  }
}

export interface OpenBaoOptions {
  /**
   * e.g. https://openbao.endo-platform.svc:8200. Plain http only on loopback, or anywhere when
   * `environment` is dev or test (the local cluster runs OpenBao in dev mode, without TLS).
   */
  readonly address: string;
  /** The service's environment. Staging and production always require https. */
  readonly environment?: EnvironmentName;
  /** The Transit secrets engine mount (default `transit`). */
  readonly mount?: string;
  /**
   * The token, read on every call so an agent or sidecar can rotate it (Kubernetes auth): a file
   * path, or a function for tests.
   */
  readonly token: string | (() => string);
  readonly fetch?: typeof fetch;
  /** Milliseconds per request (default 5000). */
  readonly timeoutMs?: number;
}

/** One Transit key per logical key, so a key wrapped for one store never unwraps as another. */
export const TRANSIT_KEY: Readonly<Record<KeyRef, string>> = {
  'kms/identity': 'endo-identity',
  'kms/clinical': 'endo-clinical',
  'kms/audit': 'endo-audit',
  'kms/objects': 'endo-objects',
  'kms/analytics': 'endo-analytics',
  'kms/backup': 'endo-backup',
};

const keyName = (ref: KeyRef): string => {
  const name = new Map(Object.entries(TRANSIT_KEY)).get(ref);
  if (!name) throw new KeyManagerError('unknown key reference');
  return name;
};

/**
 * KeyManager backed by the OpenBao (Vault-compatible) Transit engine (ADR-0014, spec 11.2,
 * 17.3). The master keys never leave OpenBao: it mints 256-bit data keys (`datakey/plaintext`)
 * and unwraps them (`decrypt`). Application code holds a data key only while it uses it.
 * Errors never carry OpenBao's response body.
 */
export class OpenBaoKeyManager implements KeyManager {
  readonly #base: string;
  readonly #token: () => string;
  readonly #fetch: typeof fetch;
  readonly #timeout: number;

  constructor(o: OpenBaoOptions) {
    const url = new URL(o.address);
    const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
    const development = o.environment !== undefined && !isDeployedEnvironment(o.environment);
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && (loopback || development)))
      throw new KeyManagerError(
        'OpenBao must be reached over https (http only on loopback or in dev and test)',
      );
    const mount = o.mount ?? 'transit';
    if (!/^[a-z0-9_-]{1,64}$/.test(mount)) throw new KeyManagerError('invalid Transit mount');
    this.#base = `${url.origin}/v1/${mount}`;
    const token = o.token;
    // The token file path comes from the service's own configuration, never from a request.
    this.#token =
      typeof token === 'function'
        ? token
        : // eslint-disable-next-line security/detect-non-literal-fs-filename
          () => readFileSync(token, 'utf8').trim();
    this.#fetch = o.fetch ?? fetch;
    this.#timeout = o.timeoutMs ?? 5_000;
  }

  async #call(path: string, body: object): Promise<Record<string, unknown>> {
    let res: Response;
    try {
      res = await this.#fetch(`${this.#base}/${path}`, {
        method: 'POST',
        headers: { 'x-vault-token': this.#token(), 'content-type': 'application/json' },
        body: JSON.stringify(body),
        redirect: 'error',
        signal: AbortSignal.timeout(this.#timeout),
      });
    } catch {
      throw new KeyManagerError('OpenBao is not reachable');
    }
    if (!res.ok) throw new KeyManagerError(`OpenBao refused the request (${String(res.status)})`);
    const json = (await res.json().catch(() => null)) as { data?: unknown } | null;
    if (!json || typeof json.data !== 'object' || json.data === null)
      throw new KeyManagerError('OpenBao answered unexpectedly');
    return json.data as Record<string, unknown>;
  }

  async generateDataKey(keyRef: KeyRef): Promise<DataKey> {
    const data = await this.#call(`datakey/plaintext/${keyName(keyRef)}`, { bits: 256 });
    const plaintext = data['plaintext'];
    const ciphertext = data['ciphertext'];
    if (typeof plaintext !== 'string' || typeof ciphertext !== 'string')
      throw new KeyManagerError('OpenBao answered unexpectedly');
    const key = Buffer.from(plaintext, 'base64');
    if (key.length !== 32) throw new KeyManagerError('OpenBao returned a key of the wrong size');
    return {
      plaintext: new Uint8Array(key),
      // The Transit ciphertext ("vault:v1:..."), stored as bytes.
      wrapped: new Uint8Array(Buffer.from(ciphertext, 'utf8')),
    };
  }

  async unwrapDataKey(keyRef: KeyRef, wrapped: Uint8Array): Promise<Uint8Array> {
    const ciphertext = Buffer.from(wrapped).toString('utf8');
    if (!/^vault:v\d+:[A-Za-z0-9+/=]+$/.test(ciphertext))
      throw new KeyManagerError('Wrapped key is not a Transit ciphertext');
    const data = await this.#call(`decrypt/${keyName(keyRef)}`, { ciphertext });
    const plaintext = data['plaintext'];
    if (typeof plaintext !== 'string') throw new KeyManagerError('OpenBao answered unexpectedly');
    const key = Buffer.from(plaintext, 'base64');
    if (key.length !== 32) throw new KeyManagerError('Unwrapped key has the wrong size');
    return new Uint8Array(key);
  }
}

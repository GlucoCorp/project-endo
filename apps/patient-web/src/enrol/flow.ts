import type { MessageKey } from '@endo/i18n';

/**
 * Patient enrolment, browser side (ADR-0021 sections 3 and 4). Pure logic over small seams
 * (fetch, storage, locks, location, history) so it is tested without a DOM, and driven for real
 * by the Playwright test.
 *
 * - The link is `/enrol#<token>`. The token is read from the fragment (servers never see it),
 *   then removed from the address bar at once, and kept only in memory.
 * - Start runs under a Web Lock shared by every tab of this origin, so a second tab starts only
 *   after the first has its cookie and gets the same transaction, without a code.
 * - The code is kept only in this tab's session storage, so a reload still shows it; it is
 *   cleared when the transaction leaves "awaiting confirmation".
 */

export const TOKEN = /^[A-Za-z0-9_-]{43}$/;
export const CODE_KEY = 'endo.enrolment.code';
export const LOCK_NAME = 'endo-enrolment-start';
/** Keycloak is reached over HTTPS, or plain HTTP on this machine only (local development). */
function keycloakUrl(u: string): boolean {
  try {
    const url = new URL(u);
    return (
      url.protocol === 'https:' ||
      (url.protocol === 'http:' && (url.hostname === 'localhost' || url.hostname === '127.0.0.1'))
    );
  } catch {
    return false;
  }
}

export interface Seams {
  readonly fetch: typeof fetch;
  readonly storage: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
  /** navigator.locks, when the browser has it. */
  readonly locks: Pick<LockManager, 'request'> | undefined;
}

/** What the page shows. */
export type View =
  | { readonly kind: 'no-link' }
  | { readonly kind: 'ready' }
  | { readonly kind: 'busy' }
  | { readonly kind: 'code'; readonly code: string | null; readonly status: string }
  | { readonly kind: 'confirmed' }
  /** Her passkey is being created or reported back (ADR-0021 states redeemed, credential-committed). */
  | { readonly kind: 'signing-in' }
  /** Her passkey exists; her consent choices come next (spec 13.1). */
  | { readonly kind: 'signed-in' }
  /** Her choices are saved; the clinic side finishes setting up (activation). */
  | { readonly kind: 'consented' }
  /** Continue: go to this Keycloak address. */
  | { readonly kind: 'navigate'; readonly url: string }
  | { readonly kind: 'ended'; readonly message: MessageKey }
  | { readonly kind: 'error'; readonly message: MessageKey };

interface ServerView {
  readonly status: string;
  readonly expired: boolean;
  readonly code?: string;
}

/**
 * Takes the token out of `/enrol#<token>` and removes it from the address bar and history entry.
 * Returns null when there is no valid token.
 */
export function takeToken(
  location: Pick<Location, 'hash' | 'pathname' | 'search'>,
  history: Pick<History, 'replaceState'>,
): string | null {
  const raw = location.hash.startsWith('#') ? location.hash.slice(1) : '';
  if (raw !== '') history.replaceState(null, '', `${location.pathname}${location.search}`);
  return TOKEN.test(raw) ? raw : null;
}

const PROBLEMS: Readonly<Record<string, MessageKey>> = {
  'enrolment.link_invalid': 'enrol.link-invalid',
  'enrolment.locked': 'enrol.locked',
  'enrolment.busy': 'enrol.busy',
  'enrolment.unavailable': 'enrol.unavailable',
  rate_limited: 'common.too-many',
};

async function problem(res: Response): Promise<MessageKey> {
  const body = (await res.json().catch(() => null)) as { type?: unknown } | null;
  const code = typeof body?.type === 'string' ? (body.type.split('/').pop() ?? '') : '';
  return new Map(Object.entries(PROBLEMS)).get(code) ?? 'common.try-later';
}

function codeOrConfirmed(v: ServerView, code: string | null): View {
  return v.status === 'confirmed'
    ? { kind: 'confirmed' }
    : { kind: 'code', code, status: v.status };
}

/** Maps the server's view of the transaction to what the page shows. */
export function fromServer(v: ServerView, code: string | null): View {
  if (v.expired) return { kind: 'ended', message: 'enrol.expired' };
  if (v.status === 'cancelling' || v.status === 'cancelled')
    return { kind: 'ended', message: 'enrol.cancelled' };
  if (v.status === 'awaiting-confirmation' || v.status === 'confirmed')
    return codeOrConfirmed(v, code);
  if (v.status === 'redeemed' || v.status === 'credential-committed') return { kind: 'signing-in' };
  if (v.status === 'consent-pending') return { kind: 'signed-in' };
  return { kind: 'consented' };
}

const json = (body: unknown): RequestInit => ({
  method: 'POST',
  credentials: 'same-origin',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
});

export class EnrolmentFlow {
  readonly #s: Seams;

  constructor(seams: Seams) {
    this.#s = seams;
  }

  #storedCode(): string | null {
    const c = this.#s.storage.getItem(CODE_KEY);
    return c !== null && /^[0-9]{6}$/.test(c) ? c : null;
  }

  #settle(view: View): View {
    if (view.kind !== 'code') this.#s.storage.removeItem(CODE_KEY);
    return view;
  }

  /** Start, serialised across tabs. A repeated Start returns the same transaction, no code. */
  async start(token: string): Promise<View> {
    const run = async (): Promise<View> => {
      const res = await this.#s.fetch('/v1/enrolment/start', json({ token }));
      if (res.status === 200 || res.status === 201) {
        const v = (await res.json()) as ServerView;
        if (typeof v.code === 'string') this.#s.storage.setItem(CODE_KEY, v.code);
        return this.#settle(fromServer(v, v.code ?? this.#storedCode()));
      }
      if (res.status === 429) return { kind: 'error', message: 'common.too-many' };
      return { kind: 'error', message: await problem(res) };
    };
    try {
      return this.#s.locks
        ? await this.#s.locks.request(LOCK_NAME, { mode: 'exclusive' }, run)
        : await run();
    } catch {
      return { kind: 'error', message: 'common.try-later' };
    }
  }

  /**
   * On opening the page without a token (a reload: the token was removed from the address bar),
   * pick up this browser's transaction from its cookie, if it has one.
   */
  async resume(): Promise<View> {
    try {
      const res = await this.#s.fetch('/v1/enrolment/status', { credentials: 'same-origin' });
      if (res.status === 404) return this.#settle({ kind: 'no-link' });
      if (!res.ok) return { kind: 'error', message: 'common.try-later' };
      return this.#settle(fromServer((await res.json()) as ServerView, this.#storedCode()));
    } catch {
      return { kind: 'error', message: 'common.try-later' };
    }
  }

  /** The current state of this browser's transaction. */
  async status(): Promise<View> {
    try {
      const res = await this.#s.fetch('/v1/enrolment/status', { credentials: 'same-origin' });
      if (res.status === 404) return this.#settle({ kind: 'ended', message: 'enrol.expired' });
      if (!res.ok) return { kind: 'error', message: 'common.try-later' };
      return this.#settle(fromServer((await res.json()) as ServerView, this.#storedCode()));
    } catch {
      return { kind: 'error', message: 'common.try-later' };
    }
  }

  /**
   * Create her sign-in (ADR-0021 section 5): the BFF binds a handoff to its own OIDC request and
   * answers with Keycloak's address; only an opaque reference is in it.
   */
  async continue(): Promise<View> {
    try {
      const res = await this.#s.fetch('/v1/enrolment/continue', json({}));
      if (res.ok) {
        const b = (await res.json()) as { location?: unknown };
        if (typeof b.location === 'string' && keycloakUrl(b.location))
          return { kind: 'navigate', url: b.location };
        return { kind: 'error', message: 'common.try-later' };
      }
      if (res.status === 404) return this.#settle({ kind: 'ended', message: 'enrol.expired' });
      return { kind: 'error', message: 'common.try-later' };
    } catch {
      return { kind: 'error', message: 'common.try-later' };
    }
  }

  /** Her four decisions (spec 13.1). Declining self-tracking ends enrolment. */
  async consent(decisions: object): Promise<View> {
    try {
      const res = await this.#s.fetch('/v1/enrolment/consent', json({ decisions }));
      if (res.ok) {
        const v = fromServer((await res.json()) as ServerView, null);
        return v.kind === 'ended' ? { kind: 'ended', message: 'consent.declined' } : v;
      }
      if (res.status === 404) return this.#settle({ kind: 'ended', message: 'enrol.expired' });
      return { kind: 'error', message: 'common.try-later' };
    } catch {
      return { kind: 'error', message: 'common.try-later' };
    }
  }

  async cancel(): Promise<View> {
    try {
      const res = await this.#s.fetch('/v1/enrolment/cancel', json({}));
      if (res.ok || res.status === 404)
        return this.#settle({ kind: 'ended', message: 'enrol.stopped' });
      return { kind: 'error', message: 'common.try-later' };
    } catch {
      return { kind: 'error', message: 'common.try-later' };
    }
  }
}

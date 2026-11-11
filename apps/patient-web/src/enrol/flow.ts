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

/** Maps the server's view of the transaction to what the page shows. */
export function fromServer(v: ServerView, code: string | null): View {
  if (v.expired) return { kind: 'ended', message: 'enrol.expired' };
  if (v.status === 'awaiting-confirmation') return { kind: 'code', code, status: v.status };
  if (v.status === 'cancelling' || v.status === 'cancelled')
    return { kind: 'ended', message: 'enrol.cancelled' };
  return { kind: 'confirmed' };
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

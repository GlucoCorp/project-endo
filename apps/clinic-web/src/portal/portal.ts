import type { MessageKey } from '@endo/i18n';

/**
 * Clinic portal logic (ADR-0019, ADR-0021 slice 3), over a fetch seam so it is tested without a
 * DOM. State-changing calls send this session's CSRF token, which the BFF delivers only in the
 * same-origin, no-store `/v1/session` body, and JSON (never a form post).
 */

export interface Organisation {
  readonly index: number;
  readonly orgId: string;
  readonly role: string;
}

export interface Invitation {
  readonly id: string;
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly inUse: boolean;
}

/** REQ-001: accepted, and whether she shares with the care team. Nothing that says who she is. */
export interface AcceptedInvitation {
  readonly id: string;
  readonly acceptedAt: string;
  readonly sharing: 'shared' | 'declined' | 'pending';
}

export interface InvitationLists {
  readonly open: readonly Invitation[];
  readonly accepted: readonly AcceptedInvitation[];
}

const SHARING: ReadonlySet<string> = new Set(['shared', 'declined', 'pending']);

export type SessionView =
  | { readonly kind: 'signed-out' }
  | { readonly kind: 'choose-org'; readonly organisations: readonly Organisation[] }
  | { readonly kind: 'active'; readonly role: string }
  | { readonly kind: 'error'; readonly message: MessageKey };

export type ConfirmResult =
  | { readonly kind: 'confirmed' }
  | { readonly kind: 'wrong'; readonly remaining: number }
  | { readonly kind: 'locked'; readonly until: string }
  | { readonly kind: 'unavailable' }
  | { readonly kind: 'error'; readonly message: MessageKey };

const CODE = /^[0-9]{6}$/;

export class Portal {
  readonly #fetch: typeof fetch;
  #csrf = '';

  constructor(f: typeof fetch) {
    this.#fetch = f;
  }

  #post(path: string, body: object): Promise<Response> {
    return this.#fetch(path, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json', 'x-csrf-token': this.#csrf },
      body: JSON.stringify(body),
    });
  }

  #fromSession(b: {
    state?: unknown;
    organisations?: unknown;
    active?: unknown;
    csrf_token?: unknown;
  }): SessionView {
    if (typeof b.csrf_token !== 'string') return { kind: 'error', message: 'common.try-later' };
    this.#csrf = b.csrf_token;
    if (b.state === 'active' && b.active && typeof b.active === 'object') {
      const role = (b.active as { role?: unknown }).role;
      return { kind: 'active', role: typeof role === 'string' ? role : '' };
    }
    const orgs = Array.isArray(b.organisations) ? (b.organisations as unknown[]) : [];
    return {
      kind: 'choose-org',
      organisations: orgs.flatMap((o) => {
        const v = o as { index?: unknown; org_id?: unknown; role?: unknown };
        return typeof v.index === 'number' &&
          typeof v.org_id === 'string' &&
          typeof v.role === 'string'
          ? [{ index: v.index, orgId: v.org_id, role: v.role }]
          : [];
      }),
    };
  }

  async session(): Promise<SessionView> {
    try {
      const res = await this.#fetch('/v1/session', { credentials: 'same-origin' });
      if (res.status === 401) return { kind: 'signed-out' };
      if (!res.ok) return { kind: 'error', message: 'common.try-later' };
      return this.#fromSession((await res.json()) as Record<string, unknown>);
    } catch {
      return { kind: 'error', message: 'common.try-later' };
    }
  }

  async chooseOrganisation(index: number): Promise<SessionView> {
    try {
      const res = await this.#post('/v1/session/organisation', { index });
      if (res.status === 401) return { kind: 'signed-out' };
      if (!res.ok) return { kind: 'error', message: 'common.try-later' };
      return this.#fromSession((await res.json()) as Record<string, unknown>);
    } catch {
      return { kind: 'error', message: 'common.try-later' };
    }
  }

  async invitations(): Promise<InvitationLists | null> {
    try {
      const res = await this.#fetch('/v1/enrolments', { credentials: 'same-origin' });
      if (!res.ok) return null;
      const b = (await res.json()) as { invitations?: unknown; accepted?: unknown };
      if (!Array.isArray(b.invitations) || !Array.isArray(b.accepted)) return null;
      const accepted = (b.accepted as Record<string, unknown>[]).flatMap((a) =>
        typeof a['id'] === 'string' &&
        typeof a['accepted_at'] === 'string' &&
        typeof a['sharing'] === 'string' &&
        SHARING.has(a['sharing'])
          ? [
              {
                id: a['id'],
                acceptedAt: a['accepted_at'],
                sharing: a['sharing'] as AcceptedInvitation['sharing'],
              },
            ]
          : [],
      );
      const open = (b.invitations as Record<string, unknown>[]).flatMap((i) =>
        typeof i['id'] === 'string' &&
        typeof i['created_at'] === 'string' &&
        typeof i['expires_at'] === 'string' &&
        typeof i['in_use'] === 'boolean'
          ? [
              {
                id: i['id'],
                createdAt: i['created_at'],
                expiresAt: i['expires_at'],
                inUse: i['in_use'],
              },
            ]
          : [],
      );
      return { open, accepted };
    } catch {
      return null;
    }
  }

  /** Checks the input first: nothing is sent unless both attestations are true. */
  async confirm(
    invitationId: string,
    code: string,
    attest: { identified: boolean; ownPhone: boolean },
  ): Promise<ConfirmResult> {
    if (!attest.identified || !attest.ownPhone)
      return { kind: 'error', message: 'clinic.attest-required' };
    if (!CODE.test(code)) return { kind: 'error', message: 'clinic.code-format' };
    try {
      const res = await this.#post(`/v1/enrolments/${encodeURIComponent(invitationId)}/confirm`, {
        code,
        identified: true,
        own_phone: true,
      });
      if (res.status === 429) return { kind: 'error', message: 'common.too-many' };
      if (!res.ok) return { kind: 'error', message: 'common.try-later' };
      const b = (await res.json()) as Record<string, unknown>;
      if (b['outcome'] === 'confirmed') return { kind: 'confirmed' };
      if (b['outcome'] === 'unavailable') return { kind: 'unavailable' };
      if (b['outcome'] === 'wrong' && typeof b['remaining'] === 'number')
        return { kind: 'wrong', remaining: b['remaining'] };
      if (b['outcome'] === 'locked' && typeof b['locked_until'] === 'string')
        return { kind: 'locked', until: b['locked_until'] };
      return { kind: 'error', message: 'common.try-later' };
    } catch {
      return { kind: 'error', message: 'common.try-later' };
    }
  }
}

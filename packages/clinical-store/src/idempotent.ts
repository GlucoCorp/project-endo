import { sql, type Kysely } from 'kysely';
import { withOrg } from './org-scope.ts';
import type { ClinicalDatabase } from './schema.ts';
import type { NewInvitation } from './invitations.ts';

/** A response sealed under its own data key (see EnvelopeSealer in @endo/crypto). */
export interface SealedResponse {
  readonly wrappedKey: string;
  readonly envelope: string;
}

export interface IdempotencyKey {
  /** Clinical-store id of the caller; keys are scoped per actor. */
  readonly actorRef: string;
  /** UUID from the Idempotency-Key header. */
  readonly key: string;
  /** SHA-256 hex of the canonical request; a reused key with another request is a conflict. */
  readonly requestHash: string;
}

export type IdempotentOutcome =
  | { readonly kind: 'created'; readonly expiresAt: Date }
  | { readonly kind: 'replay'; readonly statusCode: number; readonly sealed: SealedResponse }
  /** The key was used for a different request. */
  | { readonly kind: 'conflict' }
  /** The key is past its 24-hour replay window; keys are never reused. */
  | { readonly kind: 'expired' };

export interface CreateInvitationOnce {
  readonly invitation: NewInvitation;
  readonly idempotency: IdempotencyKey;
  /** Audit event (opaque ids and codes only), queued in the same transaction (spec 2.6). */
  readonly auditEvent: Readonly<Record<string, unknown>> & { readonly id: string };
  /** Seals the response once the database has set the expiry. */
  readonly sealResponse: (expiresAt: Date) => Promise<SealedResponse>;
}

const OPERATION = 'enrolment.create';

/** An open invitation as the clinic portal lists it: ids and times only, never the token. */
export interface OpenInvitation {
  readonly id: string;
  readonly createdAt: Date;
  readonly expiresAt: Date;
  /** An enrolment transaction holds it (ADR-0021 section 6). */
  readonly reserved: boolean;
}

/** Invitation creation that happens at most once per Idempotency-Key (spec 9.1, REQ-001). */
export interface IdempotentInvitationStore {
  createOnce(request: CreateInvitationOnce): Promise<IdempotentOutcome>;
  /**
   * The organisation's invitations that can still be used (not claimed, revoked or expired),
   * newest first, at most 100. Read inside the organisation's row-level-security scope.
   */
  listOpen(orgId: string): Promise<OpenInvitation[]>;
}

export class PostgresIdempotentInvitationStore implements IdempotentInvitationStore {
  readonly #db: Kysely<ClinicalDatabase>;

  constructor(db: Kysely<ClinicalDatabase>) {
    this.#db = db;
  }

  listOpen(orgId: string): Promise<OpenInvitation[]> {
    return withOrg(this.#db, orgId, async (trx) => {
      const rows = await trx
        .selectFrom('enrolment_invitation')
        .select(['id', 'created_at', 'expires_at', 'reserved_by'])
        .where('org_id', '=', orgId)
        .where('claimed_at', 'is', null)
        .where('revoked_at', 'is', null)
        .where('expires_at', '>', sql<Date>`now()`)
        .orderBy('created_at', 'desc')
        .limit(100)
        .execute();
      return rows.map((r) => ({
        id: r.id,
        createdAt: r.created_at,
        expiresAt: r.expires_at,
        reserved: r.reserved_by !== null,
      }));
    });
  }

  async createOnce(r: CreateInvitationOnce): Promise<IdempotentOutcome> {
    const { invitation: i, idempotency: k } = r;
    return withOrg(this.#db, i.orgId, async (trx) => {
      // Serialise concurrent retries of the same key; the loser then sees the winner's row.
      await trx
        .selectNoFrom((eb) =>
          eb
            .fn('pg_advisory_xact_lock', [
              eb.fn('hashtextextended', [
                eb.val(['idem', i.orgId, k.actorRef, OPERATION, k.key].join(':')),
                eb.lit(0),
              ]),
            ])
            .as('locked'),
        )
        .execute();

      const existing = await trx
        .selectFrom('idempotency_record')
        .select(['request_hash', 'status_code', 'response_wrapped_key', 'response_envelope'])
        // clock_timestamp(), not now(): the lock wait may have carried us past the expiry.
        .select((eb) => eb('expires_at', '>', sql<Date>`clock_timestamp()`).as('live'))
        .where('org_id', '=', i.orgId)
        .where('actor_ref', '=', k.actorRef)
        .where('operation', '=', OPERATION)
        .where('idem_key', '=', k.key)
        .executeTakeFirst();
      if (existing) {
        if (existing.request_hash !== k.requestHash) return { kind: 'conflict' };
        // Past the window, or purged to a tombstone: never served, never created again.
        if (!existing.live || !existing.response_wrapped_key || !existing.response_envelope) {
          return { kind: 'expired' };
        }
        return {
          kind: 'replay',
          statusCode: existing.status_code,
          sealed: {
            wrappedKey: existing.response_wrapped_key,
            envelope: existing.response_envelope,
          },
        };
      }

      const created = await trx
        .insertInto('enrolment_invitation')
        .values({
          id: i.id,
          org_id: i.orgId,
          created_by: i.createdBy,
          token_hash: i.tokenHash,
          expires_at: sql<Date>`now() + interval '7 days'`,
        })
        .returning('expires_at')
        .executeTakeFirstOrThrow();
      const sealed = await r.sealResponse(created.expires_at);
      await trx
        .insertInto('idempotency_record')
        .values({
          org_id: i.orgId,
          actor_ref: k.actorRef,
          operation: OPERATION,
          idem_key: k.key,
          request_hash: k.requestHash,
          status_code: 201,
          response_wrapped_key: sealed.wrappedKey,
          response_envelope: sealed.envelope,
        })
        .execute();
      await trx
        .insertInto('audit_outbox')
        .values({ id: r.auditEvent.id, event: JSON.stringify(r.auditEvent) })
        .execute();
      return { kind: 'created', expiresAt: created.expires_at };
    });
  }
}

/** Dev and test stand-in with the same semantics, including the 24-hour window. */
export class InMemoryIdempotentInvitationStore implements IdempotentInvitationStore {
  readonly invitations: (NewInvitation & { expiresAt: Date })[] = [];
  readonly outbox: Readonly<Record<string, unknown>>[] = [];
  readonly #records = new Map<
    string,
    Promise<{ requestHash: string; sealed: SealedResponse; until: number } | null>
  >();
  readonly #now: () => Date;

  constructor(now: () => Date = () => new Date()) {
    this.#now = now;
  }

  listOpen(orgId: string): Promise<OpenInvitation[]> {
    const now = this.#now().getTime();
    return Promise.resolve(
      this.invitations
        .filter((i) => i.orgId === orgId && i.expiresAt.getTime() > now)
        .map((i) => ({
          id: i.id,
          createdAt: new Date(i.expiresAt.getTime() - 7 * 24 * 60 * 60 * 1000),
          expiresAt: i.expiresAt,
          reserved: false,
        }))
        .reverse(),
    );
  }

  async createOnce(r: CreateInvitationOnce): Promise<IdempotentOutcome> {
    const k = r.idempotency;
    const id = [r.invitation.orgId, k.actorRef, k.key].join(':');
    const pending = this.#records.get(id);
    if (pending) {
      const existing = await pending;
      if (existing) {
        if (existing.requestHash !== k.requestHash) return { kind: 'conflict' };
        if (this.#now().getTime() >= existing.until) return { kind: 'expired' };
        return { kind: 'replay', statusCode: 201, sealed: existing.sealed };
      }
    }
    // Reserve the key before any await, so concurrent calls wait for this one.
    const now = this.#now().getTime();
    const expiresAt = new Date(now + 7 * 24 * 60 * 60 * 1000);
    const work = r.sealResponse(expiresAt).then((sealed) => ({
      requestHash: k.requestHash,
      sealed,
      until: now + 24 * 60 * 60 * 1000,
    }));
    this.#records.set(
      id,
      work.catch(() => null),
    );
    try {
      await work;
    } catch (error) {
      this.#records.delete(id);
      throw error;
    }
    this.invitations.push({ ...r.invitation, expiresAt });
    this.outbox.push(r.auditEvent);
    return { kind: 'created', expiresAt };
  }
}

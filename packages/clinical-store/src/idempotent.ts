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
  | { readonly kind: 'conflict' };

export interface CreateInvitationOnce {
  readonly invitation: NewInvitation;
  readonly idempotency: IdempotencyKey;
  /** Audit event (opaque ids and codes only), queued in the same transaction (spec 2.6). */
  readonly auditEvent: Readonly<Record<string, unknown>> & { readonly id: string };
  /** Seals the response once the database has set the expiry. */
  readonly sealResponse: (expiresAt: Date) => Promise<SealedResponse>;
}

const OPERATION = 'enrolment.create';

/** Invitation creation that happens at most once per Idempotency-Key (spec 9.1, REQ-001). */
export interface IdempotentInvitationStore {
  createOnce(request: CreateInvitationOnce): Promise<IdempotentOutcome>;
}

export class PostgresIdempotentInvitationStore implements IdempotentInvitationStore {
  readonly #db: Kysely<ClinicalDatabase>;

  constructor(db: Kysely<ClinicalDatabase>) {
    this.#db = db;
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
        .select((eb) => eb('expires_at', '>', sql<Date>`now()`).as('live'))
        .where('org_id', '=', i.orgId)
        .where('actor_ref', '=', k.actorRef)
        .where('operation', '=', OPERATION)
        .where('idem_key', '=', k.key)
        .executeTakeFirst();
      if (existing) {
        // An expired key is never reused: UUID keys are single-use by design.
        if (!existing.live || existing.request_hash !== k.requestHash) return { kind: 'conflict' };
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

/** Dev and test stand-in with the same semantics (records do not expire). */
export class InMemoryIdempotentInvitationStore implements IdempotentInvitationStore {
  readonly invitations: (NewInvitation & { expiresAt: Date })[] = [];
  readonly outbox: Readonly<Record<string, unknown>>[] = [];
  readonly #records = new Map<string, { requestHash: string; sealed: SealedResponse }>();
  readonly #now: () => Date;

  constructor(now: () => Date = () => new Date()) {
    this.#now = now;
  }

  async createOnce(r: CreateInvitationOnce): Promise<IdempotentOutcome> {
    const k = r.idempotency;
    const id = [r.invitation.orgId, k.actorRef, k.key].join(':');
    const existing = this.#records.get(id);
    if (existing) {
      return existing.requestHash === k.requestHash
        ? { kind: 'replay', statusCode: 201, sealed: existing.sealed }
        : { kind: 'conflict' };
    }
    const expiresAt = new Date(this.#now().getTime() + 7 * 24 * 60 * 60 * 1000);
    const sealed = await r.sealResponse(expiresAt);
    this.invitations.push({ ...r.invitation, expiresAt });
    this.#records.set(id, { requestHash: k.requestHash, sealed });
    this.outbox.push(r.auditEvent);
    return { kind: 'created', expiresAt };
  }
}

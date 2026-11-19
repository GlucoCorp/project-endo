import { sql, type Kysely } from 'kysely';
import { withOrg } from './org-scope.ts';
import type { ClinicalDatabase } from './schema.ts';

type Audit = Readonly<Record<string, unknown>> & { readonly id: string };

/** A share link as she sees it in her list (never the token, which only the link holds). */
export interface ShareLink {
  readonly id: string;
  readonly createdAt: Date;
  readonly expiresAt: Date;
  readonly revokedAt: Date | null;
}

export interface LiveShareLink {
  readonly id: string;
  readonly orgId: string;
  readonly patientId: string;
  readonly expiresAt: Date;
}

/** Share links (REQ-008): created by her, revoked by her, found by the link's token hash. */
export interface ShareLinkStore {
  create(l: {
    readonly id: string;
    readonly orgId: string;
    readonly patientId: string;
    readonly tokenHash: string;
    readonly days: number;
    /** Her Idempotency-Key: a retry returns the link it already made, with `replay: true`. */
    readonly creationKey: string;
    readonly auditEvent: Audit;
  }): Promise<ShareLink & { readonly replay: boolean }>;
  /** Every live link, and the latest 100 others, newest first (a live link is never hidden). */
  list(orgId: string, patientId: string): Promise<ShareLink[]>;
  /** Every link of hers ever made (ids only), for her access log (spec 13.3). */
  ids(orgId: string, patientId: string): Promise<string[]>;
  /** Stops sharing now. False if it is not hers or was already stopped. */
  revoke(orgId: string, patientId: string, id: string, auditEvent: Audit): Promise<boolean>;
  /** A live link by its token's SHA-256 (cross-organisation, ids only), or null. */
  findLive(tokenHash: string): Promise<LiveShareLink | null>;
}

export class PostgresShareLinkStore implements ShareLinkStore {
  readonly #db: Kysely<ClinicalDatabase>;

  constructor(db: Kysely<ClinicalDatabase>) {
    this.#db = db;
  }

  create(
    l: Parameters<ShareLinkStore['create']>[0],
  ): Promise<ShareLink & { readonly replay: boolean }> {
    if (!Number.isInteger(l.days) || l.days < 1 || l.days > 30)
      return Promise.reject(new TypeError('a share link lasts 1 to 30 days'));
    return withOrg(this.#db, l.orgId, async (trx) => {
      const existing = await trx
        .selectFrom('share_link')
        .select(['id', 'created_at', 'expires_at', 'revoked_at'])
        .where('patient_id', '=', l.patientId)
        .where('creation_key', '=', l.creationKey)
        .executeTakeFirst();
      const row =
        existing ??
        (await trx
          .insertInto('share_link')
          .values({
            id: l.id,
            org_id: l.orgId,
            patient_id: l.patientId,
            token_hash: l.tokenHash,
            // The database clamps this to its own clock plus 30 days at most (migration 0013).
            expires_at: new Date(Date.now() + l.days * 86_400_000),
            creation_key: l.creationKey,
          })
          .returning(['id', 'created_at', 'expires_at', 'revoked_at'])
          .executeTakeFirstOrThrow());
      if (!existing)
        await trx
          .insertInto('audit_outbox')
          .values({ id: l.auditEvent.id, event: JSON.stringify(l.auditEvent) })
          .execute();
      return {
        id: row.id,
        createdAt: row.created_at,
        expiresAt: row.expires_at,
        revokedAt: row.revoked_at,
        replay: existing !== undefined,
      };
    });
  }

  list(orgId: string, patientId: string): Promise<ShareLink[]> {
    return withOrg(this.#db, orgId, async (trx) => {
      const rows = await trx
        .selectFrom('share_link')
        .select(['id', 'created_at', 'expires_at', 'revoked_at'])
        .where('patient_id', '=', patientId)
        .where((eb) =>
          eb.or([
            eb.and([eb('revoked_at', 'is', null), eb('expires_at', '>', sql<Date>`now()`)]),
            eb(
              'id',
              'in',
              eb
                .selectFrom('share_link as recent')
                .select('recent.id')
                .where('recent.patient_id', '=', patientId)
                .orderBy('recent.created_at', 'desc')
                .limit(100),
            ),
          ]),
        )
        .orderBy('created_at', 'desc')
        .execute();
      return rows.map((r) => ({
        id: r.id,
        createdAt: r.created_at,
        expiresAt: r.expires_at,
        revokedAt: r.revoked_at,
      }));
    });
  }

  ids(orgId: string, patientId: string): Promise<string[]> {
    return withOrg(this.#db, orgId, async (trx) =>
      (
        await trx
          .selectFrom('share_link')
          .select('id')
          .where('patient_id', '=', patientId)
          .execute()
      ).map((r) => r.id),
    );
  }

  revoke(orgId: string, patientId: string, id: string, auditEvent: Audit): Promise<boolean> {
    return withOrg(this.#db, orgId, async (trx) => {
      const r = await trx
        .updateTable('share_link')
        .set({ revoked_at: new Date() })
        .where('id', '=', id)
        .where('patient_id', '=', patientId)
        .where('revoked_at', 'is', null)
        .executeTakeFirst();
      if (Number(r.numUpdatedRows) === 0) return false;
      await trx
        .insertInto('audit_outbox')
        .values({ id: auditEvent.id, event: JSON.stringify(auditEvent) })
        .execute();
      return true;
    });
  }

  async findLive(tokenHash: string): Promise<LiveShareLink | null> {
    if (!/^[0-9a-f]{64}$/.test(tokenHash)) throw new TypeError('tokenHash must be SHA-256 hex');
    const row = await this.#db
      .selectNoFrom((eb) =>
        eb
          .fn<{ id: string; org_id: string; patient_id: string; expires_at: string } | null>(
            'share_link_find_live',
            [eb.val(tokenHash)],
          )
          .as('found'),
      )
      .executeTakeFirstOrThrow();
    const f = row.found;
    return f
      ? { id: f.id, orgId: f.org_id, patientId: f.patient_id, expiresAt: new Date(f.expires_at) }
      : null;
  }
}

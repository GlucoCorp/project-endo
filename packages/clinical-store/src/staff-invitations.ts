import type { Kysely } from 'kysely';
import { withOrg } from './org-scope.ts';
import type { ClinicalDatabase } from './schema.ts';

type Audit = Readonly<Record<string, unknown>> & { readonly id: string };

export interface StaffInvitation {
  readonly id: string;
  readonly role: 'clinician' | 'org_admin';
  readonly createdAt: Date;
  readonly expiresAt: Date;
  readonly claimedAt: Date | null;
  readonly revokedAt: Date | null;
}

export type StaffClaimOutcome =
  | { readonly outcome: 'claimed'; readonly orgId: string; readonly role: string }
  | { readonly outcome: 'unavailable' | 'already_member' };

/** Staff invitations (REQ-010): made and stopped by an org admin, claimed after sign-in. */
export interface StaffInvitationStore {
  create(i: {
    readonly id: string;
    readonly orgId: string;
    readonly role: 'clinician' | 'org_admin';
    readonly tokenHash: string;
    readonly createdBy: string;
    readonly days: number;
    readonly auditEvent: Audit;
  }): Promise<StaffInvitation>;
  /** The latest 100, newest first. */
  list(orgId: string): Promise<StaffInvitation[]>;
  /** False if it is not this organisation's, or already used or stopped. */
  revoke(orgId: string, id: string, auditEvent: Audit): Promise<boolean>;
  /**
   * Cross-organisation by the token's hash: makes `identityRef` a member with the invitation's
   * role. The audit event's organisation and resource are filled in by the database.
   */
  claim(c: {
    readonly tokenHash: string;
    readonly identityRef: string;
    readonly clinicianId: string;
    readonly auditEvent: Audit;
  }): Promise<StaffClaimOutcome>;
}

const toInvitation = (r: {
  id: string;
  role: 'clinician' | 'org_admin';
  created_at: Date;
  expires_at: Date;
  claimed_at: Date | null;
  revoked_at: Date | null;
}): StaffInvitation => ({
  id: r.id,
  role: r.role,
  createdAt: r.created_at,
  expiresAt: r.expires_at,
  claimedAt: r.claimed_at,
  revokedAt: r.revoked_at,
});

const COLUMNS = ['id', 'role', 'created_at', 'expires_at', 'claimed_at', 'revoked_at'] as const;

export class PostgresStaffInvitationStore implements StaffInvitationStore {
  readonly #db: Kysely<ClinicalDatabase>;

  constructor(db: Kysely<ClinicalDatabase>) {
    this.#db = db;
  }

  create(i: Parameters<StaffInvitationStore['create']>[0]): Promise<StaffInvitation> {
    return withOrg(this.#db, i.orgId, async (trx) => {
      const row = await trx
        .insertInto('staff_invitation')
        .values({
          id: i.id,
          org_id: i.orgId,
          role: i.role,
          token_hash: i.tokenHash,
          created_by: i.createdBy,
          // The database clamps to 7 days from its own clock.
          expires_at: new Date(Date.now() + i.days * 86_400_000),
        })
        .returning(COLUMNS)
        .executeTakeFirstOrThrow();
      await trx
        .insertInto('audit_outbox')
        .values({ id: i.auditEvent.id, event: JSON.stringify(i.auditEvent) })
        .execute();
      return toInvitation(row);
    });
  }

  list(orgId: string): Promise<StaffInvitation[]> {
    return withOrg(this.#db, orgId, async (trx) =>
      (
        await trx
          .selectFrom('staff_invitation')
          .select(COLUMNS)
          .orderBy('created_at', 'desc')
          .limit(100)
          .execute()
      ).map(toInvitation),
    );
  }

  revoke(orgId: string, id: string, auditEvent: Audit): Promise<boolean> {
    return withOrg(this.#db, orgId, async (trx) => {
      const r = await trx
        .updateTable('staff_invitation')
        .set({ revoked_at: new Date() })
        .where('id', '=', id)
        .where('claimed_at', 'is', null)
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

  async claim(c: Parameters<StaffInvitationStore['claim']>[0]): Promise<StaffClaimOutcome> {
    const r = await this.#db
      .selectNoFrom((eb) =>
        eb
          .fn<{ outcome: string; org_id?: string; role?: string }>('staff_invitation_claim', [
            eb.val(c.tokenHash),
            eb.val(c.identityRef),
            eb.val(c.clinicianId),
            eb.val(JSON.stringify(c.auditEvent)),
          ])
          .as('r'),
      )
      .executeTakeFirstOrThrow();
    if (r.r.outcome === 'claimed' && r.r.org_id && r.r.role)
      return { outcome: 'claimed', orgId: r.r.org_id, role: r.r.role };
    return { outcome: r.r.outcome === 'already_member' ? 'already_member' : 'unavailable' };
  }
}

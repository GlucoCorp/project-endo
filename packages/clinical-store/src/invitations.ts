import { sql, type Kysely } from 'kysely';
import { withOrg } from './org-scope.ts';
import type { ClinicalDatabase } from './schema.ts';

export interface NewInvitation {
  readonly id: string;
  readonly orgId: string;
  /** Clinician (clinical-store id) who issued it; must belong to `orgId`. */
  readonly createdBy: string;
  /** SHA-256 hex of the link token. The token itself is never stored. */
  readonly tokenHash: string;
}

/** Stores a new enrolment invitation inside its organisation (REQ-001). */
export interface InvitationStore {
  /** Returns the expiry, which the database sets to 7 days after its own clock (REQ-001). */
  create(invitation: NewInvitation): Promise<{ expiresAt: Date }>;
}

export class PostgresInvitationStore implements InvitationStore {
  readonly #db: Kysely<ClinicalDatabase>;

  constructor(db: Kysely<ClinicalDatabase>) {
    this.#db = db;
  }

  async create(i: NewInvitation): Promise<{ expiresAt: Date }> {
    const row = await withOrg(this.#db, i.orgId, (trx) =>
      trx
        .insertInto('enrolment_invitation')
        .values({
          id: i.id,
          org_id: i.orgId,
          created_by: i.createdBy,
          token_hash: i.tokenHash,
          // Same transaction, same now() as created_at: exactly the 7-day maximum.
          expires_at: sql<Date>`now() + interval '7 days'`,
        })
        .returning('expires_at')
        .executeTakeFirstOrThrow(),
    );
    return { expiresAt: row.expires_at };
  }
}

/** Dev and test stand-in. Keeps invitations in memory; `main.ts` refuses it in deployed envs. */
export class InMemoryInvitationStore implements InvitationStore {
  readonly invitations: (NewInvitation & { expiresAt: Date })[] = [];
  readonly #now: () => Date;

  constructor(now: () => Date = () => new Date()) {
    this.#now = now;
  }

  create(invitation: NewInvitation): Promise<{ expiresAt: Date }> {
    const expiresAt = new Date(this.#now().getTime() + 7 * 24 * 60 * 60 * 1000);
    this.invitations.push({ ...invitation, expiresAt });
    return Promise.resolve({ expiresAt });
  }
}

/** A clinician's current membership of one organisation, from the clinical store. */
export interface ClinicianMembership {
  /** clinical-store `clinician.id`, used for `created_by` and other references. */
  readonly clinicianId: string;
  readonly role: 'clinician' | 'org_admin';
  readonly active: boolean;
}

/**
 * Resolves the caller's membership. The service-token `sub` of a clinician is their identity
 * reference (`clinician.identity_ref`), never the clinical id (ADR-0017).
 */
export interface MembershipStore {
  find(orgId: string, identityRef: string): Promise<ClinicianMembership | null>;
  /**
   * ADR-0019: every ACTIVE membership of this person, across organisations, before one is chosen.
   * Uses the dedicated lookup function (migration 0004); returns only organisation and role.
   */
  listActive(identityRef: string): Promise<{ orgId: string; role: 'clinician' | 'org_admin' }[]>;
}

export class PostgresMembershipStore implements MembershipStore {
  readonly #db: Kysely<ClinicalDatabase>;

  constructor(db: Kysely<ClinicalDatabase>) {
    this.#db = db;
  }

  async find(orgId: string, identityRef: string): Promise<ClinicianMembership | null> {
    const row = await withOrg(this.#db, orgId, (trx) =>
      trx
        .selectFrom('clinician')
        .select(['id', 'role', 'active'])
        .where('org_id', '=', orgId)
        .where('identity_ref', '=', identityRef)
        .executeTakeFirst(),
    );
    return row ? { clinicianId: row.id, role: row.role, active: row.active } : null;
  }

  async listActive(
    identityRef: string,
  ): Promise<{ orgId: string; role: 'clinician' | 'org_admin' }[]> {
    const row = await this.#db
      .selectNoFrom((eb) =>
        eb
          .fn<{ org_id: string; role: 'clinician' | 'org_admin' }[]>(
            'clinician_memberships_active',
            [eb.val(identityRef)],
          )
          .as('memberships'),
      )
      .executeTakeFirstOrThrow();
    return row.memberships.map((m) => ({ orgId: m.org_id, role: m.role }));
  }
}

/** Dev and test stand-in. */
export class InMemoryMembershipStore implements MembershipStore {
  readonly #rows = new Map<string, ClinicianMembership>();

  add(orgId: string, identityRef: string, membership: ClinicianMembership): this {
    this.#rows.set(`${orgId}:${identityRef}`, membership);
    return this;
  }

  find(orgId: string, identityRef: string): Promise<ClinicianMembership | null> {
    return Promise.resolve(this.#rows.get(`${orgId}:${identityRef}`) ?? null);
  }

  listActive(identityRef: string): Promise<{ orgId: string; role: 'clinician' | 'org_admin' }[]> {
    const out: { orgId: string; role: 'clinician' | 'org_admin' }[] = [];
    for (const [key, m] of this.#rows) {
      const [orgId, ref] = key.split(':');
      if (ref === identityRef && orgId && m.active) out.push({ orgId, role: m.role });
    }
    return Promise.resolve(out.sort((a, b) => a.orgId.localeCompare(b.orgId)));
  }
}

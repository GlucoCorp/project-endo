import type { Kysely } from 'kysely';
import { withOrg } from './org-scope.ts';
import type { ClinicalDatabase } from './schema.ts';

type Audit = Readonly<Record<string, unknown>> & { readonly id: string };

export interface OrgSettings {
  readonly defaultReviewIntervalWeeks: number | null;
  readonly languages: readonly string[];
  readonly emergencyNumber: string | null;
  readonly updatedAt: Date | null;
}

export interface OrgMember {
  readonly clinicianId: string;
  readonly identityRef: string;
  readonly role: 'clinician' | 'org_admin';
  readonly active: boolean;
  readonly createdAt: Date;
}

export type MemberChangeOutcome = 'changed' | 'unchanged' | 'not_found' | 'last_admin';

/** Organisation admin (REQ-010): settings and members, always inside one organisation. */
export interface OrgAdminStore {
  settings(orgId: string): Promise<OrgSettings>;
  saveSettings(s: {
    readonly orgId: string;
    readonly clinicianId: string;
    readonly defaultReviewIntervalWeeks: number | null;
    readonly languages: readonly string[];
    readonly emergencyNumber: string | null;
    readonly auditEvent: Audit;
  }): Promise<OrgSettings>;
  members(orgId: string): Promise<OrgMember[]>;
  /** Role and active flag; refused if it would leave the organisation without an active admin. */
  changeMember(c: {
    readonly orgId: string;
    readonly clinicianId: string;
    readonly role: 'clinician' | 'org_admin';
    readonly active: boolean;
    readonly auditEvent: Audit;
  }): Promise<MemberChangeOutcome>;
}

const DEFAULTS: OrgSettings = {
  defaultReviewIntervalWeeks: null,
  languages: ['en'],
  emergencyNumber: null,
  updatedAt: null,
};

export class PostgresOrgAdminStore implements OrgAdminStore {
  readonly #db: Kysely<ClinicalDatabase>;

  constructor(db: Kysely<ClinicalDatabase>) {
    this.#db = db;
  }

  settings(orgId: string): Promise<OrgSettings> {
    return withOrg(this.#db, orgId, async (trx) => {
      const r = await trx
        .selectFrom('org_settings')
        .select(['default_review_interval_weeks', 'languages', 'emergency_number', 'updated_at'])
        .where('org_id', '=', orgId)
        .executeTakeFirst();
      return r
        ? {
            defaultReviewIntervalWeeks: r.default_review_interval_weeks,
            languages: r.languages,
            emergencyNumber: r.emergency_number,
            updatedAt: r.updated_at,
          }
        : DEFAULTS;
    });
  }

  saveSettings(s: Parameters<OrgAdminStore['saveSettings']>[0]): Promise<OrgSettings> {
    return withOrg(this.#db, s.orgId, async (trx) => {
      const values = {
        default_review_interval_weeks: s.defaultReviewIntervalWeeks,
        languages: [...s.languages],
        emergency_number: s.emergencyNumber,
        updated_by: s.clinicianId,
      };
      const r = await trx
        .insertInto('org_settings')
        .values({ org_id: s.orgId, ...values })
        .onConflict((oc) => oc.column('org_id').doUpdateSet(values))
        .returning(['default_review_interval_weeks', 'languages', 'emergency_number', 'updated_at'])
        .executeTakeFirstOrThrow();
      await trx
        .insertInto('audit_outbox')
        .values({ id: s.auditEvent.id, event: JSON.stringify(s.auditEvent) })
        .execute();
      return {
        defaultReviewIntervalWeeks: r.default_review_interval_weeks,
        languages: r.languages,
        emergencyNumber: r.emergency_number,
        updatedAt: r.updated_at,
      };
    });
  }

  members(orgId: string): Promise<OrgMember[]> {
    return withOrg(this.#db, orgId, async (trx) => {
      const rows = await trx
        .selectFrom('clinician')
        .select(['id', 'identity_ref', 'role', 'active', 'created_at'])
        .where('org_id', '=', orgId)
        .orderBy('created_at')
        .execute();
      return rows.map((r) => ({
        clinicianId: r.id,
        identityRef: r.identity_ref,
        role: r.role,
        active: r.active,
        createdAt: r.created_at,
      }));
    });
  }

  async changeMember(
    c: Parameters<OrgAdminStore['changeMember']>[0],
  ): Promise<MemberChangeOutcome> {
    try {
      return await withOrg(this.#db, c.orgId, async (trx) => {
        const before = await trx
          .selectFrom('clinician')
          .select(['role', 'active'])
          .where('id', '=', c.clinicianId)
          .forUpdate()
          .executeTakeFirst();
        if (!before) return 'not_found' as const;
        if (before.role === c.role && before.active === c.active) return 'unchanged' as const;
        await trx
          .updateTable('clinician')
          .set({ role: c.role, active: c.active })
          .where('id', '=', c.clinicianId)
          .execute();
        await trx
          .insertInto('audit_outbox')
          .values({ id: c.auditEvent.id, event: JSON.stringify(c.auditEvent) })
          .execute();
        return 'changed' as const;
      });
    } catch (error) {
      // The deferred constraint trigger refuses at commit (REQ-010: never without an admin).
      if ((error as { code?: unknown } | null)?.code === '23514') return 'last_admin';
      throw error;
    }
  }
}

import type { Kysely } from 'kysely';
import { withOrg } from './org-scope.ts';
import type { ClinicalDatabase } from './schema.ts';

type Audit = Readonly<Record<string, unknown>> & { readonly id: string };

/**
 * SMART App Launch patient links (M7, spec 16.2): SHA-256(issuer | record-system patient id) to
 * one of the organisation's patients, made once by a clinician. Never the identifier itself.
 */
export interface EhrLinkStore {
  /** The linked patient in this organisation, or null. */
  resolve(orgId: string, linkHash: string): Promise<string | null>;
  /** Links once: 'exists' if this record-system patient is already linked (to anyone). */
  link(l: {
    readonly id: string;
    readonly orgId: string;
    readonly linkHash: string;
    readonly patientId: string;
    readonly clinicianId: string;
    readonly auditEvent: Audit;
  }): Promise<'linked' | 'exists'>;
}

export class PostgresEhrLinkStore implements EhrLinkStore {
  readonly #db: Kysely<ClinicalDatabase>;

  constructor(db: Kysely<ClinicalDatabase>) {
    this.#db = db;
  }

  resolve(orgId: string, linkHash: string): Promise<string | null> {
    return withOrg(this.#db, orgId, async (trx) => {
      const r = await trx
        .selectFrom('ehr_patient_link')
        .select('patient_id')
        .where('link_hash', '=', linkHash)
        .executeTakeFirst();
      return r?.patient_id ?? null;
    });
  }

  link(l: Parameters<EhrLinkStore['link']>[0]): Promise<'linked' | 'exists'> {
    return withOrg(this.#db, l.orgId, async (trx) => {
      const r = await trx
        .insertInto('ehr_patient_link')
        .values({
          id: l.id,
          org_id: l.orgId,
          link_hash: l.linkHash,
          patient_id: l.patientId,
          created_by: l.clinicianId,
        })
        .onConflict((oc) => oc.columns(['org_id', 'link_hash']).doNothing())
        .returning('id')
        .executeTakeFirst();
      if (!r) return 'exists' as const;
      await trx
        .insertInto('audit_outbox')
        .values({ id: l.auditEvent.id, event: JSON.stringify(l.auditEvent) })
        .execute();
      return 'linked' as const;
    });
  }
}

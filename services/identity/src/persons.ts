import type { Kysely } from 'kysely';
import { FieldCipher, type KeyManager } from '@endo/crypto';
import { PostgresPersonKeyStore, type IdentityDatabase } from '@endo/identity-store';

/** Identity fields as they arrive. Never stored or logged in this form. */
export interface NewPerson {
  readonly id: string;
  readonly email: string | null;
  readonly displayName: string | null;
}

export interface PersonStore {
  /**
   * Encrypts each field under the person's own key (`kms/identity`) and stores the person, all in
   * one transaction: on any failure nothing remains, neither the person nor a key.
   */
  create(person: NewPerson): Promise<void>;
  /**
   * REQ-009 and spec 11.4: in one transaction, marks erasure, clears the sign-in subject and
   * crypto-shreds the key (immediately). The hard delete of the row and links follows after the
   * 14-day grace period (jobs, M6). Idempotent. Returns false if the person is unknown.
   */
  erase(personId: string): Promise<boolean>;
  /**
   * REQ-009, ADR-0029: after erase(), removes her rows for good (person, patient links, email
   * codes, enrolment transactions); the key tombstone stays. True once she is gone (now or
   * before); false if she was never erased or is unknown.
   */
  purge(personId: string): Promise<boolean>;
  /**
   * ADR-0019: the person signed in as this identity-provider subject, or null. Erased people
   * never resolve (erasure clears the subject in the same transaction).
   */
  resolveSubject(idpSubject: string): Promise<string | null>;
  /**
   * REQ-009: her identity-provider subject while she has one (null once erased or never signed
   * in), so her account can be removed before erasure clears it.
   */
  subjectOf(personId: string): Promise<string | null>;
  /**
   * A returning patient's sign-in: the person for this subject and her patient records (each with
   * its organisation), or null when the subject is unknown or erased.
   */
  resolvePatient(idpSubject: string): Promise<PatientResolution | null>;
}

export interface PatientResolution {
  readonly personId: string;
  readonly patients: readonly { readonly patientId: string; readonly orgId: string }[];
}

/** Field contexts bind each ciphertext to its person, field and row (AES-GCM associated data). */
const ctx = (personId: string, field: string) => ({
  patientId: personId,
  field,
  recordId: personId,
});

export class PostgresPersonStore implements PersonStore {
  readonly #db: Kysely<IdentityDatabase>;
  readonly #kms: KeyManager;

  constructor(db: Kysely<IdentityDatabase>, kms: KeyManager) {
    this.#db = db;
    this.#kms = kms;
  }

  async create(p: NewPerson): Promise<void> {
    await this.#db.transaction().execute(async (trx) => {
      // Key store and cipher bound to this transaction, so a failure rolls back the key too.
      const cipher = new FieldCipher(this.#kms, new PostgresPersonKeyStore(trx), 'kms/identity');
      await trx.insertInto('person').values({ id: p.id }).execute();
      const email =
        p.email === null ? null : await cipher.encrypt(p.email, ctx(p.id, 'person.email'));
      const name =
        p.displayName === null
          ? null
          : await cipher.encrypt(p.displayName, ctx(p.id, 'person.display_name'));
      await trx
        .updateTable('person')
        .set({ email_encrypted: email, display_name_encrypted: name })
        .where('id', '=', p.id)
        .execute();
    });
  }

  async subjectOf(personId: string): Promise<string | null> {
    const row = await this.#db
      .selectFrom('person')
      .select('idp_subject')
      .where('id', '=', personId)
      .executeTakeFirst();
    return row?.idp_subject ?? null;
  }

  async erase(personId: string): Promise<boolean> {
    return this.#db.transaction().execute(async (trx) => {
      const person = await trx
        .selectFrom('person')
        .select('id')
        .where('id', '=', personId)
        .executeTakeFirst();
      if (!person) return false;
      await trx
        .updateTable('person')
        .set((eb) => ({
          deleted_at: eb.fn.coalesce('deleted_at', eb.fn<Date>('now', [])),
          idp_subject: null,
          // Her address can no longer find her (ADR-0026); its ciphertext dies with her key.
          email_index: null,
          email_confirmed_at: null,
        }))
        .where('id', '=', personId)
        .execute();
      // The tombstone trigger deletes the key in this same transaction (migration 0001).
      await new PostgresPersonKeyStore(trx).destroy(personId);
      return true;
    });
  }

  async purge(personId: string): Promise<boolean> {
    const r = await this.#db
      .selectNoFrom((eb) => eb.fn<boolean>('person_purge', [eb.val(personId)]).as('purged'))
      .executeTakeFirstOrThrow();
    return r.purged;
  }

  async resolveSubject(idpSubject: string): Promise<string | null> {
    const row = await this.#db
      .selectFrom('person')
      .select('id')
      .where('idp_subject', '=', idpSubject)
      .where('deleted_at', 'is', null)
      .executeTakeFirst();
    return row?.id ?? null;
  }

  async resolvePatient(idpSubject: string): Promise<PatientResolution | null> {
    const personId = await this.resolveSubject(idpSubject);
    if (!personId) return null;
    const links = await this.#db
      .selectFrom('patient_link')
      .select(['patient_record_id', 'org_id'])
      .where('person_id', '=', personId)
      .orderBy('created_at')
      .execute();
    return {
      personId,
      patients: links.map((l) => ({ patientId: l.patient_record_id, orgId: l.org_id })),
    };
  }
}

/** Dev and test stand-in: keeps only ciphertexts produced by the given cipher. */
export class InMemoryPersonStore implements PersonStore {
  readonly rows = new Map<
    string,
    { email: string | null; displayName: string | null; erased: boolean }
  >();
  /** Dev and test: identity-provider subject -> person id. */
  readonly subjects = new Map<string, string>();
  readonly #cipher: FieldCipher;

  constructor(cipher: FieldCipher) {
    this.#cipher = cipher;
  }

  async create(p: NewPerson): Promise<void> {
    const email =
      p.email === null ? null : await this.#cipher.encrypt(p.email, ctx(p.id, 'person.email'));
    const displayName =
      p.displayName === null
        ? null
        : await this.#cipher.encrypt(p.displayName, ctx(p.id, 'person.display_name'));
    this.rows.set(p.id, { email, displayName, erased: false });
  }

  async erase(personId: string): Promise<boolean> {
    const row = this.rows.get(personId);
    if (!row) return false;
    await this.#cipher.shredPatient(personId);
    row.erased = true;
    for (const [subject, id] of this.subjects) if (id === personId) this.subjects.delete(subject);
    return true;
  }

  purge(personId: string): Promise<boolean> {
    const row = this.rows.get(personId);
    if (!row) return Promise.resolve(this.purged.has(personId));
    if (!row.erased) return Promise.resolve(false);
    this.rows.delete(personId);
    this.links.delete(personId);
    this.purged.add(personId);
    return Promise.resolve(true);
  }

  readonly purged = new Set<string>();

  subjectOf(personId: string): Promise<string | null> {
    for (const [subject, id] of this.subjects) if (id === personId) return Promise.resolve(subject);
    return Promise.resolve(null);
  }

  resolveSubject(idpSubject: string): Promise<string | null> {
    const id = this.subjects.get(idpSubject);
    return Promise.resolve(id && !this.rows.get(id)?.erased ? id : null);
  }

  /** Dev and test: person id -> patient records. */
  readonly links = new Map<string, { patientId: string; orgId: string }[]>();

  async resolvePatient(idpSubject: string): Promise<PatientResolution | null> {
    const personId = await this.resolveSubject(idpSubject);
    return personId ? { personId, patients: this.links.get(personId) ?? [] } : null;
  }
}

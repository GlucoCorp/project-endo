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
        }))
        .where('id', '=', personId)
        .execute();
      // The tombstone trigger deletes the key in this same transaction (migration 0001).
      await new PostgresPersonKeyStore(trx).destroy(personId);
      return true;
    });
  }
}

/** Dev and test stand-in: keeps only ciphertexts produced by the given cipher. */
export class InMemoryPersonStore implements PersonStore {
  readonly rows = new Map<
    string,
    { email: string | null; displayName: string | null; erased: boolean }
  >();
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
    return true;
  }
}

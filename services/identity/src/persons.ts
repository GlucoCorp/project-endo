import type { Kysely } from 'kysely';
import type { FieldCipher } from '@endo/crypto';
import type { IdentityDatabase } from '@endo/identity-store';

/** Identity fields as they arrive. Never stored or logged in this form. */
export interface NewPerson {
  readonly id: string;
  readonly email: string | null;
  readonly displayName: string | null;
}

export interface PersonStore {
  /** Encrypts each field under the person's own key (`kms/identity`), then stores the person. */
  create(person: NewPerson): Promise<void>;
  /** REQ-009: marks erasure and crypto-shreds the key. Idempotent. Returns false if unknown. */
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
  readonly #cipher: FieldCipher;

  /** `cipher` must be built with `PostgresPersonKeyStore` and `kms/identity`. */
  constructor(db: Kysely<IdentityDatabase>, cipher: FieldCipher) {
    this.#db = db;
    this.#cipher = cipher;
  }

  async create(p: NewPerson): Promise<void> {
    // The person row comes first: the key row references it.
    await this.#db.insertInto('person').values({ id: p.id }).execute();
    const email =
      p.email === null ? null : await this.#cipher.encrypt(p.email, ctx(p.id, 'person.email'));
    const name =
      p.displayName === null
        ? null
        : await this.#cipher.encrypt(p.displayName, ctx(p.id, 'person.display_name'));
    await this.#db
      .updateTable('person')
      .set({ email_encrypted: email, display_name_encrypted: name })
      .where('id', '=', p.id)
      .execute();
  }

  async erase(personId: string): Promise<boolean> {
    const found = await this.#db
      .updateTable('person')
      .set({ deleted_at: new Date() })
      .where('id', '=', personId)
      .where('deleted_at', 'is', null)
      .executeTakeFirst();
    const exists =
      Number(found.numUpdatedRows) > 0 ||
      (await this.#db
        .selectFrom('person')
        .select('id')
        .where('id', '=', personId)
        .executeTakeFirst()) !== undefined;
    if (!exists) return false;
    await this.#cipher.shredPatient(personId);
    return true;
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
    this.rows.set(p.id, {
      email:
        p.email === null ? null : await this.#cipher.encrypt(p.email, ctx(p.id, 'person.email')),
      displayName:
        p.displayName === null
          ? null
          : await this.#cipher.encrypt(p.displayName, ctx(p.id, 'person.display_name')),
      erased: false,
    });
  }

  async erase(personId: string): Promise<boolean> {
    const row = this.rows.get(personId);
    if (!row) return false;
    row.erased = true;
    await this.#cipher.shredPatient(personId);
    return true;
  }
}

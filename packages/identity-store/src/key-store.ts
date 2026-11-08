import type { Kysely } from 'kysely';
import type { PatientKeyStore } from '@endo/crypto';
import type { IdentityDatabase } from './schema.ts';

/**
 * Durable per-person data keys for identity fields (spec 11.2; REQ-009). Implements the crypto
 * package's key-store contract, so `new FieldCipher(kms, store, 'kms/identity')` encrypts each
 * person's fields under their own key.
 *
 * `destroy` deletes the key row (not a soft delete) and records a tombstone in the same
 * transaction; the database then refuses any new key for that person.
 */
export class PostgresPersonKeyStore implements PatientKeyStore {
  readonly #db: Kysely<IdentityDatabase>;

  constructor(db: Kysely<IdentityDatabase>) {
    this.#db = db;
  }

  async get(personId: string): Promise<Uint8Array | null | 'destroyed'> {
    const shredded = await this.#db
      .selectFrom('person_key_shredded')
      .select('person_id')
      .where('person_id', '=', personId)
      .executeTakeFirst();
    if (shredded) return 'destroyed';
    const row = await this.#db
      .selectFrom('person_key')
      .select('wrapped')
      .where('person_id', '=', personId)
      .executeTakeFirst();
    return row ? new Uint8Array(row.wrapped) : null;
  }

  async putIfAbsent(personId: string, wrapped: Uint8Array): Promise<Uint8Array> {
    // Concurrent first writes: exactly one insert wins, and everyone returns the stored key.
    await this.#db
      .insertInto('person_key')
      .values({ person_id: personId, wrapped: Buffer.from(wrapped) })
      .onConflict((oc) => oc.column('person_id').doNothing())
      .execute();
    const row = await this.#db
      .selectFrom('person_key')
      .select('wrapped')
      .where('person_id', '=', personId)
      .executeTakeFirstOrThrow();
    return new Uint8Array(row.wrapped);
  }

  async destroy(personId: string): Promise<void> {
    await this.#db.transaction().execute(async (trx) => {
      await trx
        .insertInto('person_key_shredded')
        .values({ person_id: personId })
        .onConflict((oc) => oc.column('person_id').doNothing())
        .execute();
      await trx.deleteFrom('person_key').where('person_id', '=', personId).execute();
    });
  }
}

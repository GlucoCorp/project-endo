import { createHmac, randomInt, timingSafeEqual } from 'node:crypto';
import { sql, type Kysely, type Transaction } from 'kysely';
import { FieldCipher, type KeyManager } from '@endo/crypto';
import { uuidv7 } from '@endo/domain';
import { PostgresPersonKeyStore, type IdentityDatabase } from '@endo/identity-store';

/**
 * Email one-time codes (spec 10.1; ADR-0026). 6 digits, 10 minutes, single use, locked after 5
 * wrong entries; 3 requests per address and 10 per client IP per hour. Only a MAC of the code is
 * stored (HMAC under its own `kms/identity` data key, bound to the request), so the database
 * alone cannot test the 10^6 codes. Every request is a row, also for an address that is no
 * patient's, so the answer and the limits never tell whether an address is known.
 */
export const CODE_ATTEMPTS = 5;
export const PER_ADDRESS_PER_HOUR = 3;
export const PER_SOURCE_PER_HOUR = 10;
const CODE = /^[0-9]{6}$/;

/** What to deliver, and to which address: always the one she confirmed, never the typed one. */
export interface Delivery {
  readonly requestId: string;
  readonly deliver: { readonly to: string; readonly code: string } | null;
}

export type AuditFn = (
  action: string,
  requestId: string,
) => Readonly<Record<string, unknown>> & {
  readonly id: string;
};

const emailCtx = (personId: string) => ({
  patientId: personId,
  field: 'person.email',
  recordId: personId,
});
const pendingCtx = (personId: string, requestId: string) => ({
  patientId: personId,
  field: 'email_code.pending_email',
  recordId: requestId,
});

/** Lower-case, trimmed: the form an address is indexed and compared in. */
export function normaliseEmail(address: string): string {
  return address.trim().toLowerCase();
}

export class EmailCodeStore {
  readonly #db: Kysely<IdentityDatabase>;
  readonly #kms: KeyManager;
  readonly #draw: () => string;
  #indexKey: Promise<Buffer> | null = null;

  /** `draw` exists for tests only; the default uses a cryptographically secure generator. */
  constructor(
    db: Kysely<IdentityDatabase>,
    kms: KeyManager,
    draw: () => string = () => randomInt(0, 1_000_000).toString(),
  ) {
    this.#db = db;
    this.#kms = kms;
    this.#draw = draw;
  }

  /** Blind index of an address (normalised) or a client IP, under the index key. */
  async index(kind: 'address' | 'source', value: string): Promise<string> {
    const key = await this.#key();
    const v = kind === 'address' ? normaliseEmail(value) : value;
    return createHmac('sha256', key).update(`endo-${kind}:v1:${v}`).digest('hex');
  }

  /**
   * A sign-in code for this address, if it is a patient's confirmed address and the limits allow.
   * The answer has the same shape either way; `deliver` is for Keycloak's sender only.
   */
  async issueSignIn(address: string, sourceIp: string, audit: AuditFn): Promise<Delivery> {
    const addressIndex = await this.index('address', address);
    const sourceIndex = await this.index('source', sourceIp);
    return this.#db.transaction().execute(async (trx) => {
      const id = uuidv7();
      const limited = await overLimit(trx, addressIndex, sourceIndex);
      const person = limited
        ? undefined
        : await trx
            .selectFrom('person')
            .select('id')
            .where('email_index', '=', addressIndex)
            .where('deleted_at', 'is', null)
            .where('idp_subject', 'is not', null)
            .where((eb) =>
              eb.exists(
                eb
                  .selectFrom('patient_link')
                  .select('person_id')
                  .whereRef('patient_link.person_id', '=', 'person.id'),
              ),
            )
            .executeTakeFirst();
      let deliver: Delivery['deliver'] = null;
      let sealed: { wrappedKey: string; mac: string } | null = null;
      if (person) {
        const cipher = new FieldCipher(this.#kms, new PostgresPersonKeyStore(trx), 'kms/identity');
        const row = await trx
          .selectFrom('person')
          .select('email_encrypted')
          .where('id', '=', person.id)
          .executeTakeFirstOrThrow();
        if (row.email_encrypted !== null) {
          const code = this.#draw().padStart(6, '0');
          sealed = await this.#seal(code, id);
          deliver = { to: await cipher.decrypt(row.email_encrypted, emailCtx(person.id)), code };
        }
      }
      await trx
        .insertInto('email_code')
        .values({
          id,
          purpose: 'sign-in',
          person_id: sealed && person ? person.id : null,
          address_index: addressIndex,
          source_index: sourceIndex,
          code_wrapped_key: sealed?.wrappedKey ?? null,
          code_mac: sealed?.mac ?? null,
        })
        .execute();
      const action = limited
        ? 'identity.email_code.limited'
        : deliver
          ? 'identity.email_code.issued'
          : 'identity.email_code.no_match';
      await queue(trx, audit(action, id));
      return { requestId: id, deliver };
    });
  }

  /** Checks a sign-in code: her Keycloak subject when it matches, otherwise null (one attempt). */
  async verifySignIn(requestId: string, code: string, audit: AuditFn): Promise<string | null> {
    const r = await this.#verify(requestId, 'sign-in', null, code, audit);
    if (!r) return null;
    const p = await this.#db
      .selectFrom('person')
      .select('idp_subject')
      .where('id', '=', r.personId)
      .where('deleted_at', 'is', null)
      .executeTakeFirst();
    return p?.idp_subject ?? null;
  }

  /**
   * A code to confirm a new address for this person (settings). The address is kept encrypted
   * under her key until confirmed. Null delivery when the limits are reached.
   */
  async issueConfirm(
    personId: string,
    address: string,
    sourceIp: string,
    audit: AuditFn,
  ): Promise<Delivery> {
    const addressIndex = await this.index('address', address);
    const sourceIndex = await this.index('source', sourceIp);
    return this.#db.transaction().execute(async (trx) => {
      const id = uuidv7();
      const limited = await overLimit(trx, addressIndex, sourceIndex);
      const cipher = new FieldCipher(this.#kms, new PostgresPersonKeyStore(trx), 'kms/identity');
      const code = this.#draw().padStart(6, '0');
      const sealed = await this.#seal(code, id);
      await trx
        .insertInto('email_code')
        .values({
          id,
          purpose: 'confirm',
          person_id: personId,
          address_index: addressIndex,
          source_index: sourceIndex,
          code_wrapped_key: sealed.wrappedKey,
          code_mac: sealed.mac,
          pending_email: await cipher.encrypt(normaliseEmail(address), pendingCtx(personId, id)),
        })
        .execute();
      await queue(
        trx,
        audit(limited ? 'identity.email_code.limited' : 'identity.email_code.issued', id),
      );
      return { requestId: id, deliver: limited ? null : { to: normaliseEmail(address), code } };
    });
  }

  /**
   * Confirms her new address with the code sent to it. On success it becomes her sign-in address
   * (encrypted under her key, indexed). False on a wrong, used, expired or locked code, or when
   * another account already uses the address.
   */
  async verifyConfirm(
    personId: string,
    requestId: string,
    code: string,
    audit: AuditFn,
  ): Promise<boolean> {
    const r = await this.#verify(requestId, 'confirm', personId, code, audit, async (trx, row) => {
      if (row.pending_email === null) return false;
      const cipher = new FieldCipher(this.#kms, new PostgresPersonKeyStore(trx), 'kms/identity');
      const address = await cipher.decrypt(row.pending_email, pendingCtx(personId, requestId));
      const taken = await trx
        .selectFrom('person')
        .select('id')
        .where('email_index', '=', row.address_index)
        .where('id', '<>', personId)
        .executeTakeFirst();
      if (taken) return false;
      await trx
        .updateTable('person')
        .set({
          email_encrypted: await cipher.encrypt(address, emailCtx(personId)),
          email_index: row.address_index,
          email_confirmed_at: sql<Date>`clock_timestamp()`,
        })
        .where('id', '=', personId)
        .where('deleted_at', 'is', null)
        .execute();
      return true;
    });
    return r !== null;
  }

  async #verify(
    requestId: string,
    purpose: 'sign-in' | 'confirm',
    personId: string | null,
    code: string,
    audit: AuditFn,
    onMatch?: (
      trx: Transaction<IdentityDatabase>,
      row: { pending_email: string | null; address_index: string },
    ) => Promise<boolean>,
  ): Promise<{ personId: string } | null> {
    return this.#db.transaction().execute(async (trx) => {
      const row = await trx
        .selectFrom('email_code')
        .select([
          'id',
          'purpose',
          'person_id',
          'code_wrapped_key',
          'code_mac',
          'pending_email',
          'address_index',
          'attempts',
          'used_at',
          sql<boolean>`clock_timestamp() > expires_at`.as('expired'),
        ])
        .where('id', '=', requestId)
        .forUpdate()
        .executeTakeFirst();
      // An unknown request, or one that never had a code, is answered like a wrong code; there
      // is nothing to count on it.
      if (
        !row ||
        row.purpose !== purpose ||
        row.person_id === null ||
        (personId !== null && row.person_id !== personId) ||
        row.code_wrapped_key === null ||
        row.code_mac === null
      )
        return null;
      if (row.used_at !== null || row.attempts >= CODE_ATTEMPTS || row.expired) return null;
      const ok = await this.#matches(code, requestId, row.code_wrapped_key, row.code_mac);
      if (ok && (!onMatch || (await onMatch(trx, row)))) {
        await trx
          .updateTable('email_code')
          .set({ used_at: sql<Date>`clock_timestamp()` })
          .where('id', '=', requestId)
          .execute();
        await queue(trx, audit('identity.email_code.used', requestId));
        return { personId: row.person_id };
      }
      await trx
        .updateTable('email_code')
        .set({ attempts: row.attempts + 1 })
        .where('id', '=', requestId)
        .execute();
      await queue(
        trx,
        audit(
          row.attempts + 1 >= CODE_ATTEMPTS
            ? 'identity.email_code.locked'
            : 'identity.email_code.wrong',
          requestId,
        ),
      );
      return null;
    });
  }

  async #seal(code: string, requestId: string): Promise<{ wrappedKey: string; mac: string }> {
    const key = await this.#kms.generateDataKey('kms/identity');
    try {
      return {
        wrappedKey: Buffer.from(key.wrapped).toString('base64url'),
        mac: createHmac('sha256', key.plaintext)
          .update(`endo-email-code:v1:${requestId}:${code}`)
          .digest('base64url'),
      };
    } finally {
      key.plaintext.fill(0);
    }
  }

  async #matches(code: string, requestId: string, wrapped: string, mac: string): Promise<boolean> {
    if (!CODE.test(code)) return false;
    const key = await this.#kms.unwrapDataKey('kms/identity', Buffer.from(wrapped, 'base64url'));
    try {
      const expected = Buffer.from(mac, 'base64url');
      const actual = createHmac('sha256', key)
        .update(`endo-email-code:v1:${requestId}:${code}`)
        .digest();
      return expected.length === actual.length && timingSafeEqual(expected, actual);
    } finally {
      key.fill(0);
    }
  }

  /** The index key: created once (wrapped by `kms/identity`), then unwrapped and kept in memory. */
  #key(): Promise<Buffer> {
    this.#indexKey ??= (async () => {
      const existing = await this.#readKey();
      if (existing) return existing;
      const fresh = await this.#kms.generateDataKey('kms/identity');
      fresh.plaintext.fill(0);
      await this.#db
        .insertInto('identity_index_key')
        .values({ purpose: 'email', wrapped_key: Buffer.from(fresh.wrapped).toString('base64url') })
        .onConflict((oc) => oc.column('purpose').doNothing())
        .execute();
      const stored = await this.#readKey();
      if (!stored) throw new Error('index key missing');
      return stored;
    })().catch((e: unknown) => {
      this.#indexKey = null;
      throw e;
    });
    return this.#indexKey;
  }

  async #readKey(): Promise<Buffer | null> {
    const row = await this.#db
      .selectFrom('identity_index_key')
      .select('wrapped_key')
      .where('purpose', '=', 'email')
      .executeTakeFirst();
    if (!row) return null;
    return Buffer.from(
      await this.#kms.unwrapDataKey('kms/identity', Buffer.from(row.wrapped_key, 'base64url')),
    );
  }
}

/** True once this address or source has reached its hourly limit (counted before this one). */
async function overLimit(
  trx: Transaction<IdentityDatabase>,
  addressIndex: string,
  sourceIndex: string,
): Promise<boolean> {
  // Serialise requests for the same address, so two at once cannot both slip under the limit.
  await trx
    .selectNoFrom((eb) =>
      eb
        .fn('pg_advisory_xact_lock', [eb.fn('hashtextextended', [eb.val(addressIndex), eb.lit(0)])])
        .as('locked'),
    )
    .execute();
  const since = sql<Date>`clock_timestamp() - interval '1 hour'`;
  const count = async (column: 'address_index' | 'source_index', value: string) =>
    Number(
      (
        await trx
          .selectFrom('email_code')
          .select((eb) => eb.fn.countAll<string>().as('n'))
          .where(column, '=', value)
          .where('created_at', '>', since)
          .executeTakeFirstOrThrow()
      ).n,
    );
  return (
    (await count('address_index', addressIndex)) >= PER_ADDRESS_PER_HOUR ||
    (await count('source_index', sourceIndex)) >= PER_SOURCE_PER_HOUR
  );
}

async function queue(
  trx: Transaction<IdentityDatabase>,
  event: Readonly<Record<string, unknown>> & { readonly id: string },
): Promise<void> {
  await trx
    .insertInto('audit_outbox')
    .values({ id: event.id, event: JSON.stringify(event) })
    .execute();
}

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomBytes, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import type { Kysely } from 'kysely';
import { DevKeyManager, FieldCipher, KeyDestroyedError } from '@endo/crypto';
import { createDb, createPool, runMigrations, testDatabaseUrl } from '@endo/db';
import { IDENTITY_MIGRATIONS_DIR, PostgresPersonKeyStore, type IdentityDatabase } from './index.ts';

const url = testDatabaseUrl();
const SYNTHETIC_PHI_MARKER = 'SYNTHETIC_PHI_MARKER-identity-91c2';

/**
 * Deployment-shaped roles: a non-superuser owner runs the migration and the identity service
 * connects as a member of endo_identity_app. Only setup uses the superuser.
 */
describe.skipIf(!url)('spec 5.2, 11.2, REQ-009 identity vault and per-person keys', () => {
  let admin: pg.Pool;
  let appDb: Kysely<IdentityDatabase>;
  let appPool: pg.Pool;
  let relayPool: pg.Pool; // member of endo_identity_relay only
  let schema: string;

  const withSchema = (base: string, user: string, password: string) => {
    const u = new URL(base);
    u.username = user;
    u.password = password;
    u.searchParams.set('options', `-c search_path=${schema}`);
    return u.toString();
  };

  const newPerson = async (fields: Partial<Record<'email_encrypted', string>> = {}) => {
    const id = randomUUID();
    await appDb
      .insertInto('person')
      .values({ id, idp_subject: randomUUID(), ...fields })
      .execute();
    return id;
  };

  beforeAll(async () => {
    schema = `identity_${randomBytes(6).toString('hex')}`;
    const ownerPw = randomBytes(16).toString('hex');
    const appPw = randomBytes(16).toString('hex');
    const relayPw = randomBytes(16).toString('hex');
    const bootstrap = await readFile(
      fileURLToPath(new URL('../bootstrap/roles.sql', import.meta.url)),
      'utf8',
    );
    const su = new pg.Client({ connectionString: url });
    await su.connect();
    try {
      await su.query(bootstrap);
      for (const [role, pw, extra] of [
        ['identity_owner_test', ownerPw, ''],
        ['identity_api_test', appPw, 'IN ROLE endo_identity_app'],
        ['identity_relay_test', relayPw, 'IN ROLE endo_identity_relay'],
      ] as const) {
        const exists = await su.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [role]);
        // Role names and hex passwords are fixed or generated here, never external input.
        if (exists.rowCount === 0)
          await su.query(`CREATE ROLE ${role} LOGIN PASSWORD '${pw}' ${extra}`);
        else await su.query(`ALTER ROLE ${role} LOGIN PASSWORD '${pw}'`);
      }
      await su.query(`CREATE SCHEMA ${schema} AUTHORIZATION identity_owner_test`);
    } finally {
      await su.end();
    }
    const owner = createPool(withSchema(url!, 'identity_owner_test', ownerPw), {
      applicationName: 'endo-test-identity-owner',
      max: 1,
    });
    try {
      await runMigrations(owner, IDENTITY_MIGRATIONS_DIR);
    } finally {
      await owner.end();
    }
    const base = new URL(url!);
    admin = new pg.Pool({ connectionString: withSchema(url!, base.username, base.password) });
    appPool = createPool(withSchema(url!, 'identity_api_test', appPw), {
      applicationName: 'endo-test-identity',
    });
    appDb = createDb<IdentityDatabase>(appPool);
    relayPool = createPool(withSchema(url!, 'identity_relay_test', relayPw), {
      applicationName: 'endo-test-identity-relay',
    });
  });

  afterAll(async () => {
    await appDb.destroy();
    await relayPool.end();
    await admin.end();
  });

  it('encrypts identity fields under the person key; the database never holds the plaintext', async () => {
    const cipher = new FieldCipher(
      new DevKeyManager('test'),
      new PostgresPersonKeyStore(appDb),
      'kms/identity',
    );
    const id = randomUUID();
    const ctx = { patientId: id, field: 'person.email', recordId: id };
    await appDb.insertInto('person').values({ id, idp_subject: randomUUID() }).execute();
    const sealed = await cipher.encrypt(SYNTHETIC_PHI_MARKER, ctx);
    await appDb
      .updateTable('person')
      .set({ email_encrypted: sealed })
      .where('id', '=', id)
      .execute();

    const dump = await admin.query<{ j: string }>(
      `SELECT row_to_json(p)::text AS j FROM person p WHERE id = $1`,
      [id],
    );
    expect(dump.rows[0]?.j).not.toContain(SYNTHETIC_PHI_MARKER);
    await expect(cipher.decrypt(sealed, ctx)).resolves.toBe(SYNTHETIC_PHI_MARKER);
  });

  it('crypto-shreds: after destroy the fields are unrecoverable and no new key can be made', async () => {
    const store = new PostgresPersonKeyStore(appDb);
    const cipher = new FieldCipher(new DevKeyManager('test'), store, 'kms/identity');
    const id = await newPerson();
    const ctx = { patientId: id, field: 'person.email', recordId: id };
    const sealed = await cipher.encrypt(SYNTHETIC_PHI_MARKER, ctx);

    await cipher.shredPatient(id);
    expect(await store.get(id)).toBe('destroyed');
    await expect(cipher.decrypt(sealed, ctx)).rejects.toBeInstanceOf(KeyDestroyedError);
    await expect(cipher.encrypt('again', ctx)).rejects.toBeInstanceOf(KeyDestroyedError);
    // Even bypassing the store, the database refuses a key for a shredded person.
    await expect(
      appDb
        .insertInto('person_key')
        .values({ person_id: id, wrapped: randomBytes(40) })
        .execute(),
    ).rejects.toThrow(/shredded/);
    const rows = await admin.query(`SELECT 1 FROM person_key WHERE person_id = $1`, [id]);
    expect(rows.rowCount).toBe(0); // physically deleted, not soft-deleted
    await store.destroy(id); // idempotent
  });

  it('keeps exactly one key when two writers race to create it', async () => {
    const store = new PostgresPersonKeyStore(appDb);
    const id = await newPerson();
    const [a, b] = await Promise.all([
      store.putIfAbsent(id, randomBytes(40)),
      store.putIfAbsent(id, randomBytes(40)),
    ]);
    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(true);
    expect(await store.get(randomUUID())).toBeNull();
  });

  it('a key created at the moment of shredding cannot survive it', async () => {
    const id = await newPerson();
    const creator = await appPool.connect();
    try {
      await creator.query('BEGIN');
      // Key insert takes the per-person lock and stays uncommitted ...
      await creator.query(`INSERT INTO person_key (person_id, wrapped) VALUES ($1, $2)`, [
        id,
        randomBytes(40),
      ]);
      // ... so shredding waits for it, then deletes it.
      const shredding = new PostgresPersonKeyStore(appDb).destroy(id);
      await new Promise((r) => setTimeout(r, 200));
      await creator.query('COMMIT');
      await shredding;
    } finally {
      creator.release();
    }
    expect(
      (await admin.query(`SELECT 1 FROM person_key WHERE person_id = $1`, [id])).rowCount,
    ).toBe(0);
    expect(await new PostgresPersonKeyStore(appDb).get(id)).toBe('destroyed');
  });

  it('cannot delete a key without shredding, and a tombstone always removes the key', async () => {
    const store = new PostgresPersonKeyStore(appDb);
    const id = await newPerson();
    await store.putIfAbsent(id, randomBytes(40));
    await expect(
      appDb.deleteFrom('person_key').where('person_id', '=', id).execute(),
    ).rejects.toThrow(/permission denied/);
    await expect(admin.query(`DELETE FROM person_key WHERE person_id = $1`, [id])).rejects.toThrow(
      /only by shredding/,
    );
    await appDb.insertInto('person_key_shredded').values({ person_id: id }).execute();
    expect(
      (await admin.query(`SELECT 1 FROM person_key WHERE person_id = $1`, [id])).rowCount,
    ).toBe(0);
  });

  it('hard-deleting a linked person (erasure job, after the grace period) removes links and key', async () => {
    const store = new PostgresPersonKeyStore(appDb);
    const id = await newPerson();
    await store.putIfAbsent(id, randomBytes(40));
    await appDb
      .insertInto('patient_link')
      .values({ person_id: id, patient_record_id: randomUUID(), org_id: randomUUID() })
      .execute();
    await store.destroy(id);
    await admin.query(`DELETE FROM person WHERE id = $1`, [id]);
    expect(
      (await admin.query(`SELECT 1 FROM patient_link WHERE person_id = $1`, [id])).rowCount,
    ).toBe(0);
    expect(await store.get(id)).toBe('destroyed');
  });

  it('gives the identity service no way to delete people or rewrite links', async () => {
    const id = await newPerson();
    await appDb
      .insertInto('patient_link')
      .values({ person_id: id, patient_record_id: randomUUID(), org_id: randomUUID() })
      .execute();
    await expect(appDb.deleteFrom('person').where('id', '=', id).execute()).rejects.toThrow(
      /permission denied/,
    );
    await expect(
      appDb
        .updateTable('patient_link')
        .set({ org_id: randomUUID() })
        .where('person_id', '=', id)
        .execute(),
    ).rejects.toThrow(/permission denied/);
    await expect(
      appDb.deleteFrom('person_key_shredded').where('person_id', '=', id).execute(),
    ).rejects.toThrow(/permission denied/);
  });

  describe('spec 2.6 identity audit outbox (ADR-0021 section 14)', () => {
    const queue = async () => {
      const id = randomUUID();
      await appDb
        .insertInto('audit_outbox')
        .values({ id, event: JSON.stringify({ id, action: 'identity.enrolment.started' }) })
        .execute();
      return id;
    };

    it('lets the service only add events: no reading, changing or deleting', async () => {
      const id = await queue();
      for (const text of [
        'SELECT * FROM audit_outbox',
        'UPDATE audit_outbox SET published_at = now()',
        'DELETE FROM audit_outbox',
        'TRUNCATE audit_outbox',
      ])
        await expect(appPool.query(text), text).rejects.toThrow(/permission denied/);
      const seen = await relayPool.query('SELECT 1 FROM audit_outbox WHERE id = $1', [id]);
      expect(seen.rowCount).toBe(1);
    });

    it('lets the relay publish once, count failures one at a time, and never change an event', async () => {
      const id = await queue();
      const relay = (text: string) => relayPool.query(text, [id]);
      await expect(
        relay(`UPDATE audit_outbox SET event = '{"x":1}' WHERE id = $1`),
      ).rejects.toThrow(/permission denied/);
      await expect(relay('UPDATE audit_outbox SET attempts = 3 WHERE id = $1')).rejects.toThrow(
        /one at a time/,
      );
      await relay(
        `UPDATE audit_outbox SET attempts = attempts + 1, last_error = 'audit.publish_failed' WHERE id = $1`,
      );
      await expect(
        relay(`UPDATE audit_outbox SET last_error = 'Free text, not a code' WHERE id = $1`),
      ).rejects.toThrow(/check constraint|one at a time/);
      // Publishing cannot erase the failure record.
      await expect(
        relay(
          'UPDATE audit_outbox SET published_at = now(), attempts = 0, last_error = NULL WHERE id = $1',
        ),
      ).rejects.toThrow(/cannot change the failure record/);
      await relay('UPDATE audit_outbox SET published_at = now() WHERE id = $1');
      const row = await relayPool.query('SELECT attempts FROM audit_outbox WHERE id = $1', [id]);
      expect(row.rows[0]).toEqual({ attempts: 1 });
      await expect(
        relay('UPDATE audit_outbox SET published_at = now() WHERE id = $1'),
      ).rejects.toThrow(/published once/);
      await expect(relay('DELETE FROM audit_outbox WHERE id = $1')).rejects.toThrow(
        /permission denied/,
      );
    });

    it('rejects an event that is not a small JSON object', async () => {
      await expect(
        appDb.insertInto('audit_outbox').values({ id: randomUUID(), event: '[1]' }).execute(),
      ).rejects.toThrow(/check constraint/);
      await expect(
        appDb
          .insertInto('audit_outbox')
          .values({ id: randomUUID(), event: JSON.stringify({ pad: 'x'.repeat(5000) }) })
          .execute(),
      ).rejects.toThrow(/check constraint/);
    });
  });
});

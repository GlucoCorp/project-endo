import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import type { Kysely } from 'kysely';
import { DevKeyManager, FieldCipher, KeyDestroyedError } from '@endo/crypto';
import { createDb, createPool, runMigrations, testDatabaseUrl } from '@endo/db';
import { uuidv7 } from '@endo/domain';
import {
  IDENTITY_MIGRATIONS_DIR,
  PostgresPersonKeyStore,
  type IdentityDatabase,
} from '@endo/identity-store';
import { InMemoryPersonStore, PostgresPersonStore } from './persons.ts';

const url = testDatabaseUrl();
const SYNTHETIC_PHI_MARKER = 'SYNTHETIC_PHI_MARKER-persons-0a4b';

describe.skipIf(!url)('spec 5.2, REQ-009 PostgresPersonStore as the identity role', () => {
  let admin: pg.Pool;
  let db: Kysely<IdentityDatabase>;
  let store: PostgresPersonStore;
  let cipher: FieldCipher;

  beforeAll(async () => {
    const schema = `idsvc_${randomBytes(6).toString('hex')}`;
    const ownerPw = randomBytes(16).toString('hex');
    const appPw = randomBytes(16).toString('hex');
    const at = (user: string, pw: string) => {
      const u = new URL(url!);
      u.username = user;
      u.password = pw;
      u.searchParams.set('options', `-c search_path=${schema}`);
      return u.toString();
    };
    const bootstrap = await readFile(
      fileURLToPath(
        new URL('../../../packages/identity-store/bootstrap/roles.sql', import.meta.url),
      ),
      'utf8',
    );
    const su = new pg.Client({ connectionString: url });
    await su.connect();
    try {
      await su.query(bootstrap);
      for (const [role, pw, extra] of [
        ['idsvc_owner_test', ownerPw, ''],
        ['idsvc_api_test', appPw, 'IN ROLE endo_identity_app'],
      ] as const) {
        const exists = await su.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [role]);
        // Role names and hex passwords are fixed or generated here, never external input.
        if (exists.rowCount === 0)
          await su.query(`CREATE ROLE ${role} LOGIN PASSWORD '${pw}' ${extra}`);
        else await su.query(`ALTER ROLE ${role} LOGIN PASSWORD '${pw}'`);
      }
      await su.query(`CREATE SCHEMA ${schema} AUTHORIZATION idsvc_owner_test`);
    } finally {
      await su.end();
    }
    const owner = createPool(at('idsvc_owner_test', ownerPw), {
      applicationName: 'endo-test',
      max: 1,
    });
    try {
      await runMigrations(owner, IDENTITY_MIGRATIONS_DIR);
    } finally {
      await owner.end();
    }
    const base = new URL(url!);
    admin = new pg.Pool({ connectionString: at(base.username, base.password) });
    db = createDb<IdentityDatabase>(
      createPool(at('idsvc_api_test', appPw), { applicationName: 'endo-test' }),
    );
    const kms = new DevKeyManager('test');
    cipher = new FieldCipher(kms, new PostgresPersonKeyStore(db), 'kms/identity');
    store = new PostgresPersonStore(db, kms);
  });

  afterAll(async () => {
    await db.destroy();
    await admin.end();
  });

  it('stores only ciphertext, then erasure shreds the key and marks the person', async () => {
    const id = uuidv7();
    await store.create({ id, email: `${SYNTHETIC_PHI_MARKER}@example.test`, displayName: null });
    const dump = await admin.query<{ j: string }>(
      `SELECT row_to_json(p)::text AS j FROM person p WHERE id = $1`,
      [id],
    );
    expect(dump.rows[0]?.j).not.toContain(SYNTHETIC_PHI_MARKER);
    const row = await db
      .selectFrom('person')
      .selectAll()
      .where('id', '=', id)
      .executeTakeFirstOrThrow();
    const ctx = { patientId: id, field: 'person.email', recordId: id };
    await expect(cipher.decrypt(row.email_encrypted!, ctx)).resolves.toContain(
      SYNTHETIC_PHI_MARKER,
    );

    expect(await store.erase(id)).toBe(true);
    expect(await store.erase(id)).toBe(true); // idempotent
    await expect(cipher.decrypt(row.email_encrypted!, ctx)).rejects.toBeInstanceOf(
      KeyDestroyedError,
    );
    const after = await db
      .selectFrom('person')
      .select('deleted_at')
      .where('id', '=', id)
      .executeTakeFirstOrThrow();
    expect(after.deleted_at).toBeInstanceOf(Date);
  });

  it('leaves nothing behind when encryption fails during creation', async () => {
    const failing = {
      generateDataKey: () => Promise.reject(new Error('kms down')),
      unwrapDataKey: () => Promise.reject(new Error('kms down')),
    };
    const id = uuidv7();
    await expect(
      new PostgresPersonStore(db, failing).create({
        id,
        email: 'a@example.test',
        displayName: null,
      }),
    ).rejects.toThrow('kms down');
    expect((await admin.query(`SELECT 1 FROM person WHERE id = $1`, [id])).rowCount).toBe(0);
    expect(
      (await admin.query(`SELECT 1 FROM person_key WHERE person_id = $1`, [id])).rowCount,
    ).toBe(0);
  });

  it('erasure clears the sign-in subject in the same transaction as the shredding', async () => {
    const id = uuidv7();
    await store.create({ id, email: null, displayName: 'x' });
    await admin.query(`UPDATE person SET idp_subject = 'kc-subject-1' WHERE id = $1`, [id]);
    await store.erase(id);
    const row = await admin.query<{ idp_subject: string | null; shredded: boolean }>(
      `SELECT idp_subject, EXISTS (SELECT 1 FROM person_key_shredded WHERE person_id = $1) AS shredded FROM person WHERE id = $1`,
      [id],
    );
    expect(row.rows[0]).toEqual({ idp_subject: null, shredded: true });
  });

  it('reports an unknown person, and stores a person with no contact fields', async () => {
    expect(await store.erase(uuidv7())).toBe(false);
    const id = uuidv7();
    await store.create({ id, email: null, displayName: 'x' });
    const row = await db
      .selectFrom('person')
      .selectAll()
      .where('id', '=', id)
      .executeTakeFirstOrThrow();
    expect(row.email_encrypted).toBeNull();
    expect(row.display_name_encrypted).not.toBe('x');
    expect(await new InMemoryPersonStore(cipher).erase(uuidv7())).toBe(false);
  });
});

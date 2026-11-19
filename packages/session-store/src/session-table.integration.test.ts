import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHash, randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import type { Kysely } from 'kysely';
import { createDb, createPool, runMigrations, testDatabaseUrl } from '@endo/db';
import { SESSION_MIGRATIONS_DIR, SessionTable, type SessionDatabase } from './index.ts';

const url = testDatabaseUrl();

describe.skipIf(!url)('ADR-0033 durable sessions as the BFF role', () => {
  const schema = `sessions_${randomBytes(6).toString('hex')}`;
  const ownerPw = randomBytes(16).toString('hex');
  const appPw = randomBytes(16).toString('hex');
  let admin: pg.Pool;
  let db: Kysely<SessionDatabase>;
  let table: SessionTable;
  const at = (user: string, pw: string) => {
    const u = new URL(url!);
    u.username = user;
    u.password = pw;
    u.searchParams.set('options', `-c search_path=${schema}`);
    return u.toString();
  };

  beforeAll(async () => {
    const bootstrap = await readFile(
      fileURLToPath(new URL('../bootstrap/roles.sql', import.meta.url)),
      'utf8',
    );
    const su = new pg.Client({ connectionString: url });
    await su.connect();
    try {
      await su.query(bootstrap);
      for (const [role, pw, extra] of [
        ['sessions_owner_test', ownerPw, ''],
        ['sessions_bff_test', appPw, 'IN ROLE endo_sessions_app'],
      ] as const) {
        const exists = await su.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [role]);
        // Role names and hex passwords are fixed or generated here, never external input.
        if (exists.rowCount === 0)
          await su.query(`CREATE ROLE ${role} LOGIN PASSWORD '${pw}' ${extra}`);
        else await su.query(`ALTER ROLE ${role} LOGIN PASSWORD '${pw}'`);
      }
      await su.query(`CREATE SCHEMA ${schema} AUTHORIZATION sessions_owner_test`);
      await su.query(`GRANT USAGE ON SCHEMA ${schema} TO endo_sessions_app`);
    } finally {
      await su.end();
    }
    const owner = createPool(at('sessions_owner_test', ownerPw), {
      applicationName: 'endo-test-sessions-owner',
      max: 1,
    });
    try {
      await runMigrations(owner, SESSION_MIGRATIONS_DIR);
    } finally {
      await owner.end();
    }
    const base = new URL(url!);
    admin = new pg.Pool({ connectionString: at(base.username, decodeURIComponent(base.password)) });
    db = createDb<SessionDatabase>(
      createPool(at('sessions_bff_test', appPw), { applicationName: 'endo-test-sessions' }),
    );
    table = new SessionTable(db);
  });

  afterAll(async () => {
    await db.destroy();
    await admin.end();
  });

  const row = <T extends object>(doc: T, extra: object = {}) => ({
    kind: 'patient',
    doc,
    idleMs: 30 * 60_000,
    absoluteMs: 12 * 60 * 60_000,
    ...extra,
  });
  const age = (token: string, column: 'last_seen_at' | 'created_at', minutes: number) =>
    admin.query(
      column === 'last_seen_at'
        ? 'UPDATE browser_session SET last_seen_at = now() - make_interval(mins => $2) WHERE token_hash = $1'
        : 'UPDATE browser_session SET created_at = now() - make_interval(mins => $2) WHERE token_hash = $1',
      [createHash('sha256').update(token).digest('hex'), minutes],
    );

  it('stores only the token hash and reads the session back, per kind', async () => {
    const token = await table.insert(row({ sub: 'p1' }));
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const stored = await admin.query('SELECT token_hash FROM browser_session');
    expect(JSON.stringify(stored.rows)).not.toContain(token);
    expect((await table.get<{ sub: string }>(token, 'patient'))?.doc).toEqual({ sub: 'p1' });
    expect(await table.get(token, 'clinic')).toBeNull();
    // Reading under the wrong kind leaves the session alone.
    expect((await table.get<{ sub: string }>(token, 'patient'))?.doc).toEqual({ sub: 'p1' });
    expect(await table.get('x'.repeat(43), 'patient')).toBeNull();
  });

  it('expires on idle and absolute limits for every replica, and removes the row', async () => {
    const idle = await table.insert(row({}));
    await age(idle, 'last_seen_at', 31);
    expect(await table.get(idle, 'patient')).toBeNull();
    const old = await table.insert(row({}));
    await age(old, 'created_at', 12 * 60 + 1);
    expect(await table.get(old, 'patient')).toBeNull();
    const n = await admin.query(
      "SELECT count(*)::int AS n FROM browser_session WHERE created_at < now() - interval '12 hours'",
    );
    expect(n.rows[0]).toEqual({ n: 0 });
  });

  it('counts a read as activity only when asked (background polling never extends it)', async () => {
    const token = await table.insert(row({}));
    await age(token, 'last_seen_at', 10);
    const quiet = await table.get(token, 'patient', false);
    expect(Date.now() - (quiet?.lastSeenBefore ?? 0)).toBeGreaterThan(9 * 60_000);
    const again = await table.get(token, 'patient', false);
    expect(Date.now() - (again?.lastSeenBefore ?? 0)).toBeGreaterThan(9 * 60_000);
    await table.get(token, 'patient');
    const touched = await table.get(token, 'patient');
    expect(Date.now() - (touched?.lastSeenBefore ?? 0)).toBeLessThan(60_000);
  });

  it('rotates atomically, keeping the creation time; the old token stops working', async () => {
    const token = await table.insert(row({ step: 1 }, { kind: 'pending' }));
    await age(token, 'created_at', 5);
    const fresh = await table.rotate<{ step: number }, { step: number }>(token, 'pending', (old) =>
      row({ step: old.doc.step + 1 }, { createdAt: old.createdAt }),
    );
    expect(fresh).not.toBeNull();
    expect(await table.get(token, 'pending')).toBeNull();
    const now = await table.get<{ step: number }>(fresh ?? '', 'patient');
    expect(now?.doc).toEqual({ step: 2 });
    expect(Date.now() - (now?.createdAt ?? 0)).toBeGreaterThan(4 * 60_000);
    // Rotating twice: the second finds nothing. Declining keeps nothing.
    expect(await table.rotate(token, 'pending', () => row({}))).toBeNull();
    // Declining keeps the old session as it was.
    const declined = await table.insert(row({ keep: true }, { kind: 'pending' }));
    expect(await table.rotate(declined, 'pending', () => null)).toBeNull();
    expect((await table.get(declined, 'pending'))?.doc).toEqual({ keep: true });
    // A rotation can keep the last activity time.
    const quiet = await table.insert(row({}, { kind: 'pending' }));
    await age(quiet, 'last_seen_at', 10);
    const kept = await table.rotate(quiet, 'pending', (old) =>
      row({}, { lastSeenAt: old.lastSeenBefore }),
    );
    const after = await table.get(kept ?? '', 'patient', false);
    expect(Date.now() - (after?.lastSeenBefore ?? 0)).toBeGreaterThan(9 * 60_000);
  });

  it('patches, removes, logs out by Keycloak session or subject, and sweeps expired rows', async () => {
    const token = await table.insert(row({ a: 1 }));
    await table.patch(token, { a: 2 });
    expect((await table.get(token, 'patient'))?.doc).toEqual({ a: 2 });
    await table.remove(token);
    expect(await table.get(token, 'patient')).toBeNull();
    const iss = 'https://kc.test/realms/endo';
    const one = await table.insert(
      row({}, { kind: 'clinic', issuer: iss, sid: 's1', subject: 'u1' }),
    );
    const two = await table.insert(
      row({}, { kind: 'clinic', issuer: iss, sid: 's2', subject: 'u1' }),
    );
    expect(await table.removeMatching(iss, { sid: 's1' })).toBe(1);
    expect(await table.get(one, 'clinic')).toBeNull();
    expect(await table.removeMatching('https://other.test', { sub: 'u1' })).toBe(0);
    expect(await table.removeMatching(iss, { sub: 'u1' })).toBe(1);
    expect(await table.get(two, 'clinic')).toBeNull();
    expect(await table.removeMatching(iss, {})).toBe(0);
    const stale = await table.insert(row({}));
    await age(stale, 'last_seen_at', 40);
    expect(await table.sweep()).toBeGreaterThanOrEqual(1);
  });
});

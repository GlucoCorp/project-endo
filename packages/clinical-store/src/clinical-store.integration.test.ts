import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import type { Kysely } from 'kysely';
import { createDb, createPool, runMigrations, testDatabaseUrl } from '@endo/db';
import {
  CLINICAL_MIGRATIONS_DIR,
  findLiveInvitation,
  withOrg,
  type ClinicalDatabase,
} from './index.ts';

const url = testDatabaseUrl();

// Synthetic ids only.
const ORG_A = '01900000-0000-7000-8000-00000000000a';
const ORG_B = '01900000-0000-7000-8000-00000000000b';
const CLIN_A = '01900000-0000-7000-8000-0000000000c1';
const CLIN_B = '01900000-0000-7000-8000-0000000000c2';
const PAT_A = '01900000-0000-7000-8000-0000000000a1';
const PAT_B = '01900000-0000-7000-8000-0000000000b1';
const REF_SHARED = '01900000-0000-7000-8000-0000000000ff';
const tokenHash = () => createHash('sha256').update(randomBytes(32)).digest('hex');

/**
 * Deployment-shaped roles: a non-superuser owner runs the migration, the API connects as a member
 * of endo_clinical_app, and only setup uses the superuser.
 */
describe.skipIf(!url)('REQ-001, RISK-I03 clinical store (spec 5.1, 10.4, 13.1)', () => {
  let admin: pg.Pool; // superuser: bootstrap and seeding only
  let api: pg.Pool; // least-privilege login, member of endo_clinical_app
  let apiOne: pg.Pool; // same login, one connection, to prove settings do not leak
  let apiDb: Kysely<ClinicalDatabase>;
  let apiOneDb: Kysely<ClinicalDatabase>;
  let schema: string;

  const withSchema = (base: string, user: string, password: string) => {
    const u = new URL(base);
    u.username = user;
    u.password = password;
    u.searchParams.set('options', `-c search_path=${schema}`);
    return u.toString();
  };

  /** One API transaction inside an organisation, using raw SQL; always rolled back. */
  async function asApi<T>(orgId: string | null, fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
    const c = await api.connect();
    try {
      await c.query('BEGIN');
      if (orgId) await c.query(`SELECT set_config('app.org_id', $1, true)`, [orgId]);
      return await fn(c);
    } finally {
      await c.query('ROLLBACK');
      c.release();
    }
  }

  const invite = (hash: string, o: { org?: string; by?: string; days?: number } = {}) =>
    admin.query(
      `INSERT INTO enrolment_invitation (id, org_id, created_by, token_hash, expires_at)
       VALUES ($1, $2, $3, $4, now() + make_interval(days => $5))`,
      [randomUUID(), o.org ?? ORG_A, o.by ?? CLIN_A, hash, o.days ?? 7],
    );

  beforeAll(async () => {
    schema = `clinical_${randomBytes(6).toString('hex')}`;
    const ownerPw = randomBytes(16).toString('hex');
    const apiPw = randomBytes(16).toString('hex');
    const bootstrap = await readFile(
      fileURLToPath(new URL('../bootstrap/roles.sql', import.meta.url)),
      'utf8',
    );
    const su = new pg.Client({ connectionString: url });
    await su.connect();
    try {
      await su.query(bootstrap);
      for (const [role, pw, extra] of [
        ['clinical_owner_test', ownerPw, 'IN ROLE endo_clinical_lookup'],
        ['clinical_api_test', apiPw, 'IN ROLE endo_clinical_app'],
      ] as const) {
        const exists = await su.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [role]);
        // Role names and hex passwords are fixed or generated here, never external input.
        if (exists.rowCount === 0)
          await su.query(`CREATE ROLE ${role} LOGIN PASSWORD '${pw}' ${extra}`);
        else await su.query(`ALTER ROLE ${role} LOGIN PASSWORD '${pw}'`);
      }
      await su.query(`CREATE SCHEMA ${schema} AUTHORIZATION clinical_owner_test`);
    } finally {
      await su.end();
    }

    const owner = createPool(withSchema(url!, 'clinical_owner_test', ownerPw), {
      applicationName: 'endo-test-owner',
      max: 1,
    });
    try {
      await runMigrations(owner, CLINICAL_MIGRATIONS_DIR);
    } finally {
      await owner.end();
    }

    const base = new URL(url!);
    admin = new pg.Pool({ connectionString: withSchema(url!, base.username, base.password) });
    api = createPool(withSchema(url!, 'clinical_api_test', apiPw), {
      applicationName: 'endo-test-api',
    });
    apiOne = createPool(withSchema(url!, 'clinical_api_test', apiPw), {
      applicationName: 'endo-test-api-one',
      max: 1,
    });
    apiDb = createDb<ClinicalDatabase>(api);
    apiOneDb = createDb<ClinicalDatabase>(apiOne);

    await admin.query(
      `INSERT INTO organization (id, region, name) VALUES ($1, 'ke', 'Clinic A'), ($2, 'rw', 'Clinic B')`,
      [ORG_A, ORG_B],
    );
    await admin.query(
      `INSERT INTO clinician (id, org_id, identity_ref, role) VALUES ($1, $2, $3, 'clinician'), ($4, $5, $6, 'clinician')`,
      [CLIN_A, ORG_A, randomUUID(), CLIN_B, ORG_B, randomUUID()],
    );
    await admin.query(
      `INSERT INTO patient_record (id, org_id, identity_ref) VALUES ($1, $2, $3), ($4, $5, $6)`,
      [PAT_A, ORG_A, randomUUID(), PAT_B, ORG_B, REF_SHARED],
    );
  });

  afterAll(async () => {
    await apiDb.destroy();
    await apiOneDb.destroy();
    await admin.end();
  });

  describe('organisation isolation by row-level security (second layer, spec 10.4)', () => {
    it('shows only the current organisation, and nothing when none is set', async () => {
      const inA = await withOrg(apiDb, ORG_A, (trx) =>
        trx.selectFrom('patient_record').select('id').execute(),
      );
      expect(inA.map((r) => r.id)).toEqual([PAT_A]);
      expect(await apiDb.selectFrom('patient_record').select('id').execute()).toEqual([]);
      expect(await apiDb.selectFrom('organization').select('id').execute()).toEqual([]);
    });

    it('refuses to write a row into another organisation', async () => {
      await expect(
        asApi(ORG_A, (c) =>
          c.query(`INSERT INTO patient_record (id, org_id, identity_ref) VALUES ($1, $2, $3)`, [
            randomUUID(),
            ORG_B,
            randomUUID(),
          ]),
        ),
      ).rejects.toThrow(/row-level security/);
    });

    it('does not reveal, through a uniqueness conflict, that a reference exists in another organisation', async () => {
      const r = await asApi(ORG_A, (c) =>
        c.query(`INSERT INTO patient_record (id, org_id, identity_ref) VALUES ($1, $2, $3)`, [
          randomUUID(),
          ORG_A,
          REF_SHARED,
        ]),
      );
      expect(r.rowCount).toBe(1);
    });

    it('withOrg settings end with the transaction, on commit and on rollback', async () => {
      const read = () =>
        apiOne.query<{ v: string | null }>(`SELECT current_setting('app.org_id', true) AS v`);
      await withOrg(apiOneDb, ORG_B, (trx) =>
        trx.selectFrom('organization').select('id').execute(),
      );
      expect((await read()).rows[0]?.v ?? '').toBe('');
      await expect(
        withOrg(apiOneDb, ORG_B, () => Promise.reject(new Error('boom'))),
      ).rejects.toThrow('boom');
      expect((await read()).rows[0]?.v ?? '').toBe('');
      await expect(withOrg(apiOneDb, 'not-a-uuid', () => Promise.resolve())).rejects.toThrow(
        TypeError,
      );
    });

    it('gives the API no way to delete or truncate patient records', async () => {
      await expect(asApi(ORG_A, (c) => c.query(`DELETE FROM patient_record`))).rejects.toThrow(
        /permission denied/,
      );
      await expect(asApi(ORG_A, (c) => c.query(`TRUNCATE patient_record`))).rejects.toThrow(
        /permission denied/,
      );
    });
  });

  describe('REQ-001 enrolment invitations: single use, at most 7 days, forward-only', () => {
    it('rejects a validity longer than 7 days', async () => {
      await expect(invite(tokenHash(), { days: 8 })).rejects.toThrow(/check constraint/);
    });

    it('rejects an invitation created by a clinician of another organisation', async () => {
      await expect(invite(tokenHash(), { org: ORG_A, by: CLIN_B })).rejects.toThrow(/foreign key/);
    });

    it('does not let the API choose the issue time or pre-set lifecycle fields', async () => {
      const insert = (text: string) =>
        asApi(ORG_A, (c) => c.query(text, [randomUUID(), ORG_A, CLIN_A, tokenHash()]));
      await expect(
        insert(
          `INSERT INTO enrolment_invitation (id, org_id, created_by, token_hash, expires_at, created_at)
           VALUES ($1, $2, $3, $4, now() + interval '31 days', now() + interval '30 days')`,
        ),
      ).rejects.toThrow(/permission denied/);
      await expect(
        insert(
          `INSERT INTO enrolment_invitation (id, org_id, created_by, token_hash, expires_at, revoked_at)
           VALUES ($1, $2, $3, $4, now() + interval '1 day', now())`,
        ),
      ).rejects.toThrow(/permission denied/);
    });

    it('finds a live invitation across organisations as the API role', async () => {
      const hash = tokenHash();
      await invite(hash, { org: ORG_B, by: CLIN_B });
      expect((await findLiveInvitation(apiDb, hash))?.orgId).toBe(ORG_B);
      expect(await findLiveInvitation(apiDb, tokenHash())).toBeNull();
      await expect(findLiveInvitation(apiDb, 'abc')).rejects.toThrow(TypeError);
    });

    it('cannot be fooled by a temporary table that shadows the invitations table', async () => {
      const hash = tokenHash();
      const found = await asApi(null, async (c) => {
        await c.query(
          `CREATE TEMP TABLE enrolment_invitation (id uuid, org_id uuid, token_hash char(64), claimed_at timestamptz, revoked_at timestamptz, expires_at timestamptz)`,
        );
        await c.query(
          `INSERT INTO pg_temp.enrolment_invitation VALUES ($1, $2, $3, NULL, NULL, now() + interval '1 day')`,
          [randomUUID(), ORG_A, hash],
        );
        return (await c.query<{ r: unknown }>(`SELECT enrolment_find_live($1) AS r`, [hash]))
          .rows[0]?.r;
      });
      expect(found).toBeNull();
    });

    it('lets exactly one of two simultaneous claims succeed, then is no longer live', async () => {
      const hash = tokenHash();
      await invite(hash, { org: ORG_B, by: CLIN_B });
      const live = await findLiveInvitation(apiDb, hash);
      const claim = () =>
        withOrg(apiDb, ORG_B, (trx) =>
          trx
            .updateTable('enrolment_invitation')
            .set({ claimed_at: new Date(), patient_id: PAT_B })
            .where('id', '=', live!.invitationId)
            .where('claimed_at', 'is', null)
            .where('revoked_at', 'is', null)
            .executeTakeFirst()
            .then((r) => Number(r.numUpdatedRows)),
        );
      const results = await Promise.allSettled([claim(), claim()]);
      const updated = results.map((r) => (r.status === 'fulfilled' ? r.value : 0));
      expect(updated.sort()).toEqual([0, 1]);
      expect(await findLiveInvitation(apiDb, hash)).toBeNull();
    });

    it('never moves back: a claimed or revoked invitation is final', async () => {
      const update = (text: string, h: string) => asApi(ORG_B, (c) => c.query(text, [h]));
      const REOPEN = `UPDATE enrolment_invitation SET claimed_at = NULL, patient_id = NULL WHERE token_hash = $1`;
      const REVOKE = `UPDATE enrolment_invitation SET revoked_at = now() WHERE token_hash = $1`;
      const UNREVOKE = `UPDATE enrolment_invitation SET revoked_at = NULL WHERE token_hash = $1`;
      const NOOP = `UPDATE enrolment_invitation SET patient_id = NULL WHERE token_hash = $1`;

      const claimed = tokenHash();
      await invite(claimed, { org: ORG_B, by: CLIN_B });
      await admin.query(
        `UPDATE enrolment_invitation SET claimed_at = now(), patient_id = $2 WHERE token_hash = $1`,
        [claimed, PAT_B],
      );
      await expect(update(REOPEN, claimed)).rejects.toThrow(/final/);
      await expect(update(REVOKE, claimed)).rejects.toThrow(/final/);

      const revoked = tokenHash();
      await invite(revoked, { org: ORG_B, by: CLIN_B });
      await admin.query(
        `UPDATE enrolment_invitation SET revoked_at = now() WHERE token_hash = $1`,
        [revoked],
      );
      await expect(update(UNREVOKE, revoked)).rejects.toThrow(/final/);
      expect(await findLiveInvitation(apiDb, revoked)).toBeNull();

      const live = tokenHash();
      await invite(live, { org: ORG_B, by: CLIN_B });
      await expect(update(NOOP, live)).rejects.toThrow(/claim or revoke/);
    });

    it('cannot be claimed after it expires', async () => {
      const hash = tokenHash();
      await invite(hash, { days: 1 });
      // Simulate the passage of time as the owner; the forward-only trigger is paused only here.
      await admin.query(
        `ALTER TABLE enrolment_invitation DISABLE TRIGGER enrolment_invitation_forward_only`,
      );
      await admin.query(
        `UPDATE enrolment_invitation SET created_at = created_at - interval '2 days', expires_at = expires_at - interval '2 days' WHERE token_hash = $1`,
        [hash],
      );
      await admin.query(
        `ALTER TABLE enrolment_invitation ENABLE TRIGGER enrolment_invitation_forward_only`,
      );
      expect(await findLiveInvitation(apiDb, hash)).toBeNull();
      await expect(
        asApi(ORG_A, (c) =>
          c.query(
            `UPDATE enrolment_invitation SET claimed_at = now(), patient_id = $2 WHERE token_hash = $1`,
            [hash, PAT_A],
          ),
        ),
      ).rejects.toThrow(/expired/);
    });
  });

  describe('spec 13.1 consent: append-only history with one current state', () => {
    const decide = (c: pg.PoolClient, status: string, purpose = 'share_with_care_team') =>
      c.query(
        `INSERT INTO consent (id, patient_id, org_id, purpose, status, version) VALUES ($1, $2, $3, $4, $5, 1)`,
        [randomUUID(), PAT_A, ORG_A, purpose, status],
      );

    it('treats the latest decision as current, even within one transaction', async () => {
      const current = await asApi(ORG_A, async (c) => {
        await decide(c, 'granted');
        await decide(c, 'revoked');
        return (
          await c.query<{ status: string }>(
            `SELECT status FROM consent_current WHERE patient_id = $1 AND purpose = 'share_with_care_team'`,
            [PAT_A],
          )
        ).rows;
      });
      expect(current).toEqual([{ status: 'revoked' }]);
    });

    it('orders concurrent decisions by commit, so a later withdrawal wins', async () => {
      const first = await api.connect();
      const second = await api.connect();
      try {
        for (const c of [first, second]) {
          await c.query('BEGIN');
          await c.query(`SELECT set_config('app.org_id', $1, true)`, [ORG_A]);
        }
        await decide(first, 'granted', 'research_deidentified');
        const blocked = decide(second, 'revoked', 'research_deidentified'); // waits for the lock
        await first.query('COMMIT');
        await blocked;
        await second.query('COMMIT');
      } finally {
        first.release();
        second.release();
      }
      const current = await asApi(ORG_A, (c) =>
        c.query(
          `SELECT status FROM consent_current WHERE patient_id = $1 AND purpose = 'research_deidentified'`,
          [PAT_A],
        ),
      );
      expect(current.rows).toEqual([{ status: 'revoked' }]);
    });

    it('does not let the API set the decision time or order', async () => {
      await expect(
        asApi(ORG_A, (c) =>
          c.query(
            `INSERT INTO consent (id, patient_id, org_id, purpose, status, version, decided_at) VALUES ($1, $2, $3, 'self_tracking', 'granted', 1, now() + interval '1 year')`,
            [randomUUID(), PAT_A, ORG_A],
          ),
        ),
      ).rejects.toThrow(/permission denied/);
    });

    it('refuses to rewrite or erase history, even for the table owner', async () => {
      const id = randomUUID();
      await admin.query(
        `INSERT INTO consent (id, patient_id, org_id, purpose, status, version) VALUES ($1, $2, $3, 'self_tracking', 'granted', 1)`,
        [id, PAT_A, ORG_A],
      );
      await expect(
        asApi(ORG_A, (c) => c.query(`UPDATE consent SET status = 'revoked'`)),
      ).rejects.toThrow(/permission denied/);
      await expect(
        admin.query(`UPDATE consent SET status = 'revoked' WHERE id = $1`, [id]),
      ).rejects.toThrow(/append-only/);
      await expect(admin.query(`DELETE FROM consent WHERE id = $1`, [id])).rejects.toThrow(
        /append-only/,
      );
      await expect(admin.query(`TRUNCATE consent`)).rejects.toThrow(/append-only/);
    });

    it('rejects unknown purposes and statuses', async () => {
      const bad = (purpose: string, status: string) =>
        admin.query(
          `INSERT INTO consent (id, patient_id, org_id, purpose, status, version) VALUES ($1, $2, $3, $4, $5, 1)`,
          [randomUUID(), PAT_A, ORG_A, purpose, status],
        );
      await expect(bad('marketing', 'granted')).rejects.toThrow(/check constraint/);
      await expect(bad('self_tracking', 'maybe')).rejects.toThrow(/check constraint/);
    });
  });

  it('gives the lookup role nothing beyond invitation columns', async () => {
    const c = await admin.connect();
    try {
      await c.query('BEGIN');
      await c.query('SET LOCAL ROLE endo_clinical_lookup');
      await expect(c.query('SELECT id FROM patient_record')).rejects.toThrow(/permission denied/);
    } finally {
      await c.query('ROLLBACK');
      c.release();
    }
  });
});

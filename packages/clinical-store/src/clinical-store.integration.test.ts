import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import type { Kysely } from 'kysely';
import { createDb, createPool, runMigrations, testDatabaseUrl } from '@endo/db';
import {
  CLINICAL_MIGRATIONS_DIR,
  PostgresInvitationStore,
  PostgresIdempotentInvitationStore,
  PostgresMembershipStore,
  relayAuditOutbox,
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
const IDREF_CLIN_A = '01900000-0000-7000-8000-0000000000e1';
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
  let relayDb: Kysely<ClinicalDatabase>; // member of endo_clinical_relay only
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
        [
          'clinical_owner_test',
          ownerPw,
          'IN ROLE endo_clinical_lookup, endo_clinical_membership_lookup',
        ],
        ['clinical_api_test', apiPw, 'IN ROLE endo_clinical_app'],
        ['clinical_relay_test', relayPw, 'IN ROLE endo_clinical_relay'],
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
    relayDb = createDb<ClinicalDatabase>(
      createPool(withSchema(url!, 'clinical_relay_test', relayPw), {
        applicationName: 'endo-test-relay',
      }),
    );

    await admin.query(
      `INSERT INTO organization (id, region, name) VALUES ($1, 'ke', 'Clinic A'), ($2, 'rw', 'Clinic B')`,
      [ORG_A, ORG_B],
    );
    await admin.query(
      `INSERT INTO clinician (id, org_id, identity_ref, role) VALUES ($1, $2, $3, 'clinician'), ($4, $5, $6, 'clinician')`,
      [CLIN_A, ORG_A, IDREF_CLIN_A, CLIN_B, ORG_B, randomUUID()],
    );
    await admin.query(
      `INSERT INTO patient_record (id, org_id, identity_ref) VALUES ($1, $2, $3), ($4, $5, $6)`,
      [PAT_A, ORG_A, randomUUID(), PAT_B, ORG_B, REF_SHARED],
    );
  });

  afterAll(async () => {
    await apiDb.destroy();
    await apiOneDb.destroy();
    await relayDb.destroy();
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

    it('PostgresInvitationStore creates an invitation with a database-clock expiry of 7 days', async () => {
      const hash = tokenHash();
      const store = new PostgresInvitationStore(apiDb);
      const { expiresAt } = await store.create({
        id: randomUUID(),
        orgId: ORG_A,
        createdBy: CLIN_A,
        tokenHash: hash,
      });
      const { rows } = await admin.query<{ ok: boolean }>(
        `SELECT expires_at = created_at + interval '7 days' AS ok FROM enrolment_invitation WHERE token_hash = $1`,
        [hash],
      );
      expect(rows[0]?.ok).toBe(true);
      expect(expiresAt).toBeInstanceOf(Date);
      expect((await findLiveInvitation(apiDb, hash))?.orgId).toBe(ORG_A);
      // A clinician cannot issue for another organisation, whatever the API passes.
      await expect(
        store.create({ id: randomUUID(), orgId: ORG_A, createdBy: CLIN_B, tokenHash: tokenHash() }),
      ).rejects.toThrow(/foreign key/);
    });

    it('ADR-0019 lists the active memberships of a person across organisations, and nothing else', async () => {
      const members = new PostgresMembershipStore(apiDb);
      // The same person in a second organisation, and an inactive third membership.
      const orgC = '01900000-0000-7000-8000-00000000000c';
      await admin.query(
        `INSERT INTO organization (id, region, name) VALUES ($1, 'ke', 'Clinic C')`,
        [orgC],
      );
      await admin.query(
        `INSERT INTO clinician (id, org_id, identity_ref, role) VALUES ($1, $2, $3, 'org_admin')`,
        [randomUUID(), ORG_B, IDREF_CLIN_A],
      );
      await admin.query(
        `INSERT INTO clinician (id, org_id, identity_ref, role, active) VALUES ($1, $2, $3, 'clinician', false)`,
        [randomUUID(), orgC, IDREF_CLIN_A],
      );
      expect(await members.listActive(IDREF_CLIN_A)).toEqual([
        { orgId: ORG_A, role: 'clinician' },
        { orgId: ORG_B, role: 'org_admin' },
      ]);
      expect(await members.listActive(randomUUID())).toEqual([]);
      // The API role still sees nothing across organisations directly.
      expect(await apiDb.selectFrom('clinician').select('id').execute()).toEqual([]);
    });

    it('PostgresMembershipStore resolves a clinician by identity reference, only in their organisation', async () => {
      const members = new PostgresMembershipStore(apiDb);
      expect(await members.find(ORG_A, IDREF_CLIN_A)).toEqual({
        clinicianId: CLIN_A,
        role: 'clinician',
        active: true,
      });
      expect(await members.find(ORG_B, IDREF_CLIN_A)).toBeNull();
      expect(await members.find(ORG_A, CLIN_A)).toBeNull(); // the clinical id is not an identity ref
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

  describe('spec 9.1, 2.6 idempotent creation with a same-transaction audit outbox', () => {
    const request = (key: string, requestHash = 'b'.repeat(64)) => ({
      invitation: { id: randomUUID(), orgId: ORG_A, createdBy: CLIN_A, tokenHash: tokenHash() },
      idempotency: { actorRef: CLIN_A, key, requestHash },
      auditEvent: { id: randomUUID(), action: 'enrolment.create', outcome: 'success' },
      sealResponse: () => Promise.resolve({ wrappedKey: 'wk', envelope: randomUUID() }),
    });

    it('creates once; a retry replays the same sealed response and creates nothing', async () => {
      const store = new PostgresIdempotentInvitationStore(apiDb);
      const key = randomUUID();
      const first = await store.createOnce(request(key));
      expect(first.kind).toBe('created');
      const again = await store.createOnce(request(key));
      expect(again.kind).toBe('replay');
      const counts = await admin.query<{ invitations: string; outbox: string }>(
        `SELECT (SELECT count(*) FROM enrolment_invitation i JOIN idempotency_record r ON r.org_id = i.org_id WHERE r.idem_key = $1) AS invitations,
                (SELECT count(*) FROM audit_outbox) AS outbox`,
        [key],
      );
      expect(Number(counts.rows[0]?.invitations)).toBeGreaterThan(0);
      const records = await admin.query(`SELECT 1 FROM idempotency_record WHERE idem_key = $1`, [
        key,
      ]);
      expect(records.rowCount).toBe(1);
    });

    it('treats a reused key with a different request as a conflict', async () => {
      const store = new PostgresIdempotentInvitationStore(apiDb);
      const key = randomUUID();
      await store.createOnce(request(key));
      expect((await store.createOnce(request(key, 'c'.repeat(64)))).kind).toBe('conflict');
    });

    it('lets only one of two simultaneous requests with the same key create', async () => {
      const store = new PostgresIdempotentInvitationStore(apiDb);
      const key = randomUUID();
      const results = await Promise.all([
        store.createOnce(request(key)),
        store.createOnce(request(key)),
      ]);
      expect(results.map((r) => r.kind).sort()).toEqual(['created', 'replay']);
    });

    it('commits nothing when sealing fails: no invitation, no record, no audit event', async () => {
      const store = new PostgresIdempotentInvitationStore(apiDb);
      const key = randomUUID();
      const r = request(key);
      await expect(
        store.createOnce({ ...r, sealResponse: () => Promise.reject(new Error('kms down')) }),
      ).rejects.toThrow('kms down');
      expect(
        (await admin.query(`SELECT 1 FROM enrolment_invitation WHERE id = $1`, [r.invitation.id]))
          .rowCount,
      ).toBe(0);
      expect(
        (await admin.query(`SELECT 1 FROM audit_outbox WHERE id = $1`, [r.auditEvent.id])).rowCount,
      ).toBe(0);
    });

    it('reports an expired key as expired, never replaying or creating again', async () => {
      const store = new PostgresIdempotentInvitationStore(apiDb);
      const key = randomUUID();
      await store.createOnce(request(key));
      await admin.query(`ALTER TABLE idempotency_record DROP CONSTRAINT idempotency_record_check`);
      await admin.query(
        `UPDATE idempotency_record SET expires_at = now() - interval '1 second' WHERE idem_key = $1`,
        [key],
      );
      expect((await store.createOnce(request(key))).kind).toBe('expired');
      await admin.query(
        `UPDATE idempotency_record SET response_wrapped_key = NULL, response_envelope = NULL, expires_at = created_at + interval '24 hours' WHERE idem_key = $1`,
        [key],
      );
      expect((await store.createOnce(request(key))).kind).toBe('expired'); // tombstone
      await admin.query(
        `ALTER TABLE idempotency_record ADD CONSTRAINT idempotency_record_check CHECK (expires_at = created_at + interval '24 hours')`,
      );
    });

    it('does not let the API set or extend the replay lifetime', async () => {
      await expect(
        asApi(ORG_A, (c) =>
          c.query(
            `INSERT INTO idempotency_record (org_id, actor_ref, operation, idem_key, request_hash, status_code, response_wrapped_key, response_envelope, expires_at)
             VALUES ($1, $2, 'enrolment.create', $3, $4, 201, 'k', 'e', now() + interval '1 year')`,
            [ORG_A, CLIN_A, randomUUID(), 'd'.repeat(64)],
          ),
        ),
      ).rejects.toThrow(/permission denied/);
    });

    const drain = async (publish: (e: unknown, at: Date) => Promise<void>) => {
      let total = 0;
      for (;;) {
        const r = await relayAuditOutbox(relayDb, publish);
        total += r.published;
        if (r.published === 0) return total;
      }
    };

    it('relays every queued event once, with its original time', async () => {
      const store = new PostgresIdempotentInvitationStore(apiDb);
      const r = request(randomUUID());
      await store.createOnce(r);
      const seen: { event: unknown; at: Date }[] = [];
      await drain((event, at) => Promise.resolve(void seen.push({ event, at })));
      const mine = seen.filter((x) => (x.event as { id?: string }).id === r.auditEvent.id);
      expect(mine).toHaveLength(1);
      const { rows } = await admin.query<{ created_at: Date }>(
        `SELECT created_at FROM audit_outbox WHERE id = $1`,
        [r.auditEvent.id],
      );
      expect(mine[0]?.at.getTime()).toBe(rows[0]?.created_at.getTime());
      expect(
        (await relayAuditOutbox(relayDb, () => Promise.reject(new Error('x')))).published,
      ).toBe(0);
    });

    it('RISK-R01 gives the API no way to read, acknowledge or hide queued events', async () => {
      await expect(asApi(null, (c) => c.query(`SELECT 1 FROM audit_outbox`))).rejects.toThrow(
        /permission denied/,
      );
      await expect(
        asApi(null, (c) =>
          c.query(`UPDATE audit_outbox SET published_at = now() WHERE published_at IS NULL`),
        ),
      ).rejects.toThrow(/permission denied/);
    });

    it('refuses to change a published event, even for the relay', async () => {
      const c = await admin.connect();
      try {
        await c.query('BEGIN');
        await c.query('SET LOCAL ROLE endo_clinical_relay');
        await expect(
          c.query(`UPDATE audit_outbox SET published_at = NULL WHERE published_at IS NOT NULL`),
        ).rejects.toThrow(/published once/);
      } finally {
        await c.query('ROLLBACK');
        c.release();
      }
    });

    it('counts failures, keeps a failing event queued, and sets it aside after 5 attempts', async () => {
      const store = new PostgresIdempotentInvitationStore(apiDb);
      await drain(() => Promise.resolve());
      const bad = request(randomUUID());
      await store.createOnce(bad);
      const good = request(randomUUID());
      await store.createOnce(good);
      const failBad = (e: unknown) =>
        (e as { id?: string }).id === bad.auditEvent.id
          ? Promise.reject(new Error('poison'))
          : Promise.resolve();
      // One run: the bad event fails once and does not block the good one.
      const first = await relayAuditOutbox(relayDb, failBad);
      expect(first).toEqual({ published: 1, failed: 1 });
      for (let i = 0; i < 6; i++) await relayAuditOutbox(relayDb, failBad);
      const { rows } = await admin.query<{
        attempts: number;
        last_error: string;
        published_at: Date | null;
      }>(`SELECT attempts, last_error, published_at FROM audit_outbox WHERE id = $1`, [
        bad.auditEvent.id,
      ]);
      expect(rows[0]).toMatchObject({
        attempts: 5,
        last_error: 'audit.publish_failed',
        published_at: null,
      });
    });
  });

  it('gives the membership lookup role nothing beyond clinician membership columns', async () => {
    const c = await admin.connect();
    try {
      await c.query('BEGIN');
      await c.query('SET LOCAL ROLE endo_clinical_membership_lookup');
      // A savepoint per expected failure, so the second check really runs.
      for (const sql of ['SELECT id FROM patient_record', 'SELECT created_at FROM clinician']) {
        await c.query('SAVEPOINT probe');
        await expect(c.query(sql)).rejects.toThrow(/permission denied/);
        await c.query('ROLLBACK TO SAVEPOINT probe');
      }
    } finally {
      await c.query('ROLLBACK');
      c.release();
    }
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

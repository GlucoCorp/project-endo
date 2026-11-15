import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomBytes, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import type { Kysely } from 'kysely';
import { createDb, createPool, runMigrations, testDatabaseUrl } from '@endo/db';
import { DevKeyManager, FieldCipher, KeyDestroyedError } from '@endo/crypto';
import {
  CLINICAL_MIGRATIONS_DIR,
  PostgresEpisodeStore,
  PostgresPatientKeyStore,
  type ClinicalDatabase,
  type NewEpisode,
} from './index.ts';

const url = testDatabaseUrl();
const ORG_A = '01900000-0000-7000-8000-00000000010a';
const ORG_B = '01900000-0000-7000-8000-00000000010b';
const CLIN_A = '01900000-0000-7000-8000-0000000001c1';
const PAT_A = '01900000-0000-7000-8000-0000000001a1';
const PAT_A2 = '01900000-0000-7000-8000-0000000001a2';

/** Her calendar date `days` from today, in UTC (the episodes below use the UTC time zone). */
const day = (days: number) => new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);
const audit = (type: string) => ({ id: randomUUID(), type });

describe.skipIf(!url)(
  'REQ-002, REQ-003, REQ-007 episodes, check-ins and red flags (migration 0008)',
  () => {
    let admin: pg.Pool;
    let apiDb: Kysely<ClinicalDatabase>;
    let store: PostgresEpisodeStore;
    let schema: string;

    const withSchema = (base: string, user: string, password: string) => {
      const u = new URL(base);
      u.username = user;
      u.password = password;
      u.searchParams.set('options', `-c search_path=${schema}`);
      return u.toString();
    };

    /** A created draft (fails the test otherwise). */
    const mk = async (o: Partial<NewEpisode> = {}) => {
      const r = await store.createDraft(draft(o));
      if (r.outcome !== 'created') throw new Error(`draft ${r.outcome}`);
      return r.episode;
    };

    const draft = (o: Partial<NewEpisode> = {}): NewEpisode => ({
      id: randomUUID(),
      creationKey: randomUUID(),
      orgId: ORG_A,
      patientId: PAT_A,
      prescriberId: CLIN_A,
      previousEpisodeId: null,
      treatmentSystem: 'http://www.whocc.no/atc',
      treatmentCode: 'G03DB08',
      adherenceMode: 'daily',
      doseText: '2 mg once daily',
      startDate: day(-6),
      reviewIntervalWeeks: 12,
      instrumentVersion: '1.0.0',
      auditEvent: audit('episode.create'),
      ...o,
    });

    const activate = async (o: Partial<NewEpisode> = {}) => {
      const e = await mk(o);
      const r = await store.confirm({
        orgId: e.orgId,
        patientId: e.patientId,
        episodeId: e.id,
        confirmKey: randomUUID(),
        goalId: randomUUID(),
        goal: { templateCode: 'walk_to_work' },
        timeZone: 'UTC',
        auditEvent: audit('episode.confirm'),
      });
      expect(r.outcome).toBe('confirmed');
      return e;
    };

    const checkIn = (episodeId: string, weekIndex = 1, key = randomUUID(), h = 'a'.repeat(64)) =>
      store.submitCheckIn({
        id: randomUUID(),
        orgId: ORG_A,
        patientId: PAT_A,
        episodeId,
        weekIndex,
        idempotencyKey: key,
        requestHash: h,
        answers: { Q1: 4 },
        instrumentVersion: '1.0.0',
        clientCreatedAt: new Date(),
        auditEvent: audit('checkin.submit'),
      });

    /** Raw SQL as the API role inside organisation A; always rolled back. */
    async function asApi<T>(fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
      const c = await apiPool.connect();
      try {
        await c.query('BEGIN');
        await c.query(`SELECT set_config('app.org_id', $1, true)`, [ORG_A]);
        return await fn(c);
      } finally {
        await c.query('ROLLBACK');
        c.release();
      }
    }
    let apiPool: pg.Pool;

    beforeAll(async () => {
      schema = `episodes_${randomBytes(6).toString('hex')}`;
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
          [
            'clinical_owner_ep_test',
            ownerPw,
            'IN ROLE endo_clinical_lookup, endo_clinical_membership_lookup',
          ],
          ['clinical_api_ep_test', apiPw, 'IN ROLE endo_clinical_app'],
        ] as const) {
          const exists = await su.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [role]);
          // Role names and hex passwords are fixed or generated here, never external input.
          if (exists.rowCount === 0)
            await su.query(`CREATE ROLE ${role} LOGIN PASSWORD '${pw}' ${extra}`);
          else await su.query(`ALTER ROLE ${role} LOGIN PASSWORD '${pw}'`);
        }
        await su.query(`CREATE SCHEMA ${schema} AUTHORIZATION clinical_owner_ep_test`);
      } finally {
        await su.end();
      }
      const owner = createPool(withSchema(url!, 'clinical_owner_ep_test', ownerPw), {
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
      apiPool = createPool(withSchema(url!, 'clinical_api_ep_test', apiPw), {
        applicationName: 'endo-test-api',
      });
      apiDb = createDb<ClinicalDatabase>(apiPool);
      store = new PostgresEpisodeStore(apiDb);
      await admin.query(
        `INSERT INTO organization (id, region, name) VALUES ($1, 'ke', 'A'), ($2, 'rw', 'B')`,
        [ORG_A, ORG_B],
      );
      await admin.query(
        `INSERT INTO clinician (id, org_id, identity_ref, role) VALUES ($1, $2, $3, 'clinician')`,
        [CLIN_A, ORG_A, randomUUID()],
      );
      await admin.query(
        `INSERT INTO patient_record (id, org_id, identity_ref) VALUES ($1, $2, $3), ($4, $2, $5)`,
        [PAT_A, ORG_A, randomUUID(), PAT_A2, randomUUID()],
      );
    });

    afterAll(async () => {
      await apiDb.destroy();
      await admin.end();
    });

    describe('REQ-002 episodes', () => {
      it('is a draft until she confirms with her goal, then active with her time zone', async () => {
        const d = draft();
        const r0 = await store.createDraft(d);
        if (r0.outcome !== 'created') throw new Error('not created');
        const created = r0.episode;
        expect(created).toMatchObject({
          status: 'draft',
          lineId: d.id,
          startDate: d.startDate,
          reviewDate: day(-6 + 84),
          goal: null,
          confirmedAt: null,
          timeZone: null,
        });
        const r = await store.confirm({
          orgId: ORG_A,
          patientId: PAT_A,
          episodeId: d.id,
          confirmKey: randomUUID(),
          goalId: randomUUID(),
          goal: { textEncrypted: 'v1.ciphertext-placeholder' },
          timeZone: 'Africa/Nairobi',
          auditEvent: audit('episode.confirm'),
        });
        expect(r.outcome).toBe('confirmed');
        if (r.outcome !== 'confirmed') return;
        expect(r.episode).toMatchObject({ status: 'active', timeZone: 'Africa/Nairobi' });
        expect(r.episode.goal?.textEncrypted).toBe('v1.ciphertext-placeholder');
        expect(r.episode.confirmedAt).toBeInstanceOf(Date);
        // Confirming again, or someone else's patient: one answer.
        expect(
          (
            await store.confirm({
              orgId: ORG_A,
              patientId: PAT_A,
              episodeId: d.id,
              confirmKey: randomUUID(),
              goalId: randomUUID(),
              goal: { templateCode: 'x' },
              timeZone: 'UTC',
              auditEvent: audit('x'),
            })
          ).outcome,
        ).toBe('not_found');
        const other = await mk({ patientId: PAT_A2 });
        expect(
          (
            await store.confirm({
              orgId: ORG_A,
              patientId: PAT_A,
              episodeId: other.id,
              confirmKey: randomUUID(),
              goalId: randomUUID(),
              goal: { templateCode: 'x' },
              timeZone: 'UTC',
              auditEvent: audit('x'),
            })
          ).outcome,
        ).toBe('not_found');
        // Both audit events were queued with the changes.
        const queued = await admin.query(
          'SELECT count(*)::int AS n FROM audit_outbox WHERE id = $1',
          [d.auditEvent.id],
        );
        expect(queued.rows[0]).toEqual({ n: 1 });
      });

      it('allows one active episode per line: a switch waits, a parallel line does not', async () => {
        const first = await activate();
        const sw = await mk({ previousEpisodeId: first.id });
        expect(sw.lineId).toBe(first.lineId);
        const busy = await store.confirm({
          orgId: ORG_A,
          patientId: PAT_A,
          episodeId: sw.id,
          confirmKey: randomUUID(),
          goalId: randomUUID(),
          goal: { templateCode: 'x' },
          timeZone: 'UTC',
          auditEvent: audit('x'),
        });
        expect(busy).toEqual({ outcome: 'line_busy' });
        // Nothing of the refused confirmation was kept.
        expect((await store.get(ORG_A, sw.id, PAT_A))?.goal).toBeNull();
        await activate(); // a new line beside it
        // A switch can only continue her own episode.
        expect(
          await store.createDraft(draft({ patientId: PAT_A2, previousEpisodeId: first.id })),
        ).toEqual({ outcome: 'not_found' });
      });

      it('enforces the lifecycle in the database, whatever the caller', async () => {
        const e = await mk();
        const sqlAsApi = (text: string, params: unknown[]) => asApi((c) => c.query(text, params));
        await expect(
          sqlAsApi(
            `UPDATE treatment_episode SET status = 'active', time_zone = 'UTC' WHERE id = $1`,
            [e.id],
          ),
        ).rejects.toThrow(/needs her goal|idempotency key/);
        await expect(
          sqlAsApi(`UPDATE treatment_episode SET dose_text = 'more' WHERE id = $1`, [e.id]),
        ).rejects.toThrow(/permission denied/);
        await expect(
          sqlAsApi(
            `INSERT INTO treatment_episode (id, org_id, patient_id, prescriber_id, line_id,
             treatment_system, treatment_code, adherence_mode, dose_text, start_date,
             review_interval_weeks, instrument_version, creation_key)
           VALUES ($1, $2, $3, $4, $1, 'http://www.whocc.no/atc', 'X', 'daily', 'd', now(), 27, '1.0.0', $5)`,
            [randomUUID(), ORG_A, PAT_A, CLIN_A, randomUUID()],
          ),
        ).rejects.toThrow(/check/);
        // Confirming with a goal but no key is refused; the key is set once.
        await expect(
          sqlAsApi(`UPDATE treatment_episode SET confirm_key = $2 WHERE id = $1`, [
            e.id,
            randomUUID(),
          ]),
        ).rejects.toThrow(/set once/);
        await expect(
          sqlAsApi(`DELETE FROM treatment_episode WHERE id = $1`, [e.id]),
        ).rejects.toThrow(/permission denied/);
        const active = await activate();
        await expect(
          sqlAsApi(`UPDATE treatment_episode SET status = 'draft' WHERE id = $1`, [active.id]),
        ).rejects.toThrow(/cannot go from active to draft/);
        await expect(
          sqlAsApi(`UPDATE goal SET goal_template_code = 'other' WHERE episode_id = $1`, [
            active.id,
          ]),
        ).rejects.toThrow(/permission denied/);
      });

      it('spec 9.1 a retried draft with the same key returns the same episode; another draft conflicts', async () => {
        const d = draft();
        const first = await store.createDraft(d);
        expect(first.outcome).toBe('created');
        const again = await store.createDraft({ ...d, id: randomUUID(), auditEvent: audit('x') });
        expect(again.outcome).toBe('replay');
        if (first.outcome === 'created' && again.outcome === 'replay')
          expect(again.episode.id).toBe(first.episode.id);
        expect(await store.createDraft({ ...d, id: randomUUID(), doseText: 'other' })).toEqual({
          outcome: 'conflict',
        });
      });

      it('lists only patients who currently share with the care team', async () => {
        await admin.query(
          `INSERT INTO consent (id, patient_id, org_id, purpose, status, version)
         VALUES ($1, $2, $3, 'share_with_care_team', 'granted', 1)`,
          [randomUUID(), PAT_A, ORG_A],
        );
        expect((await store.listSharingPatients(ORG_A)).map((p) => p.id)).toEqual([PAT_A]);
        await admin.query(
          `INSERT INTO consent (id, patient_id, org_id, purpose, status, version)
         VALUES ($1, $2, $3, 'share_with_care_team', 'revoked', 1)`,
          [randomUUID(), PAT_A, ORG_A],
        );
        expect(await store.listSharingPatients(ORG_A)).toEqual([]);
        expect(await store.listSharingPatients(ORG_B)).toEqual([]);
      });

      it('keeps organisations apart', async () => {
        const e = await mk();
        expect(await store.get(ORG_B, e.id, null)).toBeNull();
        expect(await store.listForPatient(ORG_B, PAT_A)).toEqual([]);
        expect((await store.listForPatient(ORG_A, PAT_A)).map((x) => x.id)).toContain(e.id);
      });
    });

    describe('REQ-003 check-ins', () => {
      it('saves once per key: the same request replays, another request with it conflicts', async () => {
        const e = await activate();
        const key = randomUUID();
        const first = await checkIn(e.id, 1, key);
        expect(first).toMatchObject({ outcome: 'saved', checkIn: { weekIndex: 1, isLate: false } });
        const again = await checkIn(e.id, 1, key);
        expect(again.outcome).toBe('replay');
        if (first.outcome === 'saved' && again.outcome === 'replay')
          expect(again.checkIn.id).toBe(first.checkIn.id);
        expect(await checkIn(e.id, 1, key, 'b'.repeat(64))).toEqual({ outcome: 'conflict' });
        // Another key for the same week: that week is done.
        expect(await checkIn(e.id, 1)).toEqual({ outcome: 'week_done' });
        expect((await store.listCheckIns(ORG_A, e.id)).map((c) => c.weekIndex)).toEqual([1]);
      });

      it('opens on the week’s last day, is late after it, and stays missing after 7 more days', async () => {
        const notYet = await activate({ startDate: day(-5) });
        expect(await checkIn(notYet.id, 1)).toEqual({ outcome: 'not_open' });
        const late = await activate({ startDate: day(-9) });
        expect(await checkIn(late.id, 1)).toMatchObject({
          outcome: 'saved',
          checkIn: { isLate: true },
        });
        const gone = await activate({ startDate: day(-14) });
        expect(await checkIn(gone.id, 1)).toEqual({ outcome: 'too_late' });
        expect(await checkIn(gone.id, 13)).toEqual({ outcome: 'not_found' }); // past the review
      });

      it('refuses a draft episode or another patient’s episode', async () => {
        const d = await mk();
        expect(await checkIn(d.id)).toEqual({ outcome: 'not_found' });
        const theirs = await activate({ patientId: PAT_A2 });
        expect(await checkIn(theirs.id)).toEqual({ outcome: 'not_found' });
      });
    });

    describe('REQ-007 red flags always win', () => {
      const report = (episodeId: string, key = randomUUID(), flags = ['RF3']) =>
        store.recordRedFlag({
          id: randomUUID(),
          orgId: ORG_A,
          patientId: PAT_A,
          episodeId,
          idempotencyKey: key,
          flags,
          instrumentVersion: '1.0.0',
          shownAt: new Date(Date.now() - 60_000),
          acknowledgedAt: new Date(),
          auditEvent: audit('red_flag.record'),
        });

      it('records once per key, outside any check-in window, even after the episode closed', async () => {
        const e = await activate({ startDate: day(-30) }); // every check-in window here is closed
        const key = randomUUID();
        expect((await report(e.id, key)).outcome).toBe('recorded');
        expect((await report(e.id, key)).outcome).toBe('replay');
        expect(await report(e.id, key, ['RF1'])).toEqual({ outcome: 'conflict' });
        await admin.query(`UPDATE treatment_episode SET status = 'closed' WHERE id = $1`, [e.id]);
        expect((await report(e.id)).outcome).toBe('recorded');
        expect(await store.listRedFlags(ORG_A, e.id)).toHaveLength(2);
      });

      it('is fixed once recorded, except the care-team notification time, once', async () => {
        const e = await activate();
        const r = await report(e.id);
        if (r.outcome !== 'recorded') throw new Error('not recorded');
        const sqlAsApi = (text: string) => asApi((c) => c.query(text, [r.id]));
        await expect(
          sqlAsApi(`UPDATE red_flag_event SET flags = '{RF1}' WHERE id = $1`),
        ).rejects.toThrow(/permission denied/);
        await expect(sqlAsApi(`DELETE FROM red_flag_event WHERE id = $1`)).rejects.toThrow(
          /permission denied/,
        );
        await asApi(async (c) => {
          await c.query(`UPDATE red_flag_event SET team_notified_at = now() WHERE id = $1`, [r.id]);
          await expect(
            c.query(`UPDATE red_flag_event SET team_notified_at = now() WHERE id = $1`, [r.id]),
          ).rejects.toThrow(/fixed once recorded/);
        });
      });

      it('keeps her acknowledgement when the check-in’s copy arrived first', async () => {
        const e = await activate();
        const key = randomUUID();
        const shownAt = new Date(Date.now() - 60_000);
        const base = {
          orgId: ORG_A,
          patientId: PAT_A,
          episodeId: e.id,
          idempotencyKey: key,
          flags: ['RF2'],
          instrumentVersion: '1.0.0',
          shownAt,
        };
        const first = await store.recordRedFlag({
          ...base,
          id: randomUUID(),
          acknowledgedAt: null,
          auditEvent: audit('x'),
        });
        expect(first.outcome).toBe('recorded');
        const ack = new Date();
        const again = await store.recordRedFlag({
          ...base,
          id: randomUUID(),
          acknowledgedAt: ack,
          auditEvent: audit('x'),
        });
        expect(again.outcome).toBe('replay');
        const [stored] = await store.listRedFlags(ORG_A, e.id);
        expect(stored?.acknowledgedAt?.getTime()).toBe(ack.getTime());
        // Set once: a later different acknowledgement changes nothing.
        await store.recordRedFlag({
          ...base,
          id: randomUUID(),
          acknowledgedAt: new Date(),
          auditEvent: audit('x'),
        });
        expect((await store.listRedFlags(ORG_A, e.id))[0]?.acknowledgedAt?.getTime()).toBe(
          ack.getTime(),
        );
      });

      it('refuses a key tombstone for another organisation’s patient', async () => {
        // PAT_A belongs to organisation A; organisation B cannot shred (or block) her key.
        await expect(new PostgresPatientKeyStore(apiDb, ORG_B).destroy(PAT_A)).rejects.toThrow(
          /unknown patient/,
        );
      });

      it('is not recorded for a draft or someone else’s episode', async () => {
        const d = await mk();
        expect(await report(d.id)).toEqual({ outcome: 'not_found' });
        const theirs = await activate({ patientId: PAT_A2 });
        expect(await report(theirs.id)).toEqual({ outcome: 'not_found' });
      });
    });

    describe('REQ-009 per-patient keys for her goal text', () => {
      it('encrypts under her own key, which shredding destroys for good', async () => {
        const keys = new PostgresPatientKeyStore(apiDb, ORG_A);
        const cipher = new FieldCipher(new DevKeyManager('test'), keys);
        const ctx = { patientId: PAT_A2, field: 'goal.text', recordId: randomUUID() };
        const sealed = await cipher.encrypt('SYNTHETIC goal', ctx);
        expect(await cipher.decrypt(sealed, ctx)).toBe('SYNTHETIC goal');
        // Organisation B cannot see her key.
        expect(await new PostgresPatientKeyStore(apiDb, ORG_B).get(PAT_A2)).toBeNull();
        await cipher.shredPatient(PAT_A2);
        await expect(cipher.decrypt(sealed, ctx)).rejects.toBeInstanceOf(KeyDestroyedError);
        expect(
          (await admin.query('SELECT 1 FROM patient_key WHERE patient_id = $1', [PAT_A2])).rowCount,
        ).toBe(0);
        await expect(keys.putIfAbsent(PAT_A2, randomBytes(40))).rejects.toThrow(/shredded/);
      });
    });
  },
);

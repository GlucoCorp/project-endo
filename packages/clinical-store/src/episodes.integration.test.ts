import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
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
  PostgresVerdictStore,
  PostgresDeletionStore,
  PostgresOrgAdminStore,
  PostgresShareLinkStore,
  PostgresReviewStore,
  PostgresReminderStore,
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

    describe('REQ-004 verdicts in shadow mode (migration 0010)', () => {
      const base = (episodeId: string, patientId = PAT_A) => ({
        orgId: ORG_A,
        patientId,
        episodeId,
        rulesetVersion: '1.0.0',
        rulesetDigest: 'd'.repeat(64),
        instrumentVersion: '1.0.0',
      });

      it('finds episodes due across organisations, records once per rule set version, append-only', async () => {
        const verdicts = new PostgresVerdictStore(apiDb);
        // Review in 2 days: due (3 days before). Another with review far away: not due.
        const due = await activate({ startDate: day(2 - 84) });
        const notDue = await activate({ startDate: day(-6) });
        const listed = (await verdicts.due(day(0), '1.0.0')).map((d) => d.episodeId);
        expect(listed).toContain(due.id);
        expect(listed).not.toContain(notDue.id);
        const id = randomUUID();
        expect(
          await verdicts.record({
            ...base(due.id),
            id,
            result: { outcome: 'not_generated', reason: 'ruleset_incomplete' },
            generatedBy: 'system',
            requestedBy: null,
            auditEvent: audit('verdict.generate'),
          }),
        ).toBe(true);
        // The schedule does it once per rule set version.
        expect(
          await verdicts.record({
            ...base(due.id),
            id: randomUUID(),
            result: { outcome: 'not_generated', reason: 'ruleset_incomplete' },
            generatedBy: 'system',
            requestedBy: null,
            auditEvent: audit('verdict.generate'),
          }),
        ).toBe(false);
        expect((await verdicts.due(day(0), '1.0.0')).map((d) => d.episodeId)).not.toContain(due.id);
        expect((await verdicts.due(day(0), '1.0.1')).map((d) => d.episodeId)).toContain(due.id);
        // On demand, with a verdict and its trace; always shadow.
        expect(
          await verdicts.record({
            ...base(due.id),
            id: randomUUID(),
            result: {
              outcome: 'generated',
              code: 'RED_FLAG',
              secondary: 'WORKING',
              modifiers: ['DATA_GAPS'],
              inputHash: 'a'.repeat(64),
              explanation: { trace: [] },
            },
            generatedBy: 'on_demand',
            requestedBy: CLIN_A,
            auditEvent: audit('verdict.generate'),
          }),
        ).toBe(true);
        const list = await verdicts.list(ORG_A, due.id);
        expect(list.map((v) => v.outcome)).toEqual(['generated', 'not_generated']);
        expect(list.every((v) => v.shadow)).toBe(true);
        expect(await verdicts.list(ORG_B, due.id)).toEqual([]);
        await expect(
          asApi((c) => c.query(`UPDATE verdict SET verdict_code = 'WORKING' WHERE id = $1`, [id])),
        ).rejects.toThrow(/permission denied|append-only/);
        // A secondary only with RED_FLAG; a generated verdict needs its hash and trace.
        await expect(
          verdicts.record({
            ...base(due.id),
            id: randomUUID(),
            result: {
              outcome: 'generated',
              code: 'WORKING',
              secondary: 'WORKING',
              modifiers: [],
              inputHash: 'a'.repeat(64),
              explanation: {},
            },
            generatedBy: 'on_demand',
            requestedBy: CLIN_A,
            auditEvent: audit('x'),
          }),
        ).rejects.toThrow(/check/);
      });

      it('reads the evidence: her answers by week and the red-flag count', async () => {
        const verdicts = new PostgresVerdictStore(apiDb);
        const e = await activate();
        await checkIn(e.id, 1);
        await store.recordRedFlag({
          id: randomUUID(),
          orgId: ORG_A,
          patientId: PAT_A,
          episodeId: e.id,
          idempotencyKey: randomUUID(),
          flags: ['RF1'],
          instrumentVersion: '1.0.0',
          shownAt: new Date(),
          acknowledgedAt: null,
          auditEvent: audit('x'),
        });
        const ev = await verdicts.evidence(ORG_A, e.id);
        expect(ev).toMatchObject({
          episodeId: e.id,
          reviewIntervalWeeks: 12,
          adherenceMode: 'daily',
          redFlagEvents: 1,
          checkIns: [{ weekIndex: 1, answers: { Q1: 4 } }],
        });
        expect(await verdicts.evidence(ORG_B, e.id)).toBeNull();
      });
    });

    describe('spec 15 reminders (migration 0011)', () => {
      it('keeps one row per device, finds organisations, claims a week once, removes on request', async () => {
        const reminders = new PostgresReminderStore(apiDb);
        const sub = (id: string, hour = 18) =>
          reminders.subscribe({
            id,
            orgId: ORG_A,
            patientId: PAT_A,
            endpointEncrypted: 'v1.synthetic-ciphertext',
            endpointHash: 'e'.repeat(64),
            remindHour: hour,
            timeZone: 'UTC',
          });
        await sub(randomUUID());
        await sub(randomUUID(), 9); // same device: updated, not duplicated
        const subs = await reminders.subscriptions(ORG_A);
        expect(subs.filter((x) => x.patientId === PAT_A)).toHaveLength(1);
        expect(subs.find((x) => x.patientId === PAT_A)?.remindHour).toBe(9);
        expect(await reminders.orgs()).toContain(ORG_A);
        expect(await reminders.subscriptions(ORG_B)).toEqual([]);
        const e = await activate();
        expect((await reminders.episodes(ORG_A, PAT_A)).map((x) => x.episodeId)).toContain(e.id);
        expect(await reminders.claim(ORG_A, PAT_A, e.id, 1)).toBe(true);
        expect(await reminders.claim(ORG_A, PAT_A, e.id, 1)).toBe(false);
        expect(
          (await reminders.episodes(ORG_A, PAT_A)).find((x) => x.episodeId === e.id)?.remindedWeeks,
        ).toEqual([1]);
        const [only] = subs.filter((x) => x.patientId === PAT_A);
        if (only) await reminders.remove(ORG_A, only.id);
        await sub(randomUUID());
        expect(await reminders.unsubscribe(ORG_A, PAT_A, 'e'.repeat(64))).toBe(1);
        await sub(randomUUID());
        expect(await reminders.unsubscribe(ORG_A, PAT_A, null)).toBe(1);
      });
    });

    describe('REQ-005, REQ-006 reviews and pre-surgery checks (migration 0012)', () => {
      const share = async (patientId: string, status: 'granted' | 'revoked') =>
        admin.query(
          `INSERT INTO consent (id, patient_id, org_id, purpose, status, version)
         VALUES ($1, $2, $3, 'share_with_care_team', $4, 1)`,
          [randomUUID(), patientId, ORG_A, status],
        );
      const next = (o: Record<string, unknown> = {}) => ({
        id: randomUUID(),
        treatmentSystem: 'http://www.whocc.no/atc',
        treatmentCode: 'G03DB08',
        adherenceMode: 'daily' as const,
        doseText: '2 mg',
        startDate: day(1),
        reviewIntervalWeeks: 12,
        ...o,
      });
      const decide = (
        reviews: PostgresReviewStore,
        episodeId: string,
        decision: 'continue' | 'switch' | 'add' | 'refer' | 'stop',
        o: Record<string, unknown> = {},
      ) =>
        reviews.decide({
          id: randomUUID(),
          orgId: ORG_A,
          patientId: PAT_A,
          episodeId,
          clinicianId: CLIN_A,
          decision,
          verdictId: null,
          noteEncrypted: null,
          next:
            decision === 'continue' || decision === 'switch' || decision === 'add' ? next() : null,
          added: decision === 'add' ? next() : null,
          idempotencyKey: randomUUID(),
          requestHash: 'h'.repeat(64).replace(/h/g, 'a'),
          instrumentVersion: '1.0.0',
          auditEvent: audit('review.decided'),
          ...o,
        });

      it('lists consented patients due within the horizon, red flags first', async () => {
        const reviews = new PostgresReviewStore(apiDb);
        await share(PAT_A, 'granted');
        const soon = await activate({ startDate: day(10 - 84) }); // review in 10 days
        const later = await activate({ startDate: day(5 - 84) }); // review in 5 days
        const far = await activate({ startDate: day(-6) }); // review in 78 days
        await store.recordRedFlag({
          id: randomUUID(),
          orgId: ORG_A,
          patientId: PAT_A,
          episodeId: soon.id,
          idempotencyKey: randomUUID(),
          flags: ['RF3'],
          instrumentVersion: '1.0.0',
          shownAt: new Date(),
          acknowledgedAt: null,
          auditEvent: audit('x'),
        });
        const ids = (await reviews.queue(ORG_A, day(0), 14)).map((q) => q.episodeId);
        expect(ids.indexOf(soon.id)).toBeLessThan(ids.indexOf(later.id)); // red flag pinned
        expect(ids).not.toContain(far.id);
        expect(
          (await reviews.queue(ORG_A, day(0), 14)).find((q) => q.episodeId === soon.id)?.redFlags,
        ).toBe(1);
        // A limit cuts unflagged episodes first, never a red flag (ordered in SQL).
        const top = await reviews.queue(ORG_A, day(0), 14, 1);
        expect(top).toHaveLength(1);
        expect(top[0]?.redFlags).toBeGreaterThan(0);
        await share(PAT_A, 'revoked');
        expect((await reviews.queue(ORG_A, day(0), 14)).map((q) => q.episodeId)).not.toContain(
          soon.id,
        );
        await share(PAT_A, 'granted');
        expect(await reviews.queue(ORG_B, day(0), 14)).toEqual([]);
      });

      it('records a decision once: closes the episode and opens the next in the same line', async () => {
        const reviews = new PostgresReviewStore(apiDb);
        const e = await activate();
        const key = randomUUID();
        const r = await decide(reviews, e.id, 'continue', { idempotencyKey: key });
        expect(r.outcome).toBe('recorded');
        if (r.outcome !== 'recorded') return;
        const closed = await store.get(ORG_A, e.id, PAT_A);
        expect(closed?.status).toBe('closed');
        const draft = await store.get(ORG_A, r.nextEpisodeId ?? '', PAT_A);
        expect(draft).toMatchObject({ status: 'draft', lineId: e.lineId, previousEpisodeId: e.id });
        expect((await decide(reviews, e.id, 'continue', { idempotencyKey: key })).outcome).toBe(
          'replay',
        );
        expect(
          await decide(reviews, e.id, 'continue', {
            idempotencyKey: key,
            requestHash: 'b'.repeat(64),
          }),
        ).toEqual({ outcome: 'conflict' });
        // Already decided: another key cannot decide it again.
        expect(await decide(reviews, e.id, 'stop')).toEqual({ outcome: 'not_open' });
        expect((await reviews.decisions(ORG_A, PAT_A)).some((d) => d.episodeId === e.id)).toBe(
          true,
        );
      });

      it('add opens a parallel line; refer and stop open nothing; drafts are not decided', async () => {
        const reviews = new PostgresReviewStore(apiDb);
        const e = await activate();
        const added = await decide(reviews, e.id, 'add');
        if (added.outcome !== 'recorded') throw new Error('not recorded');
        const parallel = await store.get(ORG_A, added.addedEpisodeId ?? '', PAT_A);
        expect(parallel?.lineId).toBe(parallel?.id);
        const s = await activate();
        expect(await decide(reviews, s.id, 'stop')).toMatchObject({
          outcome: 'recorded',
          nextEpisodeId: null,
        });
        const d = await mk();
        expect(await decide(reviews, d.id, 'refer')).toEqual({ outcome: 'not_open' });
        await expect(
          asApi((c) => c.query('UPDATE review_decision SET decision_code = $1', ['stop'])),
        ).rejects.toThrow(/permission denied|append-only/);
      });

      it('works out adherence from her answers (daily and device) and shows the latest verdict', async () => {
        const reviews = new PostgresReviewStore(apiDb);
        const verdicts = new PostgresVerdictStore(apiDb);
        await share(PAT_A, 'granted');
        const daily = await activate({ startDate: day(-6) });
        await store.submitCheckIn({
          id: randomUUID(),
          orgId: ORG_A,
          patientId: PAT_A,
          episodeId: daily.id,
          weekIndex: 1,
          idempotencyKey: randomUUID(),
          requestHash: 'c'.repeat(64),
          answers: { Q1: 3, Q7: 6 },
          instrumentVersion: '1.0.0',
          clientCreatedAt: new Date(),
          auditEvent: audit('x'),
        });
        const device = await activate({ startDate: day(-6), adherenceMode: 'device_or_injection' });
        await store.submitCheckIn({
          id: randomUUID(),
          orgId: ORG_A,
          patientId: PAT_A,
          episodeId: device.id,
          weekIndex: 1,
          idempotencyKey: randomUUID(),
          requestHash: 'd'.repeat(64),
          answers: { Q1: 3, Q7: 'yes' },
          instrumentVersion: '1.0.0',
          clientCreatedAt: new Date(),
          auditEvent: audit('x'),
        });
        const facts = await reviews.treatmentFacts(ORG_A, PAT_A);
        expect(facts.find((f) => f.episodeId === daily.id)?.adherence).toBe(0.857);
        expect(facts.find((f) => f.episodeId === device.id)?.adherence).toBe(1);
        const due = await activate({ startDate: day(3 - 84) });
        await verdicts.record({
          id: randomUUID(),
          orgId: ORG_A,
          patientId: PAT_A,
          episodeId: due.id,
          result: { outcome: 'not_generated', reason: 'ruleset_incomplete' },
          rulesetVersion: '1.0.0',
          rulesetDigest: 'd'.repeat(64),
          instrumentVersion: '1.0.0',
          generatedBy: 'system',
          requestedBy: null,
          auditEvent: audit('x'),
        });
        const row = (await reviews.queue(ORG_A, day(0), 14)).find((q) => q.episodeId === due.id);
        expect(row?.verdict).toMatchObject({ code: null, shadow: true });
        await expect(reviews.queue(ORG_A, 'today', 14)).rejects.toThrow(TypeError);
      });

      it('reads the facts for a pre-surgery check and records it once', async () => {
        const reviews = new PostgresReviewStore(apiDb);
        const e = await activate();
        await checkIn(e.id, 1);
        const facts = await reviews.treatmentFacts(ORG_A, PAT_A);
        const f = facts.find((x) => x.episodeId === e.id);
        expect(f).toMatchObject({ checkIns: 1, adherence: null, status: 'active' });
        const key = randomUUID();
        const c = {
          id: randomUUID(),
          orgId: ORG_A,
          patientId: PAT_A,
          clinicianId: CLIN_A,
          procedure: 'hysterectomy',
          snapshot: { treatments: facts.length },
          fresh: true,
          idempotencyKey: key,
          requestHash: 'a'.repeat(64),
          auditEvent: audit('surgery_check.recorded'),
        };
        // Evidence changed since the preview: nothing saved.
        expect(
          await reviews.recordSurgeryCheck({ ...c, idempotencyKey: randomUUID(), fresh: false }),
        ).toEqual({ outcome: 'stale' });
        expect(await reviews.recordSurgeryCheck(c)).toMatchObject({
          outcome: 'recorded',
          id: c.id,
        });
        expect(await reviews.recordSurgeryCheck({ ...c, id: randomUUID() })).toEqual({
          outcome: 'replay',
          id: c.id,
          snapshot: c.snapshot,
        });
        // The same key for another procedure is refused, never reported as saved.
        expect(
          await reviews.recordSurgeryCheck({
            ...c,
            id: randomUUID(),
            procedure: 'myomectomy',
            requestHash: 'b'.repeat(64),
          }),
        ).toEqual({ outcome: 'conflict' });
        expect(await reviews.surgeryChecks(ORG_A, PAT_A)).toHaveLength(1);
        expect((await reviews.surgeryChecks(ORG_A, PAT_A))[0]).toMatchObject({
          procedure: 'hysterectomy',
        });
        expect(await reviews.surgeryChecks(ORG_B, PAT_A)).toEqual([]);
        await expect(
          reviews.recordSurgeryCheck({
            ...c,
            id: randomUUID(),
            idempotencyKey: randomUUID(),
            procedure: 'appendectomy',
            requestHash: 'c'.repeat(64),
          }),
        ).rejects.toThrow(/check/);
      });
    });

    describe('REQ-008 share links (migration 0013)', () => {
      it('creates a link found only by its token hash while live, at most 30 days, revoked once', async () => {
        const links = new PostgresShareLinkStore(apiDb);
        const key = randomUUID();
        const hash = createHash('sha256').update(randomUUID()).digest('hex');
        const link = await links.create({
          id: randomUUID(),
          orgId: ORG_A,
          patientId: PAT_A,
          tokenHash: hash,
          days: 7,
          creationKey: key,
          auditEvent: audit('share_link.created'),
        });
        expect(link.replay).toBe(false);
        // A retry with her key finds the same link (its token is never shown again).
        const retry = await links.create({
          id: randomUUID(),
          orgId: ORG_A,
          patientId: PAT_A,
          tokenHash: createHash('sha256').update(randomUUID()).digest('hex'),
          days: 7,
          creationKey: key,
          auditEvent: audit('x'),
        });
        expect(retry).toMatchObject({ id: link.id, replay: true });
        const days = (link.expiresAt.getTime() - link.createdAt.getTime()) / 86_400_000;
        expect(days).toBeGreaterThan(6.9);
        expect(days).toBeLessThan(7.1);
        expect(await links.findLive(hash)).toMatchObject({
          id: link.id,
          orgId: ORG_A,
          patientId: PAT_A,
        });
        expect((await links.list(ORG_A, PAT_A)).map((l) => l.id)).toContain(link.id);
        expect(await links.list(ORG_B, PAT_A)).toEqual([]);
        // 100 newer stopped links never hide a live one, from her list or her access log.
        for (let i = 0; i < 101; i += 1) {
          const id = randomUUID();
          await links.create({
            id,
            orgId: ORG_A,
            patientId: PAT_A,
            tokenHash: createHash('sha256').update(randomUUID()).digest('hex'),
            days: 1,
            creationKey: randomUUID(),
            auditEvent: audit('x'),
          });
          await links.revoke(ORG_A, PAT_A, id, audit('x'));
        }
        const listed = await links.list(ORG_A, PAT_A);
        expect(listed.map((l) => l.id)).toContain(link.id);
        expect(listed.length).toBeLessThanOrEqual(101);
        expect(await links.ids(ORG_A, PAT_A)).toContain(link.id);
        expect((await links.ids(ORG_A, PAT_A)).length).toBeGreaterThan(101);
        expect(await links.ids(ORG_B, PAT_A)).toEqual([]);
        // Someone else's patient cannot revoke it; she can, once.
        expect(await links.revoke(ORG_A, PAT_A2, link.id, audit('x'))).toBe(false);
        expect(await links.revoke(ORG_A, PAT_A, link.id, audit('share_link.revoked'))).toBe(true);
        expect(await links.revoke(ORG_A, PAT_A, link.id, audit('x'))).toBe(false);
        expect(await links.findLive(hash)).toBeNull();
        // Even a caller asking for more than 30 days gets at most 30 (database clock).
        const capped = createHash('sha256').update(randomUUID()).digest('hex');
        await asApi(async (c) => {
          await c.query(
            `INSERT INTO share_link (id, org_id, patient_id, token_hash, expires_at, creation_key)
           VALUES ($1, $2, $3, $4, now() + interval '90 days', $5)`,
            [randomUUID(), ORG_A, PAT_A, capped, randomUUID()],
          );
          const r = await c.query(
            `SELECT expires_at - created_at <= interval '30 days' AS ok FROM share_link WHERE token_hash = $1`,
            [capped],
          );
          expect(r.rows[0]).toEqual({ ok: true });
          await expect(
            c.query('DELETE FROM share_link WHERE token_hash = $1', [capped]),
          ).rejects.toThrow(/permission denied|not deleted/);
        });
        await expect(
          links.create({
            id: randomUUID(),
            orgId: ORG_A,
            patientId: PAT_A,
            tokenHash: hash,
            days: 31,
            creationKey: randomUUID(),
            auditEvent: audit('x'),
          }),
        ).rejects.toThrow(TypeError);
        await expect(links.findLive('nope')).rejects.toThrow(TypeError);
      });
    });

    describe('REQ-009 deletion: 14 days of grace, then erasure with crypto-shredding (migration 0014)', () => {
      it('erases only a due, uncancelled request; everything of hers goes, her key first', async () => {
        const deletions = new PostgresDeletionStore(apiDb);
        // A patient of her own, with one of everything.
        const pat = randomUUID();
        const ref = randomUUID();
        await admin.query(
          'INSERT INTO patient_record (id, org_id, identity_ref) VALUES ($1, $2, $3)',
          [pat, ORG_A, ref],
        );
        await admin.query(
          `INSERT INTO consent (id, patient_id, org_id, purpose, status, version)
         VALUES ($1, $2, $3, 'share_with_care_team', 'granted', 1)`,
          [randomUUID(), pat, ORG_A],
        );
        // Enrolled like any patient: a claimed invitation, with a released reservation on it.
        const invitation = randomUUID();
        const setup = await admin.connect();
        try {
          await setup.query('BEGIN');
          await setup.query('SET LOCAL session_replication_role = replica');
          await setup.query(
            `INSERT INTO enrolment_invitation
               (id, org_id, created_by, token_hash, expires_at, claimed_at, patient_id,
                reserved_by, reserved_at)
             VALUES ($1, $2, $3, $4, now() + interval '1 day', now(), $5, $6, now())`,
            [
              invitation,
              ORG_A,
              CLIN_A,
              createHash('sha256').update(invitation).digest('hex'),
              pat,
              randomUUID(),
            ],
          );
          await setup.query(
            'INSERT INTO enrolment_reservation_fence (transaction_id, org_id, invitation_id) VALUES ($1, $2, $3)',
            [randomUUID(), ORG_A, invitation],
          );
          await setup.query('COMMIT');
        } finally {
          setup.release();
        }
        const e = await mk({ patientId: pat, startDate: day(-6) });
        const keys = new PostgresPatientKeyStore(apiDb, ORG_A);
        const cipher = new FieldCipher(new DevKeyManager('test'), keys);
        const goalId = randomUUID();
        const sealed = await cipher.encrypt('SYNTHETIC goal', {
          patientId: pat,
          field: 'goal.text',
          recordId: goalId,
        });
        await store.confirm({
          orgId: ORG_A,
          patientId: pat,
          episodeId: e.id,
          confirmKey: randomUUID(),
          goalId,
          goal: { textEncrypted: sealed },
          timeZone: 'UTC',
          auditEvent: audit('x'),
        });
        await store.recordRedFlag({
          id: randomUUID(),
          orgId: ORG_A,
          patientId: pat,
          episodeId: e.id,
          idempotencyKey: randomUUID(),
          flags: ['RF1'],
          instrumentVersion: '1.0.0',
          shownAt: new Date(),
          acknowledgedAt: null,
          auditEvent: audit('x'),
        });

        expect(await deletions.identityRefOf(ORG_A, pat)).toBe(ref);
        const req = await deletions.request({
          id: randomUUID(),
          orgId: ORG_A,
          patientId: pat,
          identityRef: ref,
          auditEvent: audit('deletion.requested'),
        });
        expect((req.dueAt.getTime() - req.requestedAt.getTime()) / 86_400_000).toBeCloseTo(14, 3);
        // Asking again returns the same open request.
        expect(
          (
            await deletions.request({
              id: randomUUID(),
              orgId: ORG_A,
              patientId: pat,
              identityRef: ref,
              auditEvent: audit('x'),
            })
          ).id,
        ).toBe(req.id);
        expect(await deletions.identityRefOf(ORG_A, randomUUID())).toBeNull();
        // Concurrent first requests (after a cancel) return one request, never an error.
        expect(await deletions.cancel(ORG_A, pat, audit('x'))).toBe(true);
        // A database error other than the one-open-request race is passed on.
        await expect(
          deletions.request({
            id: 'not-a-uuid',
            orgId: ORG_A,
            patientId: pat,
            identityRef: ref,
            auditEvent: audit('x'),
          }),
        ).rejects.toThrow();
        const both = await Promise.all(
          [0, 1, 2].map(() =>
            deletions.request({
              id: randomUUID(),
              orgId: ORG_A,
              patientId: pat,
              identityRef: ref,
              auditEvent: audit('x'),
            }),
          ),
        );
        expect(new Set(both.map((b) => b.id)).size).toBe(1);
        // Not due yet: nothing happens.
        expect(await deletions.erase(ORG_A, pat, audit('x'))).toBe(false);
        expect((await deletions.due()).map((d) => d.patientId)).not.toContain(pat);
        // Cancel, then ask again.
        expect(await deletions.cancel(ORG_A, pat, audit('deletion.cancelled'))).toBe(true);
        expect(await deletions.cancel(ORG_A, pat, audit('x'))).toBe(false);
        const again = await deletions.request({
          id: randomUUID(),
          orgId: ORG_A,
          patientId: pat,
          identityRef: ref,
          auditEvent: audit('x'),
        });
        expect(again.id).not.toBe(req.id);
        // The 14 days pass (setup only: moved back with triggers off).
        const c = await admin.connect();
        try {
          await c.query('BEGIN');
          await c.query('SET LOCAL session_replication_role = replica');
          await c.query(
            `UPDATE deletion_request SET due_at = now() - interval '1 minute' WHERE id = $1`,
            [again.id],
          );
          await c.query('COMMIT');
        } finally {
          c.release();
        }
        expect((await deletions.due()).map((d) => d.patientId)).toContain(pat);
        // The API role cannot delete her data directly, even now.
        await expect(
          asApi((cl) => cl.query('DELETE FROM check_in WHERE patient_id = $1', [pat])),
        ).rejects.toThrow(/permission denied/);
        expect(await deletions.erase(ORG_A, pat, audit('deletion.erased'))).toBe(true);
        expect(await deletions.erase(ORG_A, pat, audit('x'))).toBe(false);
        for (const q of [
          'SELECT 1 FROM treatment_episode WHERE patient_id = $1',
          'SELECT 1 FROM goal WHERE patient_id = $1',
          'SELECT 1 FROM red_flag_event WHERE patient_id = $1',
          'SELECT 1 FROM check_in WHERE patient_id = $1',
          'SELECT 1 FROM consent WHERE patient_id = $1',
        ])
          expect((await admin.query(q, [pat])).rowCount).toBe(0);
        expect(
          (await admin.query('SELECT 1 FROM enrolment_invitation WHERE id = $1', [invitation]))
            .rowCount,
        ).toBe(0);
        expect(
          (
            await admin.query(
              'SELECT 1 FROM enrolment_reservation_fence WHERE invitation_id = $1',
              [invitation],
            )
          ).rowCount,
        ).toBe(0);
        expect(
          (await admin.query('SELECT 1 FROM patient_record WHERE id = $1', [pat])).rowCount,
        ).toBe(0);
        expect(
          (await admin.query('SELECT 1 FROM patient_key WHERE patient_id = $1', [pat])).rowCount,
        ).toBe(0);
        expect(
          (await admin.query('SELECT 1 FROM patient_key_shredded WHERE patient_id = $1', [pat]))
            .rowCount,
        ).toBe(1);
        await expect(
          cipher.decrypt(sealed, { patientId: pat, field: 'goal.text', recordId: goalId }),
        ).rejects.toThrow();
        expect((await deletions.status(ORG_A, pat))?.erasedAt).toBeInstanceOf(Date);
        // Then her identity record, through the identity service.
        const pending = await deletions.identityPending();
        expect(pending.map((p) => p.identityRef)).toContain(ref);
        const mine = pending.find((p) => p.identityRef === ref);
        if (mine) await deletions.markIdentityErased(ORG_A, mine.id);
        expect((await deletions.identityPending()).map((p) => p.identityRef)).not.toContain(ref);
        // The request itself is kept, and cannot be undone or removed.
        await expect(
          asApi((cl) => cl.query('DELETE FROM deletion_request WHERE patient_id = $1', [pat])),
        ).rejects.toThrow(/permission denied/);
      });
    });

    describe('REQ-010 organisation admin (migration 0015)', () => {
      it('keeps settings per organisation and never leaves one without an active admin', async () => {
        const orgAdmin = new PostgresOrgAdminStore(apiDb);
        const adminId = randomUUID();
        await admin.query(
          `INSERT INTO clinician (id, org_id, identity_ref, role) VALUES ($1, $2, $3, 'org_admin')`,
          [adminId, ORG_A, randomUUID()],
        );
        expect(await orgAdmin.settings(ORG_A)).toMatchObject({
          languages: ['en'],
          updatedAt: null,
        });
        const saved = await orgAdmin.saveSettings({
          orgId: ORG_A,
          clinicianId: adminId,
          defaultReviewIntervalWeeks: 8,
          languages: ['en', 'sw'],
          emergencyNumber: '112',
          auditEvent: audit('org.settings.updated'),
        });
        expect(saved).toMatchObject({
          defaultReviewIntervalWeeks: 8,
          languages: ['en', 'sw'],
          emergencyNumber: '112',
        });
        expect(saved.updatedAt).toBeInstanceOf(Date);
        // Another organisation sees its own (defaults), never these.
        expect((await orgAdmin.settings(ORG_B)).emergencyNumber).toBeNull();
        await expect(
          orgAdmin.saveSettings({
            orgId: ORG_A,
            clinicianId: adminId,
            defaultReviewIntervalWeeks: 2,
            languages: ['en'],
            emergencyNumber: '112',
            auditEvent: audit('x'),
          }),
        ).rejects.toThrow(/check/);
        await expect(
          orgAdmin.saveSettings({
            orgId: ORG_A,
            clinicianId: adminId,
            defaultReviewIntervalWeeks: null,
            languages: ['EN; DROP'],
            emergencyNumber: null,
            auditEvent: audit('x'),
          }),
        ).rejects.toThrow(/check/);

        const members = await orgAdmin.members(ORG_A);
        expect(members.map((m) => m.clinicianId)).toEqual(
          expect.arrayContaining([CLIN_A, adminId]),
        );
        expect(await orgAdmin.members(ORG_B)).not.toContainEqual(
          expect.objectContaining({ clinicianId: CLIN_A }),
        );
        // Deactivate and reactivate a clinician.
        const change = (clinicianId: string, role: 'clinician' | 'org_admin', active: boolean) =>
          orgAdmin.changeMember({
            orgId: ORG_A,
            clinicianId,
            role,
            active,
            auditEvent: audit('x'),
          });
        expect(await change(CLIN_A, 'clinician', false)).toBe('changed');
        expect(await change(CLIN_A, 'clinician', false)).toBe('unchanged');
        expect(await change(CLIN_A, 'clinician', true)).toBe('changed');
        expect(await change(randomUUID(), 'clinician', true)).toBe('not_found');
        // The last active admin cannot be removed or demoted...
        expect(await change(adminId, 'org_admin', false)).toBe('last_admin');
        expect(await change(adminId, 'clinician', true)).toBe('last_admin');
        // ...but can once there is another.
        expect(await change(CLIN_A, 'org_admin', true)).toBe('changed');
        expect(await change(adminId, 'clinician', true)).toBe('changed');
        expect(await change(CLIN_A, 'clinician', true)).toBe('last_admin');
        // Any other database error is passed on, never mistaken for a refusal.
        await expect(change('not-a-uuid', 'clinician', true)).rejects.toThrow();
        // Leave CLIN_A as it was for other tests.
        expect(await change(adminId, 'org_admin', true)).toBe('changed');
        expect(await change(CLIN_A, 'clinician', true)).toBe('changed');
        // The API role cannot change anything else about a member.
        await expect(
          asApi((c) =>
            c.query('UPDATE clinician SET identity_ref = $1 WHERE id = $2', [randomUUID(), CLIN_A]),
          ),
        ).rejects.toThrow(/permission denied/);
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

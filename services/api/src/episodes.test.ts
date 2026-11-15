import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { AuditWriter, InMemoryAuditStore } from '@endo/audit';
import {
  InMemoryConsentStore,
  InMemoryIdempotentInvitationStore,
  InMemoryMembershipStore,
  type CheckInSubmission,
  type Episode,
  type EpisodeStore,
  type NewEpisode,
  type RedFlagReport,
} from '@endo/clinical-store';
import { loadClinicalContent } from '@endo/config';
import { DevKeyManager, EnvelopeSealer, FieldCipher, InMemoryPatientKeyStore } from '@endo/crypto';
import { redFlagKeyFor } from '@endo/domain';
import {
  ServiceTokenSigner,
  ServiceTokenVerifier,
  generateServiceKeyPair,
  type ServiceClaims,
} from '@endo/service-kit';
import { buildApi } from './app.ts';
import { openWeeks } from './routes/episodes.ts';

const ORG = '01900000-0000-7000-8000-00000000000a';
const IDENTITY_REF = '01900000-0000-7000-8000-0000000000e1';
const CLINICIAN_ID = '01900000-0000-7000-8000-0000000000c1';
const PATIENT_ID = '01900000-0000-7000-8000-0000000000a1';
const OTHER_PATIENT = '01900000-0000-7000-8000-0000000000a2';
const MARKER = 'SYNTHETIC_PHI_MARKER-goal-7f3a';
const CLINICIAN: ServiceClaims = {
  sub: IDENTITY_REF,
  role: 'clinician',
  org_id: ORG,
  patient_id: null,
};
const PATIENT: ServiceClaims = {
  sub: '01900000-0000-7000-8000-0000000000f1',
  role: 'patient',
  org_id: ORG,
  patient_id: PATIENT_ID,
};

const read = (p: string) =>
  readFileSync(fileURLToPath(new URL(`../../../clinical/${p}`, import.meta.url)), 'utf8');
const content = loadClinicalContent('test', {
  instrument: read('instrument/checkin.v1.json'),
  treatments: read('treatments/catalogue.v1.json'),
  goals: read('goals/templates.v1.json'),
});
const today = () => new Date().toISOString().slice(0, 10);
const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);

/** In-memory stand-in with the store's outcomes; the database rules are tested in clinical-store. */
class FakeEpisodes implements EpisodeStore {
  readonly episodes = new Map<string, Episode & { creationKey: string }>();
  readonly checkIns: CheckInSubmission[] = [];
  readonly redFlags: RedFlagReport[] = [];
  readonly sharing = new Set<string>([PATIENT_ID]);

  createDraft(e: NewEpisode) {
    const existing = [...this.episodes.values()].find(
      (x) => x.prescriberId === e.prescriberId && x.creationKey === e.creationKey,
    );
    if (existing)
      return Promise.resolve(
        existing.doseText === e.doseText
          ? { outcome: 'replay' as const, episode: existing }
          : { outcome: 'conflict' as const },
      );
    const ep = {
      ...e,
      lineId: e.id,
      reviewDate: e.startDate,
      timeZone: null,
      status: 'draft' as const,
      createdAt: new Date(),
      confirmedAt: null,
      closedAt: null,
      confirmKey: null,
      goal: null,
    };
    this.episodes.set(e.id, ep);
    return Promise.resolve({ outcome: 'created' as const, episode: ep });
  }
  listSharingPatients() {
    return Promise.resolve([...this.sharing].map((id) => ({ id, enrolledAt: new Date() })));
  }
  get(_o: string, id: string, patientId: string | null) {
    const e = this.episodes.get(id);
    return Promise.resolve(e && (patientId === null || e.patientId === patientId) ? e : null);
  }
  listForPatient(_o: string, patientId: string) {
    return Promise.resolve([...this.episodes.values()].filter((e) => e.patientId === patientId));
  }
  confirm(c: Parameters<EpisodeStore['confirm']>[0]) {
    const e = this.episodes.get(c.episodeId);
    if (!e || e.patientId !== c.patientId || e.status !== 'draft')
      return Promise.resolve({ outcome: 'not_found' as const });
    const next = {
      ...e,
      status: 'active' as const,
      timeZone: c.timeZone,
      confirmedAt: new Date(),
      confirmKey: c.confirmKey,
      goal: {
        id: c.goalId,
        templateCode: 'templateCode' in c.goal ? c.goal.templateCode : null,
        textEncrypted: 'textEncrypted' in c.goal ? c.goal.textEncrypted : null,
      },
    };
    this.episodes.set(e.id, next);
    return Promise.resolve({ outcome: 'confirmed' as const, episode: next });
  }
  submitCheckIn(c: CheckInSubmission) {
    const same = this.checkIns.find((x) => x.idempotencyKey === c.idempotencyKey);
    const saved = { id: c.id, weekIndex: c.weekIndex, submittedAt: new Date(), isLate: false };
    if (same)
      return Promise.resolve(
        same.requestHash === c.requestHash
          ? { outcome: 'replay' as const, checkIn: { ...saved, id: same.id } }
          : { outcome: 'conflict' as const },
      );
    if (this.checkIns.some((x) => x.episodeId === c.episodeId && x.weekIndex === c.weekIndex))
      return Promise.resolve({ outcome: 'week_done' as const });
    this.checkIns.push(c);
    return Promise.resolve({ outcome: 'saved' as const, checkIn: saved });
  }
  recordRedFlag(r: RedFlagReport) {
    const same = this.redFlags.find((x) => x.idempotencyKey === r.idempotencyKey);
    if (same)
      return Promise.resolve({ outcome: 'replay' as const, id: same.id, recordedAt: new Date() });
    const e = this.episodes.get(r.episodeId);
    if (!e || e.patientId !== r.patientId || !e.confirmedAt)
      return Promise.resolve({ outcome: 'not_found' as const });
    this.redFlags.push(r);
    return Promise.resolve({ outcome: 'recorded' as const, id: r.id, recordedAt: new Date() });
  }
  listCheckIns(_o: string, id: string) {
    return Promise.resolve(
      this.checkIns
        .filter((c) => c.episodeId === id)
        .map((c) => ({ ...c, submittedAt: new Date(), isLate: false })),
    );
  }
  listRedFlags(_o: string, id: string) {
    return Promise.resolve(
      this.redFlags
        .filter((r) => r.episodeId === id)
        .map((r) => ({ ...r, recordedAt: new Date() })),
    );
  }
}

async function setup(opts: { deployed?: boolean } = {}) {
  const clinicKeys = await generateServiceKeyPair();
  const patientKeys = await generateServiceKeyPair();
  const audit = new InMemoryAuditStore();
  const consents = new InMemoryConsentStore();
  await consents.recordEnrolment(ORG, PATIENT_ID, [
    {
      id: randomUUID(),
      purpose: 'share_with_care_team',
      status: 'granted',
      version: 1,
      chosenAt: new Date(),
      auditEvent: { id: randomUUID() },
    },
  ]);
  const episodes = new FakeEpisodes();
  const keys = new InMemoryPatientKeyStore();
  const kms = new DevKeyManager('test');
  const logs: string[] = [];
  const app = await buildApi({
    logLevel: 'info',
    logStream: { write: (l) => logs.push(l) },
    verifier: new ServiceTokenVerifier('api', {
      'bff-clinic': { publicJwk: clinicKeys.publicJwk, roles: ['clinician', 'org_admin'] },
      'bff-patient': { publicJwk: patientKeys.publicJwk, roles: ['patient'] },
    }),
    audit: new AuditWriter(audit),
    invitations: new InMemoryIdempotentInvitationStore(),
    memberships: new InMemoryMembershipStore().add(ORG, IDENTITY_REF, {
      clinicianId: CLINICIAN_ID,
      role: 'clinician',
      active: true,
    }),
    sealer: new EnvelopeSealer(kms, 'kms/clinical'),
    relayOutbox: () => Promise.resolve(),
    now: () => new Date(),
    consents,
    episodes: {
      episodes,
      content,
      cipherFor: () => new FieldCipher(kms, keys),
      deployed: opts.deployed ?? false,
    },
  });
  const clinic = new ServiceTokenSigner(clinicKeys.privateJwk, 'bff-clinic');
  const patient = new ServiceTokenSigner(patientKeys.privateJwk, 'bff-patient');
  const call = async (
    method: 'GET' | 'POST',
    url: string,
    who: 'clinician' | 'patient',
    payload?: object,
    key: string | null = randomUUID(),
    claims?: ServiceClaims,
  ) =>
    app.inject({
      method,
      url,
      headers: {
        authorization: `Bearer ${await (who === 'clinician' ? clinic : patient).sign(
          claims ?? (who === 'clinician' ? CLINICIAN : PATIENT),
          'api',
        )}`,
        ...(key && method === 'POST' ? { 'idempotency-key': key } : {}),
      },
      ...(payload ? { payload } : {}),
    });
  const treatment = { system: 'urn:endo:synthetic', code: 'SYNTH-DAILY' };
  const draft = (startDate = daysAgo(6), key = randomUUID()) =>
    call(
      'POST',
      `/v1/patients/${PATIENT_ID}/episodes`,
      'clinician',
      {
        treatment,
        dose_text: '1 tablet daily',
        start_date: startDate,
      },
      key,
    );
  const confirm = (
    id: string,
    goal: object = { template_code: 'synthetic_goal_a' },
    key: string = randomUUID(),
  ) => call('POST', `/v1/episodes/${id}/confirm`, 'patient', { goal, time_zone: 'UTC' }, key);
  return { app, call, draft, confirm, episodes, keys, audit, logs };
}

const answers = {
  Q1: 5,
  Q2: 'none',
  Q3: 'yes',
  Q5: [],
  Q7: 7,
  Q8: ['none'],
  red_flags: [],
};

describe('REQ-002 the clinician drafts, she confirms with her goal', () => {
  it('lists the catalogue and the patients who share with the care team', async () => {
    const { call } = await setup();
    const cat = await call('GET', '/v1/catalogue', 'clinician');
    expect(cat.statusCode).toBe(200);
    expect(cat.json<{ draft: boolean; treatments: { code: string }[] }>()).toMatchObject({
      draft: true,
      treatments: [{ code: 'SYNTH-DAILY' }, { code: 'SYNTH-DEVICE' }],
    });
    const pts = await call('GET', '/v1/patients', 'clinician');
    expect(pts.json<{ patients: { id: string }[] }>().patients.map((p) => p.id)).toEqual([
      PATIENT_ID,
    ]);
    // Patients cannot use either.
    expect((await call('GET', '/v1/patients', 'patient')).statusCode).toBe(403);
    expect((await call('GET', '/v1/catalogue', 'patient')).statusCode).toBe(403);
  });

  it('drafts once per Idempotency-Key, for a consented patient only', async () => {
    const { call, draft } = await setup();
    const key = randomUUID();
    const first = await draft(today(), key);
    expect(first.statusCode).toBe(201);
    expect(first.json()).toMatchObject({
      status: 'draft',
      treatment: { code: 'SYNTH-DAILY', display: 'Synthetic daily tablet (placeholder)' },
      adherence_mode: 'daily',
      review_interval_weeks: 12,
      goal: null,
    });
    const again = await draft(today(), key);
    expect(again.statusCode).toBe(200);
    expect(again.json<{ id: string }>().id).toBe(first.json<{ id: string }>().id);
    // A patient who does not share with the care team: denied by policy, before any handler.
    const denied = await call('POST', `/v1/patients/${OTHER_PATIENT}/episodes`, 'clinician', {
      treatment: { system: 'urn:endo:synthetic', code: 'SYNTH-DAILY' },
      dose_text: 'x',
      start_date: today(),
    });
    expect(denied.statusCode).toBe(403);
    expect(denied.json<{ type: string }>().type).toMatch(/authz.no_consent$/);
    // No key, an unknown treatment, a bad interval.
    expect(
      (await call('POST', `/v1/patients/${PATIENT_ID}/episodes`, 'clinician', {}, null)).statusCode,
    ).toBe(400);
    const unknown = await call('POST', `/v1/patients/${PATIENT_ID}/episodes`, 'clinician', {
      treatment: { system: 'urn:endo:synthetic', code: 'NOPE' },
      dose_text: 'x',
      start_date: today(),
    });
    expect(unknown.statusCode).toBe(422);
    const interval = await call('POST', `/v1/patients/${PATIENT_ID}/episodes`, 'clinician', {
      treatment: { system: 'urn:endo:synthetic', code: 'SYNTH-DAILY' },
      dose_text: 'x',
      start_date: today(),
      review_interval_weeks: 27,
    });
    expect(interval.statusCode).toBe(400);
  });

  it('refuses synthetic placeholder treatments when deployed', async () => {
    const { draft } = await setup({ deployed: true });
    expect((await draft()).statusCode).toBe(422);
  });

  it('encrypts her own words under her key and shows them only back to her', async () => {
    const { draft, confirm, call, episodes, logs } = await setup();
    const id = (await draft()).json<{ id: string }>().id;
    const confirmKey = randomUUID();
    const res = await confirm(id, { text: `  ${MARKER}  ` }, confirmKey);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      status: 'active',
      time_zone: 'UTC',
      goal: { text: MARKER },
    });
    const stored = episodes.episodes.get(id)?.goal;
    expect(stored?.textEncrypted).toMatch(/^v1\./);
    expect(stored?.textEncrypted).not.toContain(MARKER);
    const mine = await call('GET', '/v1/me/episodes', 'patient');
    expect(mine.json<{ episodes: { goal: { text: string } }[] }>().episodes[0]?.goal.text).toBe(
      MARKER,
    );
    // A retry with the same key and request replays; anything else is refused.
    expect((await confirm(id, { text: MARKER }, confirmKey)).statusCode).toBe(200);
    expect((await confirm(id, { text: 'other' }, confirmKey)).statusCode).toBe(422);
    expect((await confirm(id, { template_code: 'synthetic_goal_a' }, confirmKey)).statusCode).toBe(
      422,
    );
    expect((await confirm(id, { text: MARKER })).statusCode).toBe(409);
    expect(logs.join('\n')).not.toContain(MARKER);
  });

  it('checks her goal, time zone and ownership', async () => {
    const { draft, confirm, call } = await setup();
    const id = (await draft()).json<{ id: string }>().id;
    expect((await confirm(id, { template_code: 'not_a_goal' })).statusCode).toBe(422);
    expect((await confirm(id, { text: 'x'.repeat(141) })).statusCode).toBe(400);
    expect((await confirm(id, { text: 'a', template_code: 'synthetic_goal_a' })).statusCode).toBe(
      400,
    );
    const tz = await call('POST', `/v1/episodes/${id}/confirm`, 'patient', {
      goal: { template_code: 'synthetic_goal_a' },
      time_zone: 'Mars/Olympus',
    });
    expect(tz.statusCode).toBe(422);
    const other = await call(
      'POST',
      `/v1/episodes/${id}/confirm`,
      'patient',
      { goal: { template_code: 'synthetic_goal_a' }, time_zone: 'UTC' },
      randomUUID(),
      { ...PATIENT, patient_id: OTHER_PATIENT },
    );
    expect(other.statusCode).toBe(404);
    // Clinicians cannot confirm for her.
    expect(
      (
        await call('POST', `/v1/episodes/${id}/confirm`, 'clinician', {
          goal: { template_code: 'synthetic_goal_a' },
          time_zone: 'UTC',
        })
      ).statusCode,
    ).toBe(403);
  });
});

describe('REQ-003, REQ-007 weekly check-in and red flags', () => {
  const active = async () => {
    const s = await setup();
    const id = (await s.draft()).json<{ id: string }>().id;
    await s.confirm(id);
    return { ...s, id };
  };

  it('saves a valid week once per key, and says which weeks remain open', async () => {
    const { call, id, episodes } = await active();
    const key = randomUUID();
    const body = { week_index: 1, answers, client_created_at: new Date().toISOString() };
    const first = await call('POST', `/v1/episodes/${id}/checkins`, 'patient', body, key);
    expect(first.statusCode).toBe(201);
    expect(first.json()).toMatchObject({ week_index: 1, red_flags: false, open_weeks: [] });
    const replay = await call('POST', `/v1/episodes/${id}/checkins`, 'patient', body, key);
    expect(replay.statusCode).toBe(200);
    const other = await call(
      'POST',
      `/v1/episodes/${id}/checkins`,
      'patient',
      { ...body, answers: { ...answers, Q1: 6 } },
      key,
    );
    expect(other.statusCode).toBe(422);
    expect((await call('POST', `/v1/episodes/${id}/checkins`, 'patient', body)).statusCode).toBe(
      409,
    );
    expect(episodes.checkIns).toHaveLength(1);
  });

  it('refuses invalid answers without echoing them', async () => {
    const { call, id, episodes } = await active();
    const res = await call('POST', `/v1/episodes/${id}/checkins`, 'patient', {
      week_index: 1,
      answers: { ...answers, Q2: MARKER },
      client_created_at: new Date().toISOString(),
    });
    expect(res.statusCode).toBe(422);
    expect(res.body).not.toContain(MARKER);
    expect(res.body).not.toContain('Q2');
    expect(episodes.checkIns).toHaveLength(0);
  });

  it('records red flags even when the rest of the check-in is refused (red flags always win)', async () => {
    const { call, id, episodes, logs } = await active();
    const res = await call('POST', `/v1/episodes/${id}/checkins`, 'patient', {
      week_index: 1,
      answers: { ...answers, Q1: 99, red_flags: ['RF3'] },
      client_created_at: new Date().toISOString(),
    });
    expect(res.statusCode).toBe(422);
    expect(episodes.redFlags.map((r) => r.flags)).toEqual([['RF3']]);
    expect(logs.join('\n')).toContain('red_flag.recorded');
    expect(logs.join('\n')).not.toContain('RF3');
  });

  it('records the early red-flag report and the check-in’s copy once, under one derived key', async () => {
    const { call, id, episodes } = await active();
    const key = randomUUID();
    const early = await call(
      'POST',
      `/v1/episodes/${id}/red-flags`,
      'patient',
      {
        flags: ['RF1', 'RF3'],
        shown_at: new Date(Date.now() - 1000).toISOString(),
        acknowledged_at: new Date().toISOString(),
      },
      await redFlagKeyFor(key, ['RF1', 'RF3']),
    );
    expect(early.statusCode).toBe(201);
    const res = await call(
      'POST',
      `/v1/episodes/${id}/checkins`,
      'patient',
      {
        week_index: 1,
        answers: { ...answers, red_flags: ['RF3', 'RF1'] },
        client_created_at: new Date().toISOString(),
      },
      key,
    );
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ red_flags: true });
    expect(episodes.redFlags).toHaveLength(1);
  });

  it('records a flag she added after her early report as a new event, never losing it', async () => {
    const { call, id, episodes } = await active();
    const key = randomUUID();
    await call(
      'POST',
      `/v1/episodes/${id}/red-flags`,
      'patient',
      { flags: ['RF1'], shown_at: new Date().toISOString() },
      await redFlagKeyFor(key, ['RF1']),
    );
    const res = await call(
      'POST',
      `/v1/episodes/${id}/checkins`,
      'patient',
      {
        week_index: 1,
        answers: { ...answers, Q1: 99, red_flags: ['RF1', 'RF6'] },
        client_created_at: new Date().toISOString(),
      },
      key,
    );
    expect(res.statusCode).toBe(422);
    expect(episodes.redFlags.map((r) => r.flags)).toEqual([['RF1'], ['RF1', 'RF6']]);
  });

  it('records red flags even for an episode on another instrument version', async () => {
    const { call, id, episodes } = await active();
    const e = episodes.episodes.get(id);
    if (e) episodes.episodes.set(id, { ...e, instrumentVersion: '0.9.0' });
    const res = await call('POST', `/v1/episodes/${id}/checkins`, 'patient', {
      week_index: 1,
      answers: { ...answers, red_flags: ['RF2'] },
      client_created_at: new Date().toISOString(),
    });
    expect(res.statusCode).toBe(409);
    expect(episodes.redFlags.map((r) => r.flags)).toEqual([['RF2']]);
  });

  it('refuses unknown flags, an acknowledgement before the screen, and another patient’s episode', async () => {
    const { call, id } = await active();
    const now = new Date().toISOString();
    expect(
      (
        await call('POST', `/v1/episodes/${id}/red-flags`, 'patient', {
          flags: ['RF99'],
          shown_at: now,
        })
      ).statusCode,
    ).toBe(422);
    expect(
      (
        await call('POST', `/v1/episodes/${id}/red-flags`, 'patient', {
          flags: ['RF1'],
          shown_at: now,
          acknowledged_at: new Date(Date.now() - 60_000).toISOString(),
        })
      ).statusCode,
    ).toBe(422);
    expect(
      (
        await call(
          'POST',
          `/v1/episodes/${id}/red-flags`,
          'patient',
          { flags: ['RF1'], shown_at: now },
          randomUUID(),
          {
            ...PATIENT,
            patient_id: OTHER_PATIENT,
          },
        )
      ).statusCode,
    ).toBe(404);
  });

  it('gives the check-in content with every red flag, and the clinician her episodes with red flags', async () => {
    const { call, id } = await active();
    const c = await call('GET', '/v1/me/checkin-content', 'patient');
    expect(c.json<{ red_flags: { id: string }[]; draft: boolean }>()).toMatchObject({
      draft: true,
    });
    expect(c.json<{ red_flags: { id: string }[] }>().red_flags).toHaveLength(6);
    await call('POST', `/v1/episodes/${id}/red-flags`, 'patient', {
      flags: ['RF2'],
      shown_at: new Date().toISOString(),
    });
    const list = await call('GET', `/v1/patients/${PATIENT_ID}/episodes`, 'clinician');
    expect(list.statusCode).toBe(200);
    const flags = list.json<{
      episodes: { red_flags: { flags: string[]; recorded_at: string }[] }[];
    }>().episodes[0]?.red_flags;
    expect(flags?.map((f) => f.flags)).toEqual([['RF2']]);
    expect(typeof flags?.[0]?.recorded_at).toBe('string');
  });
});

describe('REQ-003 open weeks (mirrors the database rule)', () => {
  const ep = (startDate: string, status: Episode['status'] = 'active') =>
    ({ startDate, status, timeZone: 'UTC', reviewIntervalWeeks: 12 }) as Episode;
  it('opens week k on its last day and closes it 7 days after it ends', () => {
    const now = new Date();
    expect(openWeeks(ep(daysAgo(5)), new Set(), now)).toEqual([]);
    expect(openWeeks(ep(daysAgo(6)), new Set(), now)).toEqual([1]);
    expect(openWeeks(ep(daysAgo(13)), new Set(), now)).toEqual([1, 2]);
    expect(openWeeks(ep(daysAgo(13)), new Set([1]), now)).toEqual([2]);
    expect(openWeeks(ep(daysAgo(14)), new Set(), now)).toEqual([2]);
    expect(openWeeks(ep(daysAgo(6), 'draft'), new Set(), now)).toEqual([]);
  });
});

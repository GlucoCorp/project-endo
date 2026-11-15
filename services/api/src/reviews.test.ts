import { describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { AuditWriter, InMemoryAuditStore } from '@endo/audit';
import {
  InMemoryConsentStore,
  InMemoryIdempotentInvitationStore,
  InMemoryMembershipStore,
  type DecisionRequest,
  type Episode,
  type EpisodeStore,
  type ReviewStore,
} from '@endo/clinical-store';
import { loadClinicalContent } from '@endo/config';
import { DevKeyManager, EnvelopeSealer, FieldCipher, InMemoryPatientKeyStore } from '@endo/crypto';
import {
  ServiceTokenSigner,
  ServiceTokenVerifier,
  generateServiceKeyPair,
  type ServiceClaims,
} from '@endo/service-kit';
import { buildApi } from './app.ts';

const ORG = '01900000-0000-7000-8000-00000000000a';
const REF = '01900000-0000-7000-8000-0000000000e1';
const CLINICIAN_ID = '01900000-0000-7000-8000-0000000000c1';
const PATIENT = '01900000-0000-7000-8000-0000000000a1';
const OTHER = '01900000-0000-7000-8000-0000000000a2';
const EPISODE = '01900000-0000-7000-8000-0000000000e5';
const MARKER = 'SYNTHETIC_PHI_MARKER-note-7f3a';
const read = (p: string) =>
  readFileSync(fileURLToPath(new URL(`../../../clinical/${p}`, import.meta.url)), 'utf8');
const content = loadClinicalContent('test', {
  instrument: read('instrument/checkin.v1.json'),
  treatments: read('treatments/catalogue.v1.json'),
  goals: read('goals/templates.v1.json'),
});

const episode: Episode = {
  id: EPISODE,
  orgId: ORG,
  patientId: PATIENT,
  prescriberId: CLINICIAN_ID,
  lineId: EPISODE,
  previousEpisodeId: null,
  treatmentSystem: 'urn:endo:synthetic',
  treatmentCode: 'SYNTH-DAILY',
  adherenceMode: 'daily',
  doseText: '1 daily',
  startDate: '2026-08-24',
  reviewIntervalWeeks: 12,
  reviewDate: '2026-11-16',
  timeZone: 'UTC',
  instrumentVersion: '1.0.0',
  status: 'active',
  createdAt: new Date(),
  confirmedAt: new Date(),
  closedAt: null,
  confirmKey: null,
  goal: { id: randomUUID(), templateCode: 'synthetic_goal_a', textEncrypted: null },
};

class FakeReviews implements ReviewStore {
  readonly decided: DecisionRequest[] = [];
  readonly checks: {
    id: string;
    procedure: string;
    snapshot: unknown;
    key: string;
    hash: string;
  }[] = [];
  queue() {
    return Promise.resolve([
      {
        episodeId: EPISODE,
        patientId: PATIENT,
        treatmentSystem: 'urn:endo:synthetic',
        treatmentCode: 'SYNTH-DAILY',
        doseText: '1 daily',
        startDate: '2026-08-24',
        reviewDate: '2026-11-10',
        reviewIntervalWeeks: 12,
        checkIns: 9,
        redFlags: 1,
        verdict: { id: randomUUID(), code: 'WORKING', shadow: true },
      },
    ]);
  }
  decide(r: DecisionRequest) {
    const same = this.decided.find((d) => d.idempotencyKey === r.idempotencyKey);
    if (same)
      return Promise.resolve(
        same.requestHash === r.requestHash
          ? {
              outcome: 'replay' as const,
              id: same.id,
              nextEpisodeId: same.next?.id ?? null,
              addedEpisodeId: null,
            }
          : { outcome: 'conflict' as const },
      );
    if (this.decided.some((d) => d.episodeId === r.episodeId))
      return Promise.resolve({ outcome: 'not_open' as const });
    this.decided.push(r);
    return Promise.resolve({
      outcome: 'recorded' as const,
      id: r.id,
      nextEpisodeId: r.next?.id ?? null,
      addedEpisodeId: r.added?.id ?? null,
    });
  }
  decisions() {
    return Promise.resolve(
      this.decided.map((d) => ({
        id: d.id,
        episodeId: d.episodeId,
        decision: d.decision,
        noteEncrypted: d.noteEncrypted,
        nextEpisodeId: d.next?.id ?? null,
        addedEpisodeId: null,
        decidedAt: new Date(),
      })),
    );
  }
  treatmentFacts() {
    return Promise.resolve([
      {
        episodeId: EPISODE,
        treatmentSystem: 'urn:endo:synthetic',
        treatmentCode: 'SYNTH-DAILY',
        doseText: '1 daily',
        startDate: '2026-08-24',
        reviewDate: '2026-11-16',
        status: 'closed',
        reviewIntervalWeeks: 12,
        checkIns: 10,
        adherence: 0.9,
        decision: 'switch' as const,
      },
    ]);
  }
  recordSurgeryCheck(c: Parameters<ReviewStore['recordSurgeryCheck']>[0]) {
    const same = this.checks.find((x) => x.key === c.idempotencyKey);
    if (same)
      return Promise.resolve(
        same.hash === c.requestHash
          ? { outcome: 'replay' as const, id: same.id, snapshot: same.snapshot }
          : { outcome: 'conflict' as const },
      );
    if (!c.fresh) return Promise.resolve({ outcome: 'stale' as const });
    this.checks.push({
      id: c.id,
      procedure: c.procedure,
      snapshot: c.snapshot,
      key: c.idempotencyKey,
      hash: c.requestHash,
    });
    return Promise.resolve({ outcome: 'recorded' as const, id: c.id, snapshot: c.snapshot });
  }
  surgeryChecks() {
    return Promise.resolve(
      this.checks.map((c) => ({
        id: c.id,
        procedure: c.procedure,
        snapshot: c.snapshot,
        acknowledgedAt: new Date(),
      })),
    );
  }
}

const episodes = {
  get: (_o: string, id: string, p: string | null) =>
    Promise.resolve(id === EPISODE && (p === null || p === PATIENT) ? episode : null),
  listForPatient: () => Promise.resolve([episode]),
  listCheckIns: () =>
    Promise.resolve([
      {
        id: 'c1',
        weekIndex: 1,
        answers: { Q1: 7 },
        instrumentVersion: '1.0.0',
        submittedAt: new Date(),
        isLate: false,
      },
    ]),
  listRedFlags: () =>
    Promise.resolve([
      {
        id: 'r',
        flags: ['RF3'],
        shownAt: new Date(),
        acknowledgedAt: null,
        recordedAt: new Date(),
      },
    ]),
} as unknown as EpisodeStore;

async function setup(consent = true) {
  const clinicKeys = await generateServiceKeyPair();
  const patientKeys = await generateServiceKeyPair();
  const consents = new InMemoryConsentStore();
  if (consent)
    await consents.recordEnrolment(ORG, PATIENT, [
      {
        id: randomUUID(),
        purpose: 'share_with_care_team',
        status: 'granted',
        version: 1,
        chosenAt: new Date(),
        auditEvent: { id: randomUUID() },
      },
    ]);
  const reviews = new FakeReviews();
  const kms = new DevKeyManager('test');
  const keys = new InMemoryPatientKeyStore();
  const logs: string[] = [];
  const auditStore = new InMemoryAuditStore();
  const app = await buildApi({
    logLevel: 'info',
    logStream: { write: (l) => logs.push(l) },
    verifier: new ServiceTokenVerifier('api', {
      'bff-clinic': { publicJwk: clinicKeys.publicJwk, roles: ['clinician', 'org_admin'] },
      'bff-patient': { publicJwk: patientKeys.publicJwk, roles: ['patient'] },
    }),
    audit: new AuditWriter(auditStore),
    invitations: new InMemoryIdempotentInvitationStore(),
    memberships: new InMemoryMembershipStore().add(ORG, REF, {
      clinicianId: CLINICIAN_ID,
      role: 'clinician',
      active: true,
    }),
    sealer: new EnvelopeSealer(kms, 'kms/clinical'),
    relayOutbox: () => Promise.resolve(),
    now: () => new Date('2026-11-14T10:00:00Z'),
    consents,
    reviews: {
      reviews,
      episodes,
      content,
      cipherFor: () => new FieldCipher(kms, keys),
      deployed: false,
    },
  });
  const clinic = new ServiceTokenSigner(clinicKeys.privateJwk, 'bff-clinic');
  const patient = new ServiceTokenSigner(patientKeys.privateJwk, 'bff-patient');
  const C: ServiceClaims = { sub: REF, role: 'clinician', org_id: ORG, patient_id: null };
  const P: ServiceClaims = { sub: randomUUID(), role: 'patient', org_id: ORG, patient_id: PATIENT };
  const call = async (
    method: 'GET' | 'POST',
    url: string,
    payload?: object,
    key: string | null = randomUUID(),
    who: 'c' | 'p' = 'c',
  ) =>
    app.inject({
      method,
      url,
      headers: {
        authorization: `Bearer ${await (who === 'c' ? clinic : patient).sign(who === 'c' ? C : P, 'api')}`,
        ...(key && method === 'POST' ? { 'idempotency-key': key } : {}),
      },
      ...(payload ? { payload } : {}),
    });
  const audited = async () => auditStore.readRange(1, 1000);
  return { call, reviews, logs, audited };
}

const decision = (body: object, key?: string) => ({
  url: `/v1/patients/${PATIENT}/episodes/${EPISODE}/decision`,
  body,
  key,
});

describe('REQ-005 the review queue and review', () => {
  it('lists the queue with red flags and overdue, and never a shadow verdict', async () => {
    const { call, audited } = await setup();
    const res = await call('GET', '/v1/reviews/queue');
    expect(res.statusCode).toBe(200);
    // Spec 13.3: each patient shown is audited against her record (her access log shows it).
    expect(
      (await audited()).filter(
        (e) => e.action === 'review.queue.listed' && e.resource.id === PATIENT,
      ),
    ).toHaveLength(1);
    expect(res.json()).toMatchObject({
      verdicts: 'shadow',
      truncated: false,
      items: [
        {
          episode_id: EPISODE,
          red_flags: 1,
          overdue: true,
          week: 12,
          treatment: { display: 'Synthetic daily tablet (placeholder)' },
        },
      ],
    });
    expect(res.body).not.toContain('WORKING');
    expect((await call('GET', '/v1/reviews/queue', undefined, null, 'p')).statusCode).toBe(403);
  });

  it('shows the evidence for a consented patient only', async () => {
    const { call } = await setup();
    const res = await call('GET', `/v1/patients/${PATIENT}/episodes/${EPISODE}/review`);
    expect(res.json()).toMatchObject({
      verdicts: 'shadow',
      episode: { goal: 'Synthetic goal A (placeholder)' },
      weeks: [{ week_index: 1, answers: { Q1: 7 } }],
      red_flags: [{ flags: ['RF3'] }],
      guideline_options: [],
    });
    expect(
      (await (await setup(false)).call('GET', `/v1/patients/${PATIENT}/episodes/${EPISODE}/review`))
        .statusCode,
    ).toBe(403);
    expect((await call('GET', `/v1/patients/${OTHER}/episodes/${EPISODE}/review`)).statusCode).toBe(
      403,
    );
  });
});

describe('REQ-005 decisions', () => {
  it('continue opens the same treatment from the review date; the note is encrypted, then shown', async () => {
    const { call, reviews, logs } = await setup();
    const d = decision({ decision: 'continue', note: MARKER });
    const key = randomUUID();
    const res = await call('POST', d.url, d.body, key);
    expect(res.statusCode).toBe(201);
    const stored = reviews.decided[0];
    expect(stored?.next).toMatchObject({
      treatmentCode: 'SYNTH-DAILY',
      startDate: '2026-11-16',
      reviewIntervalWeeks: 12,
    });
    expect(stored?.noteEncrypted).not.toContain(MARKER);
    expect((await call('POST', d.url, d.body, key)).statusCode).toBe(200);
    expect((await call('POST', d.url, { decision: 'stop' }, key)).statusCode).toBe(422);
    expect((await call('POST', d.url, { decision: 'stop' })).statusCode).toBe(409);
    const review = await call('GET', `/v1/patients/${PATIENT}/episodes/${EPISODE}/review`);
    expect(review.json<{ decisions: { note: string }[] }>().decisions[0]?.note).toBe(MARKER);
    expect(logs.join('\n')).not.toContain(MARKER);
  });

  it('switch needs the new treatment; add needs the added one; refer and stop open nothing', async () => {
    const next = {
      treatment: { system: 'urn:endo:synthetic', code: 'SYNTH-DEVICE' },
      dose_text: 'device',
      start_date: '2026-11-20',
    };
    expect(
      (await (await setup()).call('POST', decision({}).url, { decision: 'switch' })).statusCode,
    ).toBe(422);
    expect(
      (await (await setup()).call('POST', decision({}).url, { decision: 'add' })).statusCode,
    ).toBe(422);
    expect(
      (await (await setup()).call('POST', decision({}).url, { decision: 'stop', next })).statusCode,
    ).toBe(422);
    const s = await setup();
    expect((await s.call('POST', decision({}).url, { decision: 'switch', next })).statusCode).toBe(
      201,
    );
    expect(s.reviews.decided[0]?.next).toMatchObject({
      treatmentCode: 'SYNTH-DEVICE',
      adherenceMode: 'device_or_injection',
    });
    const a = await setup();
    expect(
      (await a.call('POST', decision({}).url, { decision: 'add', added: next })).statusCode,
    ).toBe(201);
    expect(a.reviews.decided[0]?.added?.treatmentCode).toBe('SYNTH-DEVICE');
    expect(a.reviews.decided[0]?.next?.treatmentCode).toBe('SYNTH-DAILY');
    // Continue and add keep her treatment; a different one is a switch.
    expect(
      (await (await setup()).call('POST', decision({}).url, { decision: 'continue', next }))
        .statusCode,
    ).toBe(422);
    expect(
      (await (await setup()).call('POST', decision({}).url, { decision: 'add', added: next, next }))
        .statusCode,
    ).toBe(422);
    expect(
      (await (await setup()).call('POST', decision({}).url, { decision: 'stop', added: next }))
        .statusCode,
    ).toBe(422);
    const unknown = { ...next, treatment: { system: 'urn:endo:synthetic', code: 'NOPE' } };
    expect(
      (await (await setup()).call('POST', decision({}).url, { decision: 'switch', next: unknown }))
        .statusCode,
    ).toBe(422);
    expect(
      (await (await setup(false)).call('POST', decision({}).url, { decision: 'stop' })).statusCode,
    ).toBe(403);
    expect(
      (await (await setup()).call('POST', decision({}).url, { decision: 'stop' }, null)).statusCode,
    ).toBe(400);
  });
});

describe('REQ-006 pre-surgery check', () => {
  it('shows facts, never a classification the clinical lead has not defined', async () => {
    const { call } = await setup();
    const res = await call('POST', `/v1/patients/${PATIENT}/surgery-checks/preview`, {
      procedure: 'hysterectomy',
    });
    expect(res.json()).toMatchObject({
      procedure: 'hysterectomy',
      treatments: [
        {
          adherence: 0.9,
          check_ins: 10,
          decision: 'switch',
          classification: 'pending_clinical_definition',
        },
      ],
      never_tried: { status: 'pending_clinical_definition' },
      fertility_intentions: { status: 'not_collected' },
    });
  });

  it('is saved only once acknowledged, once per key, and is visible to her', async () => {
    const { call, reviews } = await setup();
    const url = `/v1/patients/${PATIENT}/surgery-checks`;
    const hashOf = async (procedure: string) =>
      (await call('POST', `${url}/preview`, { procedure })).json<{ snapshot_hash: string }>()
        .snapshot_hash;
    const myo = await hashOf('myomectomy');
    const hyst = await hashOf('hysterectomy');
    expect(myo).toMatch(/^[0-9a-f]{64}$/);
    expect(myo).not.toBe(hyst);
    const ok = { procedure: 'myomectomy', discussed_with_patient: true, snapshot_hash: myo };
    expect(
      (await call('POST', url, { procedure: 'myomectomy', snapshot_hash: myo })).statusCode,
    ).toBe(400);
    expect((await call('POST', url, { ...ok, procedure: 'appendectomy' })).statusCode).toBe(400);
    // Without a preview, or after her record changed, nothing is saved.
    expect(
      (await call('POST', url, { procedure: 'myomectomy', discussed_with_patient: true }))
        .statusCode,
    ).toBe(400);
    expect((await call('POST', url, { ...ok, snapshot_hash: 'f'.repeat(64) })).statusCode).toBe(
      409,
    );
    // The acknowledgement covers the procedure it was shown for.
    expect((await call('POST', url, { ...ok, snapshot_hash: hyst })).statusCode).toBe(409);
    const key = randomUUID();
    expect((await call('POST', url, ok, key)).statusCode).toBe(201);
    expect((await call('POST', url, ok, key)).statusCode).toBe(200);
    // The same key for another procedure is refused, never reported as saved.
    expect(
      (
        await call(
          'POST',
          url,
          { procedure: 'hysterectomy', discussed_with_patient: true, snapshot_hash: hyst },
          key,
        )
      ).statusCode,
    ).toBe(422);
    expect(reviews.checks).toHaveLength(1);
    expect((await call('GET', url)).json<{ checks: unknown[] }>().checks).toHaveLength(1);
    const mine = await call('GET', '/v1/me/surgery-checks', undefined, null, 'p');
    expect(mine.json<{ checks: { procedure: string }[] }>().checks[0]?.procedure).toBe(
      'myomectomy',
    );
  });
});

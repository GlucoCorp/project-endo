import { describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { AuditWriter, InMemoryAuditStore } from '@endo/audit';
import {
  InMemoryConsentStore,
  InMemoryIdempotentInvitationStore,
  InMemoryMembershipStore,
  type DeletionStatus,
  type DeletionStore,
  type Episode,
  type EpisodeStore,
  type ReviewStore,
  type ShareLinkStore,
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
import { DeletionJob, HttpIdentityErasure } from './deletion-job.ts';

const ORG = '01900000-0000-7000-8000-00000000000a';
const PATIENT = '01900000-0000-7000-8000-0000000000a1';
const PERSON = '01900000-0000-7000-8000-0000000000b1';
const EPISODE = '01900000-0000-7000-8000-0000000000e5';
const DECISION = randomUUID();
const MARKER = 'SYNTHETIC_PHI_MARKER-goal-7f3a';
const NOTE = 'SYNTHETIC_PHI_MARKER-note-91c2';
const read = (p: string) =>
  readFileSync(fileURLToPath(new URL(`../../../clinical/${p}`, import.meta.url)), 'utf8');
const content = loadClinicalContent('test', {
  instrument: read('instrument/checkin.v1.json'),
  treatments: read('treatments/catalogue.v1.json'),
  goals: read('goals/templates.v1.json'),
});
const kms = new DevKeyManager('test');
const cipher = new FieldCipher(kms, new InMemoryPatientKeyStore());
const goalId = randomUUID();

class FakeDeletions implements DeletionStore {
  rows: (DeletionStatus & { patientId: string; ref: string; identityErased: boolean })[] = [];
  audits: unknown[] = [];
  request(r: Parameters<DeletionStore['request']>[0]) {
    const open = this.rows.find((x) => x.patientId === r.patientId && !x.cancelledAt);
    if (open) return Promise.resolve(open);
    const now = new Date('2026-11-15T10:00:00Z');
    const row = {
      id: r.id,
      requestedAt: now,
      dueAt: new Date(now.getTime() + 14 * 86_400_000),
      cancelledAt: null,
      erasedAt: null,
      patientId: r.patientId,
      ref: r.identityRef,
      identityErased: false,
    };
    this.rows.push(row);
    this.audits.push(r.auditEvent);
    return Promise.resolve(row);
  }
  status(_o: string, patientId: string) {
    return Promise.resolve(this.rows.findLast((x) => x.patientId === patientId) ?? null);
  }
  cancel(_o: string, patientId: string, auditEvent: unknown) {
    const open = this.rows.find((x) => x.patientId === patientId && !x.cancelledAt && !x.erasedAt);
    if (!open) return Promise.resolve(false);
    Object.assign(open, { cancelledAt: new Date() });
    this.audits.push(auditEvent);
    return Promise.resolve(true);
  }
  due() {
    return Promise.resolve(
      this.rows
        .filter((x) => !x.cancelledAt && !x.erasedAt && x.dueAt.getTime() <= Date.now())
        .map((x) => ({ patientId: x.patientId, orgId: ORG })),
    );
  }
  erase(_o: string, patientId: string, auditEvent: unknown) {
    const r = this.rows.find(
      (x) => x.patientId === patientId && !x.cancelledAt && !x.erasedAt && x.dueAt <= new Date(),
    );
    if (!r) return Promise.resolve(false);
    Object.assign(r, { erasedAt: new Date() });
    this.audits.push(auditEvent);
    return Promise.resolve(true);
  }
  identityPending() {
    return Promise.resolve(
      this.rows
        .filter((x) => x.erasedAt && !x.identityErased)
        .map((x) => ({ id: x.id, orgId: ORG, identityRef: x.ref })),
    );
  }
  markIdentityErased(_o: string, id: string) {
    const r = this.rows.find((x) => x.id === id);
    if (r) r.identityErased = true;
    return Promise.resolve();
  }
  identityRefOf(_o: string, patientId: string) {
    return Promise.resolve(patientId === PATIENT ? PERSON : null);
  }
}

async function setup() {
  const patientKeys = await generateServiceKeyPair();
  const clinicKeys = await generateServiceKeyPair();
  const store = new InMemoryAuditStore();
  const logs: string[] = [];
  const deletions = new FakeDeletions();
  const ep: Episode = {
    id: EPISODE,
    orgId: ORG,
    patientId: PATIENT,
    prescriberId: randomUUID(),
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
    status: 'closed',
    createdAt: new Date(),
    confirmedAt: new Date(),
    closedAt: new Date(),
    confirmKey: null,
    goal: {
      id: goalId,
      templateCode: null,
      textEncrypted: await cipher.encrypt(MARKER, {
        patientId: PATIENT,
        field: 'goal.text',
        recordId: goalId,
      }),
    },
  };
  const episodes = {
    listForPatient: () => Promise.resolve([ep]),
    listCheckIns: () =>
      Promise.resolve([
        {
          id: randomUUID(),
          weekIndex: 1,
          answers: { Q1: 6, Q2: 1.5, Q4: true, red_flags: ['RF3'], Q8: ['none', 'rest'], Q9: null },
          instrumentVersion: '1.0.0',
          submittedAt: new Date('2026-09-01T10:00:00Z'),
          isLate: false,
        },
      ]),
    listRedFlags: () =>
      Promise.resolve([
        {
          id: randomUUID(),
          flags: ['RF3'],
          shownAt: new Date('2026-09-01T10:00:00Z'),
          acknowledgedAt: null,
          recordedAt: new Date(),
        },
      ]),
  } as unknown as EpisodeStore;
  const reviews = {
    decisions: async () => [
      {
        id: DECISION,
        episodeId: EPISODE,
        decision: 'switch',
        noteEncrypted: await cipher.encrypt(NOTE, {
          patientId: PATIENT,
          field: 'review_decision.note',
          recordId: DECISION,
        }),
        nextEpisodeId: randomUUID(),
        addedEpisodeId: null,
        decidedAt: new Date('2026-11-16T09:00:00Z'),
      },
    ],
    surgeryChecks: () =>
      Promise.resolve([
        {
          id: randomUUID(),
          procedure: 'hysterectomy',
          snapshot: { treatments: [] },
          acknowledgedAt: new Date('2026-11-16T09:30:00Z'),
        },
      ]),
  } as unknown as ReviewStore;
  const links = { ids: () => Promise.resolve([]) } as unknown as ShareLinkStore;
  const consents = new InMemoryConsentStore();
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
  const app = await buildApi({
    logLevel: 'info',
    logStream: { write: (l) => logs.push(l) },
    verifier: new ServiceTokenVerifier('api', {
      'bff-patient': { publicJwk: patientKeys.publicJwk, roles: ['patient'] },
      'bff-clinic': { publicJwk: clinicKeys.publicJwk, roles: ['clinician', 'org_admin'] },
    }),
    audit: new AuditWriter(store),
    invitations: new InMemoryIdempotentInvitationStore(),
    memberships: new InMemoryMembershipStore().add(ORG, randomUUID(), {
      clinicianId: randomUUID(),
      role: 'clinician',
      active: true,
    }),
    sealer: new EnvelopeSealer(kms, 'kms/clinical'),
    relayOutbox: () => Promise.resolve(),
    now: () => new Date('2026-11-17T10:00:00Z'),
    consents,
    dataRights: {
      episodes,
      reviews,
      links,
      deletions,
      audit: store,
      content,
      cipherFor: () => cipher,
    },
  });
  const patient = new ServiceTokenSigner(patientKeys.privateJwk, 'bff-patient');
  const clinic = new ServiceTokenSigner(clinicKeys.privateJwk, 'bff-clinic');
  const me = async (method: 'GET' | 'POST', url: string, who: ServiceClaims | null = null) =>
    app.inject({
      method,
      url,
      headers: {
        authorization: `Bearer ${
          who
            ? await clinic.sign(who, 'api')
            : await patient.sign(
                { sub: PERSON, role: 'patient', org_id: ORG, patient_id: PATIENT },
                'api',
              )
        }`,
      },
    });
  return { me, deletions, store, logs };
}

describe('REQ-009 export', () => {
  it('gives her complete record as a FHIR R4 Bundle, never stored or cached, never logged', async () => {
    const { me, store, logs } = await setup();
    const res = await me('POST', '/v1/me/export');
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('application/fhir+json');
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.headers['content-disposition']).toContain('attachment');
    const b = res.json<{
      resourceType: string;
      type: string;
      entry: { resource: Record<string, unknown> }[];
    }>();
    expect(b).toMatchObject({ resourceType: 'Bundle', type: 'collection' });
    const types = b.entry.map((e) => e.resource['resourceType']);
    expect(types).toEqual(
      expect.arrayContaining([
        'Patient',
        'CarePlan',
        'Goal',
        'QuestionnaireResponse',
        'Flag',
        'Task',
        'Basic',
        'Consent',
        'AuditEvent',
      ]),
    );
    // Her goal and the clinician's note, in her words and theirs.
    expect(res.body).toContain(MARKER);
    expect(res.body).toContain(NOTE);
    const qr = b.entry.find((e) => e.resource['resourceType'] === 'QuestionnaireResponse');
    expect(qr?.resource['item']).toEqual(
      expect.arrayContaining([
        { linkId: 'Q1', answer: [{ valueInteger: 6 }] },
        { linkId: 'Q2', answer: [{ valueDecimal: 1.5 }] },
        { linkId: 'Q4', answer: [{ valueBoolean: true }] },
        { linkId: 'Q8', answer: [{ valueString: 'none' }, { valueString: 'rest' }] },
      ]),
    );
    // Every reference resolves to an entry of the Bundle (a collection has no server base).
    const urls = new Set(b.entry.map((e) => (e as { fullUrl?: string }).fullUrl).filter(Boolean));
    const refs = [...res.body.matchAll(/"reference":"([^"]+)"/g)].map((m) => m[1] ?? '');
    expect(refs.length).toBeGreaterThan(0);
    expect(refs.filter((r) => !urls.has(r))).toEqual([]);
    // Shadow verdicts are not part of it; neither are her name or email (identity vault).
    expect(types).not.toContain('Observation');
    // Audited (the policy writes it before the handler), with no content.
    const events = await store.readRange(1, 100);
    expect(events.some((e) => e.action === 'own_data.export' && e.outcome === 'success')).toBe(
      true,
    );
    expect(JSON.stringify(events)).not.toContain('SYNTHETIC_PHI_MARKER');
    expect(logs.join('\n')).not.toContain('SYNTHETIC_PHI_MARKER');
  });

  it('is hers alone: a clinician cannot export it', async () => {
    const { me } = await setup();
    const res = await me('POST', '/v1/me/export', {
      sub: randomUUID(),
      role: 'clinician',
      org_id: ORG,
      patient_id: null,
    });
    expect(res.statusCode).toBe(403);
  });
});

describe('REQ-009 deletion', () => {
  it('schedules in 14 days, can be cancelled, and asked again', async () => {
    const { me, deletions } = await setup();
    expect((await me('GET', '/v1/me/deletion')).json()).toEqual({ status: 'none' });
    const asked = await me('POST', '/v1/me/deletion');
    expect(asked.statusCode).toBe(202);
    const body = asked.json<{ status: string; requested_at: string; due_at: string }>();
    expect(body.status).toBe('scheduled');
    expect((Date.parse(body.due_at) - Date.parse(body.requested_at)) / 86_400_000).toBe(14);
    // Asking again changes nothing.
    expect((await me('POST', '/v1/me/deletion')).json()).toEqual(body);
    expect(deletions.rows).toHaveLength(1);
    expect((await me('POST', '/v1/me/deletion/cancel')).json()).toMatchObject({
      status: 'cancelled',
    });
    expect((await me('POST', '/v1/me/deletion/cancel')).statusCode).toBe(409);
    expect((await me('POST', '/v1/me/deletion')).statusCode).toBe(202);
    expect(deletions.rows).toHaveLength(2);
    expect(deletions.audits).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ action: 'deletion.requested' }),
        expect.objectContaining({ action: 'deletion.cancelled' }),
      ]),
    );
    // A clinician cannot ask for her deletion.
    expect(
      (
        await me('POST', '/v1/me/deletion', {
          sub: randomUUID(),
          role: 'clinician',
          org_id: ORG,
          patient_id: null,
        })
      ).statusCode,
    ).toBe(403);
  });
});

describe('REQ-009 the deletion job', () => {
  it('erases due requests only, then her identity record, retrying until the identity service answers', async () => {
    const deletions = new FakeDeletions();
    await deletions.request({
      id: randomUUID(),
      orgId: ORG,
      patientId: PATIENT,
      identityRef: PERSON,
      auditEvent: { id: randomUUID() },
    });
    const later = randomUUID();
    await deletions.request({
      id: randomUUID(),
      orgId: ORG,
      patientId: later,
      identityRef: randomUUID(),
      auditEvent: { id: randomUUID() },
    });
    // Hers is due; the other is not.
    const mine = deletions.rows[0];
    if (mine) Object.assign(mine, { dueAt: new Date(Date.now() - 60_000) });
    const later2 = deletions.rows[1];
    if (later2) Object.assign(later2, { dueAt: new Date(Date.now() + 86_400_000) });
    let answer = 503;
    const calls: { url: string; auth: string | null }[] = [];
    const keys = await generateServiceKeyPair();
    const { WorkloadTokenSigner } = await import('@endo/service-kit');
    const identity = new HttpIdentityErasure({
      identityBaseUrl: 'https://identity.test',
      signer: new WorkloadTokenSigner(keys.privateJwk, 'jobs'),
      fetch: (url, init) => {
        calls.push({
          url: url instanceof Request ? url.url : url.toString(),
          auth: new Headers(init?.headers).get('authorization'),
        });
        return Promise.resolve(new Response(null, { status: answer }));
      },
    });
    const job = new DeletionJob(deletions, identity, () => randomUUID());
    expect(await job.run()).toEqual({ erased: 1, identityErased: 0, failed: 1 });
    expect(calls[0]?.url).toBe(`https://identity.test/internal/v1/persons/${PERSON}/erasure`);
    expect(calls[0]?.auth).toMatch(/^Bearer /);
    expect(deletions.audits).toContainEqual(
      expect.objectContaining({
        action: 'patient.erased',
        actor: { id: null, role: 'system' },
        resource: { type: 'patient_record', id: PATIENT },
      }),
    );
    // The identity service answers next time; already gone (404) also counts as done.
    answer = 404;
    expect(await job.run()).toEqual({ erased: 0, identityErased: 1, failed: 0 });
    expect(await job.run()).toEqual({ erased: 0, identityErased: 0, failed: 0 });
    // The other patient's request is untouched.
    expect(deletions.rows[1]?.erasedAt).toBeNull();
  });

  it('counts a network failure and an erase failure, and carries on', async () => {
    const deletions = new FakeDeletions();
    const failing = Object.assign(Object.create(deletions) as FakeDeletions, {
      due: () =>
        Promise.resolve([
          { patientId: PATIENT, orgId: ORG },
          { patientId: randomUUID(), orgId: ORG },
        ]),
      erase: (_o: string, p: string) =>
        p === PATIENT ? Promise.reject(new Error('db')) : Promise.resolve(true),
      identityPending: () =>
        Promise.resolve([{ id: randomUUID(), orgId: ORG, identityRef: PERSON }]),
    });
    const keys = await generateServiceKeyPair();
    const { WorkloadTokenSigner } = await import('@endo/service-kit');
    const identity = new HttpIdentityErasure({
      identityBaseUrl: 'https://identity.test',
      signer: new WorkloadTokenSigner(keys.privateJwk, 'jobs'),
      fetch: () => Promise.reject(new TypeError('network')),
    });
    const job = new DeletionJob(failing, identity, () => randomUUID());
    expect(await job.run()).toEqual({ erased: 1, identityErased: 0, failed: 2 });
  });
});

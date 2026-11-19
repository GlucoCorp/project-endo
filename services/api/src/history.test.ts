import { describe, expect, it } from 'vitest';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { AuditWriter, InMemoryAuditStore } from '@endo/audit';
import {
  InMemoryConsentStore,
  InMemoryIdempotentInvitationStore,
  InMemoryMembershipStore,
  type Episode,
  type EpisodeStore,
  type ReviewStore,
  type ShareLink,
  type ShareLinkStore,
} from '@endo/clinical-store';
import { loadClinicalContent } from '@endo/config';
import { DevKeyManager, EnvelopeSealer, FieldCipher, InMemoryPatientKeyStore } from '@endo/crypto';
import {
  ServiceTokenSigner,
  ServiceTokenVerifier,
  WorkloadTokenSigner,
  WorkloadTokenVerifier,
  generateServiceKeyPair,
  type ServiceClaims,
} from '@endo/service-kit';
import { buildApi } from './app.ts';

const ORG = '01900000-0000-7000-8000-00000000000a';
const PATIENT = '01900000-0000-7000-8000-0000000000a1';
const EPISODE = '01900000-0000-7000-8000-0000000000e5';
const DECISION = randomUUID();
const MARKER = 'SYNTHETIC_PHI_MARKER-goal-7f3a';
const read = (p: string) =>
  readFileSync(fileURLToPath(new URL(`../../../clinical/${p}`, import.meta.url)), 'utf8');
const content = loadClinicalContent('test', {
  instrument: read('instrument/checkin.v1.json'),
  treatments: read('treatments/catalogue.v1.json'),
  goals: read('goals/templates.v1.json'),
});

const kms = new DevKeyManager('test');
const keys = new InMemoryPatientKeyStore();
const cipher = new FieldCipher(kms, keys);
const goalId = randomUUID();

async function episode(): Promise<Episode> {
  return {
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
}

class FakeLinks implements ShareLinkStore {
  readonly rows: (ShareLink & { hash: string; key: string })[] = [];
  create(l: Parameters<ShareLinkStore['create']>[0]) {
    const same = this.rows.find((r) => r.key === l.creationKey);
    if (same) return Promise.resolve({ ...same, replay: true });
    const row = {
      id: l.id,
      createdAt: new Date(),
      expiresAt: new Date(Date.now() + l.days * 86_400_000),
      revokedAt: null,
      hash: l.tokenHash,
      key: l.creationKey,
    };
    this.rows.push(row);
    return Promise.resolve({ ...row, replay: false });
  }
  list() {
    return Promise.resolve(this.rows);
  }
  ids() {
    return Promise.resolve(this.rows.map((r) => r.id));
  }
  revoke(_o: string, _p: string, id: string) {
    const r = this.rows.find((x) => x.id === id && x.revokedAt === null);
    if (r) Object.assign(r, { revokedAt: new Date() });
    return Promise.resolve(Boolean(r));
  }
  findLive(hash: string) {
    const r = this.rows.find((x) => x.hash === hash && x.revokedAt === null);
    return Promise.resolve(
      r ? { id: r.id, orgId: ORG, patientId: PATIENT, expiresAt: r.expiresAt } : null,
    );
  }
}

async function setup() {
  const patientKeys = await generateServiceKeyPair();
  const clinicKeys = await generateServiceKeyPair();
  const workload = await generateServiceKeyPair();
  const store = new InMemoryAuditStore();
  const writer = new AuditWriter(store);
  const links = new FakeLinks();
  const ep = await episode();
  const episodes = {
    listForPatient: () =>
      Promise.resolve([ep, { ...ep, id: randomUUID(), status: 'draft' as const }]),
    listCheckIns: () =>
      Promise.resolve([
        {
          id: 'c',
          weekIndex: 1,
          answers: { Q1: 6, Q7: 7, red_flags: ['RF3'], Q8: ['none'] },
          instrumentVersion: '1.0.0',
          submittedAt: new Date(),
          isLate: false,
        },
      ]),
  } as unknown as EpisodeStore;
  const reviews = {
    decisions: () =>
      Promise.resolve([
        {
          id: DECISION,
          episodeId: EPISODE,
          decision: 'switch',
          noteEncrypted: 'v1.secret-note',
          nextEpisodeId: null,
          addedEpisodeId: null,
          decidedAt: new Date(),
        },
      ]),
    surgeryChecks: () => Promise.resolve([]),
  } as unknown as ReviewStore;
  const app = await buildApi({
    logLevel: 'silent',
    verifier: new ServiceTokenVerifier('api', {
      'bff-patient': { publicJwk: patientKeys.publicJwk, roles: ['patient'] },
      'bff-clinic': { publicJwk: clinicKeys.publicJwk, roles: ['clinician', 'org_admin'] },
    }),
    workloadVerifier: new WorkloadTokenVerifier('api', {
      'bff-patient': { publicJwk: workload.publicJwk, scopes: ['api.share.view'] },
    }),
    audit: writer,
    invitations: new InMemoryIdempotentInvitationStore(),
    memberships: new InMemoryMembershipStore(),
    sealer: new EnvelopeSealer(kms, 'kms/clinical'),
    relayOutbox: () => Promise.resolve(),
    now: () => new Date(),
    consents: new InMemoryConsentStore(),
    history: { episodes, reviews, links, audit: store, content, cipherFor: () => cipher },
  });
  const patient = new ServiceTokenSigner(patientKeys.privateJwk, 'bff-patient');
  const P: ServiceClaims = { sub: randomUUID(), role: 'patient', org_id: ORG, patient_id: PATIENT };
  const me = async (
    method: 'GET' | 'POST' | 'DELETE',
    url: string,
    payload?: object,
    key: string | null = randomUUID(),
  ) =>
    app.inject({
      method,
      url,
      headers: {
        authorization: `Bearer ${await patient.sign(P, 'api')}`,
        ...(key && method === 'POST' ? { 'idempotency-key': key } : {}),
      },
      ...(payload ? { payload } : {}),
    });
  const view = async (
    tokenHash: string,
    signer = new WorkloadTokenSigner(workload.privateJwk, 'bff-patient'),
  ) =>
    app.inject({
      method: 'POST',
      url: '/internal/v1/shared/view',
      headers: { authorization: `Bearer ${await signer.sign(['api.share.view'], 'api')}` },
      payload: { token_hash: tokenHash },
    });
  return { me, view, links, store, writer };
}

describe('REQ-008 her history and share links', () => {
  it('shows her confirmed treatments with weeks, her goal and the decision, never notes or red-flag answers', async () => {
    const { me } = await setup();
    const res = await me('GET', '/v1/me/history');
    expect(res.statusCode).toBe(200);
    const body = res.json<{
      treatments: { goal: string; decision: string; weeks: { answers: object }[] }[];
    }>();
    expect(body.treatments).toHaveLength(1); // the draft is not history
    expect(body.treatments[0]).toMatchObject({ goal: MARKER, decision: 'switch' });
    expect(body.treatments[0]?.weeks[0]?.answers).toEqual({ Q1: 6, Q7: 7, Q8: ['none'] });
    expect(res.body).not.toContain('secret-note');
  });

  it('makes a link once (token shown once), lists it, and stops it', async () => {
    const { me, links } = await setup();
    const key = randomUUID();
    const res = await me('POST', '/v1/me/share-links', { days: 14 }, key);
    expect(res.statusCode).toBe(201);
    const { id, token } = res.json<{ id: string; token: string }>();
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(links.rows[0]?.hash).toBe(createHash('sha256').update(token).digest('hex'));
    expect(JSON.stringify(links.rows)).not.toContain(token);
    expect((await me('POST', '/v1/me/share-links', { days: 14 }, key)).statusCode).toBe(409);
    expect((await me('POST', '/v1/me/share-links', { days: 31 })).statusCode).toBe(400);
    expect((await me('GET', '/v1/me/share-links')).json()).toMatchObject({
      links: [{ id, active: true }],
    });
    expect((await me('DELETE', `/v1/me/share-links/${id}`)).statusCode).toBe(204);
    expect((await me('GET', '/v1/me/share-links')).json()).toMatchObject({
      links: [{ id, active: false }],
    });
    expect((await me('DELETE', `/v1/me/share-links/${id}`)).statusCode).toBe(204);
  });

  it('lets the receiver see the summary by the token hash, audited in her access log', async () => {
    const { me, view } = await setup();
    const { token } = (await me('POST', '/v1/me/share-links', {})).json<{ token: string }>();
    const hash = createHash('sha256').update(token).digest('hex');
    const seen = await view(hash);
    expect(seen.statusCode).toBe(200);
    expect(seen.json()).toMatchObject({ treatments: [{ goal: MARKER, decision: 'switch' }] });
    expect((await view('0'.repeat(64))).statusCode).toBe(404);
    // A different workload key is refused.
    const other = await generateServiceKeyPair();
    expect(
      (await view(hash, new WorkloadTokenSigner(other.privateJwk, 'bff-patient'))).statusCode,
    ).toBe(401);
    const log = await me('GET', '/v1/me/access-log');
    expect(log.json<{ events: { action: string; role: string }[] }>().events).toContainEqual(
      expect.objectContaining({ action: 'share_link.viewed', role: 'anonymous' }),
    );
  });

  it('spec 13.3: her access log shows reads of her record and changes once made', async () => {
    const { me, writer } = await setup();
    const base = {
      actor: { id: randomUUID(), role: 'clinician' as const },
      org_id: ORG,
      purpose_of_use: 'treatment' as const,
      outcome: 'success' as const,
      reason: null,
      request_id: randomUUID(),
    };
    await writer.write({
      ...base,
      action: 'review.queue.listed',
      resource: { type: 'patient_record', id: PATIENT },
    });
    // Allowed to start, then made: shown once, as made.
    await writer.write({
      ...base,
      action: 'review_decision.record',
      resource: { type: 'patient_record', id: PATIENT },
    });
    await writer.write({
      ...base,
      action: 'review.decided',
      resource: { type: 'review_decision', id: DECISION },
    });
    // Refused: shown.
    await writer.write({
      ...base,
      outcome: 'denied',
      reason: 'authz.no_consent',
      action: 'episode.create',
      resource: { type: 'patient_record', id: PATIENT },
    });
    const actions = (await me('GET', '/v1/me/access-log'))
      .json<{ events: { action: string }[] }>()
      .events.map((e) => e.action);
    expect(actions).toEqual(
      expect.arrayContaining(['review.queue.listed', 'review.decided', 'episode.create']),
    );
    expect(actions).not.toContain('review_decision.record');
  });
});

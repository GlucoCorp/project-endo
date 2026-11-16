import { describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { AuditWriter, InMemoryAuditStore } from '@endo/audit';
import {
  InMemoryConsentStore,
  InMemoryIdempotentInvitationStore,
  InMemoryMembershipStore,
  type EpisodeStore,
  type IntegrationClient,
  type IntegrationStore,
  type ResolvedClient,
  type ReviewStore,
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
} from '@endo/service-kit';
import { buildApi } from './app.ts';
import { validJwks } from './routes/integrations.ts';

const ORG = '01900000-0000-7000-8000-00000000000a';
const PATIENT = '01900000-0000-7000-8000-0000000000a1';
const OTHER = '01900000-0000-7000-8000-0000000000a2';
const ADMIN_REF = randomUUID();
const ADMIN_ID = randomUUID();
const NOTE = 'SYNTHETIC_PHI_MARKER-note-integration';
const read = (p: string) =>
  readFileSync(fileURLToPath(new URL(`../../../clinical/${p}`, import.meta.url)), 'utf8');
const content = loadClinicalContent('test', {
  instrument: read('instrument/checkin.v1.json'),
  treatments: read('treatments/catalogue.v1.json'),
  goals: read('goals/templates.v1.json'),
});
const KEY = { kty: 'EC', crv: 'P-384', x: 'xx', y: 'yy', alg: 'ES384', kid: 'k1' };

class FakeIntegrations implements IntegrationStore {
  rows: (IntegrationClient & { orgId: string; jwks: ResolvedClient['jwks'] })[] = [];
  create(c: Parameters<IntegrationStore['create']>[0]) {
    if (c.createdBy !== ADMIN_ID) return Promise.resolve('not_admin' as const);
    const row = {
      id: c.id,
      clientId: c.clientId,
      name: c.name,
      scopes: c.scopes,
      active: true,
      createdAt: new Date(),
      orgId: c.orgId,
      jwks: c.jwks,
    };
    this.rows.push(row);
    return Promise.resolve(row);
  }
  list() {
    return Promise.resolve(this.rows);
  }
  setActive(c: Parameters<IntegrationStore['setActive']>[0]) {
    const r = this.rows.find((x) => x.id === c.id && x.orgId === c.orgId);
    if (!r) return Promise.resolve(false);
    Object.assign(r, { active: c.active });
    return Promise.resolve(true);
  }
  readonly seen = new Set<string>();
  reserveAssertion(clientId: string, jti: string) {
    const k = `${clientId}/${jti}`;
    if (this.seen.has(k)) return Promise.resolve(false);
    this.seen.add(k);
    return Promise.resolve(true);
  }
  resolve(clientId: string) {
    const r = this.rows.find((x) => x.clientId === clientId);
    return Promise.resolve(
      r ? { id: r.id, orgId: r.orgId, jwks: r.jwks, scopes: r.scopes, active: r.active } : null,
    );
  }
}

async function setup() {
  const keys = await generateServiceKeyPair();
  const workload = await generateServiceKeyPair();
  const store = new InMemoryAuditStore();
  const integrations = new FakeIntegrations();
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
  const cipher = new FieldCipher(new DevKeyManager('test'), new InMemoryPatientKeyStore());
  const decision = randomUUID();
  const app = await buildApi({
    logLevel: 'silent',
    verifier: new ServiceTokenVerifier('api', {
      'bff-clinic': { publicJwk: keys.publicJwk, roles: ['clinician', 'org_admin'] },
    }),
    workloadVerifier: new WorkloadTokenVerifier('api', {
      integration: {
        publicJwk: workload.publicJwk,
        scopes: ['api.integration.resolve', 'api.fhir.read'],
      },
    }),
    audit: new AuditWriter(store),
    invitations: new InMemoryIdempotentInvitationStore(),
    memberships: new InMemoryMembershipStore().add(ORG, ADMIN_REF, {
      clinicianId: ADMIN_ID,
      role: 'org_admin',
      active: true,
    }),
    sealer: new EnvelopeSealer(new DevKeyManager('test'), 'kms/clinical'),
    relayOutbox: () => Promise.resolve(),
    now: () => new Date('2026-11-16T10:00:00Z'),
    consents,
    integrations: {
      integrations,
      episodes: {
        listForPatient: () => Promise.resolve([]),
        listCheckIns: () => Promise.resolve([]),
        listRedFlags: () => Promise.resolve([]),
      } as unknown as EpisodeStore,
      reviews: {
        decisions: async () => [
          {
            id: decision,
            episodeId: randomUUID(),
            decision: 'continue',
            noteEncrypted: await cipher.encrypt(NOTE, {
              patientId: PATIENT,
              field: 'review_decision.note',
              recordId: decision,
            }),
            nextEpisodeId: randomUUID(),
            addedEpisodeId: null,
            decidedAt: new Date(),
          },
        ],
        surgeryChecks: () => Promise.resolve([]),
      } as unknown as ReviewStore,
      links: { ids: () => Promise.resolve([]) } as unknown as ShareLinkStore,
      audit: store,
      content,
      cipherFor: () => cipher,
    },
  });
  const signer = new ServiceTokenSigner(keys.privateJwk, 'bff-clinic');
  const admin = async (method: 'GET' | 'POST', url: string, payload?: object) =>
    app.inject({
      method,
      url,
      headers: {
        authorization: `Bearer ${await signer.sign({ sub: ADMIN_REF, role: 'org_admin', org_id: ORG, patient_id: null }, 'api')}`,
      },
      ...(payload ? { payload } : {}),
    });
  const w = new WorkloadTokenSigner(workload.privateJwk, 'integration');
  const internal = async (url: string, scope: string, payload: object) =>
    app.inject({
      method: 'POST',
      url,
      headers: { authorization: `Bearer ${await w.sign([scope], 'api')}` },
      payload,
    });
  return { admin, internal, integrations, store };
}

describe('M7 integration clients (spec 16.3, RISK-E02)', () => {
  it('accepts public ES384 or RS384 keys only', () => {
    expect(validJwks({ keys: [KEY] })).toBe(true);
    expect(validJwks({ keys: [{ kty: 'RSA', n: 'n', e: 'AQAB', alg: 'RS384', kid: 'r' }] })).toBe(
      true,
    );
    expect(validJwks({ keys: [{ ...KEY, d: 'private' }] })).toBe(false);
    expect(validJwks({ keys: [{ ...KEY, alg: 'ES256' }] })).toBe(false);
    expect(validJwks({ keys: [{ ...KEY, kid: undefined }] })).toBe(false);
    expect(validJwks({ keys: [{ kty: 'oct', k: 'secret', kid: 'x' }] })).toBe(false);
    expect(validJwks({ keys: [] })).toBe(false);
    expect(validJwks(null)).toBe(false);
    expect(validJwks({ keys: ['x'] })).toBe(false);
  });

  it('lets the org admin register a client, list it and switch it off', async () => {
    const { admin, integrations } = await setup();
    const made = await admin('POST', '/v1/org/integrations', {
      name: 'Synthetic record system',
      jwks: { keys: [KEY] },
      scopes: ['system/Patient.rs', 'system/CarePlan.rs'],
    });
    expect(made.statusCode).toBe(201);
    const { id, client_id } = made.json<{ id: string; client_id: string }>();
    expect(client_id).toMatch(/^[A-Za-z0-9_-]{24}$/);
    expect((await admin('GET', '/v1/org/integrations')).json()).toMatchObject({
      integrations: [{ id, active: true }],
    });
    expect(
      (await admin('POST', `/v1/org/integrations/${id}/active`, { active: false })).json(),
    ).toEqual({ id, active: false });
    expect(integrations.rows[0]?.active).toBe(false);
    expect(
      (await admin('POST', `/v1/org/integrations/${randomUUID()}/active`, { active: false }))
        .statusCode,
    ).toBe(404);
    expect(
      (
        await admin('POST', '/v1/org/integrations', {
          name: 'x',
          jwks: { keys: [{ ...KEY, d: 'secret' }] },
          scopes: ['system/Patient.rs'],
        })
      ).statusCode,
    ).toBe(422);
    expect(
      (
        await admin('POST', '/v1/org/integrations', {
          name: 'x',
          jwks: { keys: [KEY] },
          scopes: ['system/Patient.cruds'],
        })
      ).statusCode,
    ).toBe(400);
  });
});

describe('M7 the integration service reads through the API (spec 9.3, 16.4)', () => {
  it('resolves clients and gives a consented patient without notes, audited in her access log', async () => {
    const { admin, internal, store } = await setup();
    const { client_id, id } = (
      await admin('POST', '/v1/org/integrations', {
        name: 'Synthetic record system',
        jwks: { keys: [KEY] },
        scopes: ['system/Patient.rs'],
      })
    ).json<{ client_id: string; id: string }>();
    const resolved = await internal(
      '/internal/v1/integration/clients/resolve',
      'api.integration.resolve',
      {
        client_id,
      },
    );
    expect(resolved.json()).toMatchObject({ org_id: ORG, active: true, jwks: { keys: [KEY] } });
    expect(
      (
        await internal('/internal/v1/integration/clients/resolve', 'api.integration.resolve', {
          client_id: 'n'.repeat(24),
        })
      ).statusCode,
    ).toBe(404);
    const reserve = () =>
      internal('/internal/v1/integration/assertions/reserve', 'api.integration.resolve', {
        client_id,
        jti: 'j1',
        expires_at: '2026-11-16T10:04:00Z',
      });
    expect((await reserve()).json()).toEqual({ first_use: true });
    expect((await reserve()).json()).toEqual({ first_use: false });
    const read = (patient_id: string, org_id = ORG) =>
      internal('/internal/v1/fhir/patient', 'api.fhir.read', { org_id, patient_id, client_id });
    const res = await read(PATIENT);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ resourceType: 'Bundle' });
    expect(res.body).not.toContain(NOTE); // clinicians' notes stay inside
    expect(res.body).not.toContain('"AuditEvent"');
    const events = await store.readRange(1, 100);
    expect(events).toContainEqual(
      expect.objectContaining({
        action: 'fhir.patient.read',
        resource: { type: 'patient_record', id: PATIENT },
      }),
    );
    // Not sharing with the care team, another organisation, or a switched-off client: nothing.
    expect((await read(OTHER)).statusCode).toBe(404);
    expect((await read(PATIENT, randomUUID())).statusCode).toBe(403);
    await admin('POST', `/v1/org/integrations/${id}/active`, { active: false });
    expect((await read(PATIENT)).statusCode).toBe(403);
    // A scope it was not given.
    expect(
      (
        await internal('/internal/v1/fhir/patient', 'api.integration.resolve', {
          org_id: ORG,
          patient_id: PATIENT,
          client_id,
        })
      ).statusCode,
    ).toBe(403);
  });
});

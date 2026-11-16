import { describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { AuditWriter, InMemoryAuditStore } from '@endo/audit';
import {
  InMemoryConsentStore,
  InMemoryIdempotentInvitationStore,
  InMemoryMembershipStore,
  type EhrLinkStore,
} from '@endo/clinical-store';
import { DevKeyManager, EnvelopeSealer } from '@endo/crypto';
import {
  ServiceTokenSigner,
  ServiceTokenVerifier,
  generateServiceKeyPair,
} from '@endo/service-kit';
import { buildApi } from './app.ts';

const ORG = '01900000-0000-7000-8000-00000000000a';
const PATIENT = '01900000-0000-7000-8000-0000000000a1';
const NO_CONSENT = '01900000-0000-7000-8000-0000000000a2';
const REF = randomUUID();
const HASH = 'a'.repeat(64);

async function setup() {
  const keys = await generateServiceKeyPair();
  const links = new Map<string, string>();
  const ehrLinks: EhrLinkStore = {
    resolve: (_o, h) => Promise.resolve(links.get(h) ?? null),
    link: (l) => {
      if (links.has(l.linkHash)) return Promise.resolve('exists' as const);
      links.set(l.linkHash, l.patientId);
      return Promise.resolve('linked' as const);
    },
  };
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
    logLevel: 'silent',
    verifier: new ServiceTokenVerifier('api', {
      'bff-clinic': { publicJwk: keys.publicJwk, roles: ['clinician', 'org_admin'] },
    }),
    audit: new AuditWriter(new InMemoryAuditStore()),
    invitations: new InMemoryIdempotentInvitationStore(),
    memberships: new InMemoryMembershipStore().add(ORG, REF, {
      clinicianId: randomUUID(),
      role: 'clinician',
      active: true,
    }),
    sealer: new EnvelopeSealer(new DevKeyManager('test'), 'kms/clinical'),
    relayOutbox: () => Promise.resolve(),
    now: () => new Date(),
    consents,
    ehrLinks: { ehrLinks },
  });
  const signer = new ServiceTokenSigner(keys.privateJwk, 'bff-clinic');
  const post = async (url: string, payload: object) =>
    app.inject({
      method: 'POST',
      url,
      headers: {
        authorization: `Bearer ${await signer.sign({ sub: REF, role: 'clinician', org_id: ORG, patient_id: null }, 'api')}`,
      },
      payload,
    });
  return { post };
}

describe('M7 SMART launch patient links (spec 16.2)', () => {
  it('links once with her care-team consent, then resolves; by hash only', async () => {
    const { post } = await setup();
    expect((await post('/v1/ehr-links/resolve', { link_hash: HASH })).statusCode).toBe(404);
    expect(
      (await post(`/v1/patients/${NO_CONSENT}/ehr-links`, { link_hash: HASH })).statusCode,
    ).toBe(403);
    expect((await post(`/v1/patients/${PATIENT}/ehr-links`, { link_hash: HASH })).statusCode).toBe(
      201,
    );
    expect((await post(`/v1/patients/${PATIENT}/ehr-links`, { link_hash: HASH })).statusCode).toBe(
      409,
    );
    expect((await post('/v1/ehr-links/resolve', { link_hash: HASH })).json()).toEqual({
      patient_id: PATIENT,
    });
    expect((await post('/v1/ehr-links/resolve', { link_hash: 'MRN-12345' })).statusCode).toBe(400);
  });
});

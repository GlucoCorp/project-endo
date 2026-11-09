import { describe, expect, it } from 'vitest';
import { AuditWriter, InMemoryAuditStore } from '@endo/audit';
import {
  InMemoryConsentStore,
  InMemoryIdempotentInvitationStore,
  InMemoryMembershipStore,
} from '@endo/clinical-store';
import { DevKeyManager, EnvelopeSealer } from '@endo/crypto';
import {
  ServiceTokenSigner,
  ServiceTokenVerifier,
  generateServiceKeyPair,
  type ServiceClaims,
} from '@endo/service-kit';
import { buildApi } from './app.ts';
import { CONSENT_VERSIONS } from './routes/consents.ts';

const ORG = '01900000-0000-7000-8000-00000000000a';
const PATIENT = '01900000-0000-7000-8000-0000000000a1';
const HER: ServiceClaims = {
  sub: '01900000-0000-7000-8000-0000000000e9',
  role: 'patient',
  org_id: ORG,
  patient_id: PATIENT,
};
const SYNTHETIC_PHI_MARKER = 'SYNTHETIC_PHI_MARKER-consent-77aa';

async function setup() {
  const keys = await generateServiceKeyPair();
  const consents = new InMemoryConsentStore();
  const audit = new InMemoryAuditStore();
  const app = await buildApi({
    logLevel: 'info',
    verifier: new ServiceTokenVerifier('api', {
      'bff-patient': { publicJwk: keys.publicJwk, roles: ['patient'] },
    }),
    audit: new AuditWriter(audit),
    invitations: new InMemoryIdempotentInvitationStore(),
    memberships: new InMemoryMembershipStore(),
    consents,
    sealer: new EnvelopeSealer(new DevKeyManager('test'), 'kms/clinical'),
    now: () => new Date(),
  });
  const signer = new ServiceTokenSigner(keys.privateJwk, 'bff-patient');
  const auth = async (claims: ServiceClaims = HER) => ({
    authorization: `Bearer ${await signer.sign(claims, 'api')}`,
  });
  const put = async (purpose: string, payload: object, claims?: ServiceClaims) =>
    app.inject({
      method: 'PUT',
      url: `/v1/me/consents/${purpose}`,
      headers: await auth(claims),
      payload,
    });
  const get = async (claims?: ServiceClaims) =>
    app.inject({ url: '/v1/me/consents', headers: await auth(claims) });
  return { app, consents, audit, put, get };
}

describe('spec 13.1 GET/PUT /v1/me/consents', () => {
  it('lists every purpose with its current version, undecided ones as null', async () => {
    const { get } = await setup();
    const res = await get();
    expect(res.statusCode).toBe(200);
    expect(res.json<{ consents: unknown[] }>().consents).toEqual([
      {
        purpose: 'self_tracking',
        current_version: 1,
        status: null,
        version: null,
        decided_at: null,
      },
      {
        purpose: 'share_with_care_team',
        current_version: 1,
        status: null,
        version: null,
        decided_at: null,
      },
      {
        purpose: 'research_deidentified',
        current_version: 1,
        status: null,
        version: null,
        decided_at: null,
      },
      {
        purpose: 'org_aggregate_reporting',
        current_version: 1,
        status: null,
        version: null,
        decided_at: null,
      },
    ]);
  });

  it('grants, then withdraws with immediate effect, queuing an audit event each time', async () => {
    const { put, get, consents } = await setup();
    const v = CONSENT_VERSIONS.share_with_care_team;
    expect(
      (await put('share_with_care_team', { status: 'granted', version: v })).json(),
    ).toMatchObject({
      status: 'granted',
      changed: true,
    });
    expect(
      (await put('share_with_care_team', { status: 'granted', version: v })).json(),
    ).toMatchObject({
      changed: false,
    });
    await put('share_with_care_team', { status: 'revoked', version: v });
    const after = (await get()).json<{ consents: { purpose: string; status: string }[] }>()
      .consents;
    expect(after.find((c) => c.purpose === 'share_with_care_team')?.status).toBe('revoked');
    expect(consents.outbox).toMatchObject([
      { action: 'consent.granted', resource: { type: 'consent', id: PATIENT }, org_id: ORG },
      { action: 'consent.revoked' },
    ]);
  });

  it('refuses a decision made on an outdated explanation', async () => {
    const { put } = await setup();
    const res = await put('research_deidentified', { status: 'granted', version: 99 });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({
      type: 'https://errors.glucorp.health/consent.version_stale',
    });
  });

  it('sends withdrawal of self_tracking to account deletion instead', async () => {
    const { put } = await setup();
    const res = await put('self_tracking', { status: 'revoked', version: 1 });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({
      type: 'https://errors.glucorp.health/consent.requires_deletion',
    });
  });

  it('rejects unknown purposes, statuses and fields, and never echoes input', async () => {
    const { put } = await setup();
    expect((await put('marketing', { status: 'granted', version: 1 })).statusCode).toBe(400);
    expect((await put('research_deidentified', { status: 'maybe', version: 1 })).statusCode).toBe(
      400,
    );
    const extra = await put('research_deidentified', {
      status: 'granted',
      version: 1,
      note: SYNTHETIC_PHI_MARKER,
    });
    expect(extra.statusCode).toBe(400);
    expect(extra.body).not.toContain(SYNTHETIC_PHI_MARKER);
  });

  it('is hers alone: a patient token without an organisation is refused', async () => {
    const { get, put } = await setup();
    const noOrg = { ...HER, org_id: null };
    expect((await get(noOrg)).statusCode).toBe(403);
    expect(
      (await put('research_deidentified', { status: 'granted', version: 1 }, noOrg)).statusCode,
    ).toBe(403);
  });
});

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
import {
  IdentityUnavailableError,
  type ConfirmOutcome,
  type ConfirmRequest,
  type IdentityEnrolment,
} from './identity-client.ts';

const ORG = '01900000-0000-7000-8000-00000000000a';
const OTHER_ORG = '01900000-0000-7000-8000-00000000000b';
const IDENTITY_REF = '01900000-0000-7000-8000-0000000000e1';
const CLINICIAN_ID = '01900000-0000-7000-8000-0000000000c1';
const INVITATION = '01900000-0000-7000-8000-0000000000d1';
const CLINICIAN: ServiceClaims = {
  sub: IDENTITY_REF,
  role: 'clinician',
  org_id: ORG,
  patient_id: null,
};

async function setup(answer: ConfirmOutcome | Error = { outcome: 'confirmed' }) {
  const clinicKeys = await generateServiceKeyPair();
  const audit = new InMemoryAuditStore();
  const invitations = new InMemoryIdempotentInvitationStore();
  const asked: ConfirmRequest[] = [];
  const identity: IdentityEnrolment = {
    confirm: (r) => {
      asked.push(r);
      return answer instanceof Error ? Promise.reject(answer) : Promise.resolve(answer);
    },
  };
  const app = await buildApi({
    logLevel: 'silent',
    verifier: new ServiceTokenVerifier('api', {
      'bff-clinic': { publicJwk: clinicKeys.publicJwk, roles: ['clinician', 'org_admin'] },
    }),
    audit: new AuditWriter(audit),
    invitations,
    memberships: new InMemoryMembershipStore()
      .add(ORG, IDENTITY_REF, { clinicianId: CLINICIAN_ID, role: 'clinician', active: true })
      .add(OTHER_ORG, IDENTITY_REF, { clinicianId: CLINICIAN_ID, role: 'org_admin', active: true }),
    sealer: new EnvelopeSealer(new DevKeyManager('test'), 'kms/clinical'),
    relayOutbox: () => Promise.resolve(),
    now: () => new Date(),
    consents: new InMemoryConsentStore(),
    identity,
  });
  const signer = new ServiceTokenSigner(clinicKeys.privateJwk, 'bff-clinic');
  const auth = async (claims: ServiceClaims = CLINICIAN) => ({
    authorization: `Bearer ${await signer.sign(claims, 'api')}`,
  });
  const confirm = async (payload: object, claims?: ServiceClaims, id = INVITATION) =>
    app.inject({
      method: 'POST',
      url: `/v1/enrolments/${id}/confirm`,
      headers: await auth(claims),
      payload,
    });
  return { app, audit, invitations, asked, auth, confirm };
}

const good = { code: '123456', identified: true, own_phone: true };

describe('REQ-001 ADR-0021 sections 2 and 3: the clinician lists invitations and confirms by code', () => {
  it('lists open invitations of the clinician organisation only, never tokens', async () => {
    const { app, auth, invitations } = await setup();
    invitations.invitations.push(
      {
        id: INVITATION,
        orgId: ORG,
        createdBy: CLINICIAN_ID,
        tokenHash: 'a'.repeat(64),
        expiresAt: new Date(Date.now() + 3_600_000),
      },
      {
        id: '01900000-0000-7000-8000-0000000000d2',
        orgId: OTHER_ORG,
        createdBy: CLINICIAN_ID,
        tokenHash: 'b'.repeat(64),
        expiresAt: new Date(Date.now() + 3_600_000),
      },
    );
    const res = await app.inject({ url: '/v1/enrolments', headers: await auth() });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ invitations: { id: string }[] }>();
    expect(body.invitations.map((i) => i.id)).toEqual([INVITATION]);
    expect(res.body).not.toContain('a'.repeat(64));
  });

  it('REQ-001 lists accepted invitations with only the sharing decision, own organisation only', async () => {
    const { app, auth, invitations } = await setup();
    const at = (min: number) => new Date(Date.now() - min * 60_000);
    const [early, late, other] = [at(9), at(5), at(1)];
    const id = (n: number) => `01900000-0000-7000-8000-0000000000e${String(n)}`;
    invitations.accepted.push(
      { id: id(1), orgId: ORG, acceptedAt: early, sharing: 'shared' },
      { id: id(2), orgId: ORG, acceptedAt: late, sharing: 'declined' },
      { id: id(3), orgId: OTHER_ORG, acceptedAt: other, sharing: 'declined' },
    );
    const res = await app.inject({ url: '/v1/enrolments', headers: await auth() });
    expect(res.statusCode).toBe(200);
    expect(res.json<{ accepted: unknown[] }>().accepted).toEqual([
      { id: id(2), accepted_at: late.toISOString(), sharing: 'declined' },
      { id: id(1), accepted_at: early.toISOString(), sharing: 'shared' },
    ]);
  });

  it('passes the code, the organisation and the clinician to identity, with the attestation', async () => {
    const { confirm, asked, audit } = await setup();
    const res = await confirm(good);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ outcome: 'confirmed' });
    expect(asked[0]).toMatchObject({
      orgId: ORG,
      invitationId: INVITATION,
      code: '123456',
      clinicianId: CLINICIAN_ID,
      attestation: { identified: true, ownPhone: true },
    });
    // The decision is audited; the code is not.
    const events = await audit.readRange(1, 20);
    expect(events.some((e) => e.action === 'enrolment.confirm' && e.outcome === 'success')).toBe(
      true,
    );
    expect(JSON.stringify(events)).not.toContain('123456');
  });

  it.each([
    [
      { outcome: 'wrong', remaining: 3 },
      { outcome: 'wrong', remaining: 3 },
    ],
    [
      { outcome: 'locked', lockedUntil: '2026-11-11T12:00:00.000Z' },
      { outcome: 'locked', locked_until: '2026-11-11T12:00:00.000Z' },
    ],
    [{ outcome: 'unavailable' }, { outcome: 'unavailable' }],
  ] as [ConfirmOutcome, object][])('reports %o', async (answer, body) => {
    const { confirm } = await setup(answer);
    expect((await confirm(good)).json()).toEqual(body);
  });

  it('refuses without the attestation, with a malformed code, or for a patient caller', async () => {
    const { confirm, asked } = await setup();
    expect((await confirm({ ...good, identified: false })).statusCode).toBe(400);
    expect((await confirm({ code: '123456', identified: true })).statusCode).toBe(400);
    expect((await confirm({ ...good, code: '12345' })).statusCode).toBe(400);
    expect((await confirm(good, undefined, 'not-a-uuid')).statusCode).toBe(400);
    // org_admin is not a clinician (the matrix allows confirm to clinicians only).
    expect(
      (await confirm(good, { ...CLINICIAN, role: 'org_admin', org_id: OTHER_ORG })).statusCode,
    ).toBe(403);
    expect(asked).toHaveLength(0);
  });

  it('fails closed when identity is unavailable', async () => {
    const { confirm } = await setup(new IdentityUnavailableError());
    expect((await confirm(good)).statusCode).toBe(503);
  });
});

import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { AuditWriter, InMemoryAuditStore } from '@endo/audit';
import { randomUUID } from 'node:crypto';
import {
  InMemoryIdempotentInvitationStore,
  InMemoryMembershipStore,
  type ClinicianMembership,
} from '@endo/clinical-store';
import { DevKeyManager, EnvelopeSealer } from '@endo/crypto';
import {
  ServiceTokenSigner,
  ServiceTokenVerifier,
  generateServiceKeyPair,
  type ServiceClaims,
} from '@endo/service-kit';
import { buildApi } from './app.ts';

const ORG = '01900000-0000-7000-8000-00000000000a';
const IDENTITY_REF = '01900000-0000-7000-8000-0000000000e1'; // what the token carries
const CLINICIAN_ID = '01900000-0000-7000-8000-0000000000c1'; // clinical-store id, different
const CLINICIAN: ServiceClaims = {
  sub: IDENTITY_REF,
  role: 'clinician',
  org_id: ORG,
  patient_id: null,
};
const NOW = new Date('2026-11-08T10:00:00Z');
const WEEK_MS = 7 * 24 * 3600 * 1000;

async function setup(
  membership: ClinicianMembership = { clinicianId: CLINICIAN_ID, role: 'clinician', active: true },
) {
  const keys = await generateServiceKeyPair(); // patient BFF
  const clinicKeys = await generateServiceKeyPair(); // clinic BFF: its own key
  const audit = new InMemoryAuditStore();
  const invitations = new InMemoryIdempotentInvitationStore(() => NOW);
  const memberships = new InMemoryMembershipStore().add(ORG, IDENTITY_REF, membership);
  const logs: string[] = [];
  const app = await buildApi({
    logLevel: 'info',
    verifier: new ServiceTokenVerifier('api', {
      'bff-patient': { publicJwk: keys.publicJwk, roles: ['patient'] },
      'bff-clinic': {
        publicJwk: clinicKeys.publicJwk,
        roles: ['clinician', 'org_admin', 'glucorp_support'],
      },
    }),
    audit: new AuditWriter(audit),
    invitations,
    memberships,
    sealer: new EnvelopeSealer(new DevKeyManager('test'), 'kms/clinical'),
    relayOutbox: () => Promise.resolve(),
    now: () => NOW,
    loadConsents: () => Promise.resolve(new Set()),
    logStream: { write: (l) => logs.push(l) },
  });
  const clinicBff = new ServiceTokenSigner(clinicKeys.privateJwk, 'bff-clinic');
  const patientBff = new ServiceTokenSigner(keys.privateJwk, 'bff-patient');
  const post = async (
    claims: ServiceClaims | null,
    opts: {
      signer?: ServiceTokenSigner;
      payload?: unknown;
      url?: string;
      key?: string | null;
    } = {},
  ) =>
    app.inject({
      method: 'POST',
      url: opts.url ?? '/v1/enrolments',
      headers: {
        ...(claims
          ? { authorization: `Bearer ${await (opts.signer ?? clinicBff).sign(claims, 'api')}` }
          : {}),
        ...(opts.key === null ? {} : { 'idempotency-key': opts.key ?? randomUUID() }),
      },
      ...(opts.payload === undefined ? {} : { payload: opts.payload as object }),
    });
  return { post, patientBff, invitations, audit, logs };
}

describe('REQ-001 POST /v1/enrolments (clinician creates an invitation)', () => {
  it('returns a one-time token, stores only its hash, and records the clinical id as creator', async () => {
    const { post, invitations } = await setup();
    const res = await post(CLINICIAN);
    expect(res.statusCode).toBe(201);
    expect(res.headers['cache-control']).toBe('no-store');
    const body = res.json<{ id: string; token: string; expires_at: string }>();
    expect(body.token).toMatch(/^[A-Za-z0-9_-]{43}$/); // 256 bits, base64url
    expect(new Date(body.expires_at).getTime() - NOW.getTime()).toBe(WEEK_MS);

    const [stored] = invitations.invitations;
    expect(stored).toMatchObject({ id: body.id, orgId: ORG, createdBy: CLINICIAN_ID });
    expect(stored?.tokenHash).toBe(createHash('sha256').update(body.token).digest('hex'));
    expect(JSON.stringify(stored)).not.toContain(body.token);
  });

  it('accepts an empty JSON body but rejects any input fields', async () => {
    const { post, invitations } = await setup();
    expect((await post(CLINICIAN, { payload: {} })).statusCode).toBe(201);
    expect((await post(CLINICIAN, { payload: { org_id: 'x' } })).statusCode).toBe(400);
    expect((await post(CLINICIAN, { url: '/v1/enrolments?org_id=x' })).statusCode).toBe(400);
    expect(invitations.invitations).toHaveLength(1);
  });

  it('spec 9.1 replays the original response for a retried Idempotency-Key, creating nothing new', async () => {
    const { post, invitations } = await setup();
    const key = randomUUID();
    const first = await post(CLINICIAN, { key });
    const retry = await post(CLINICIAN, { key });
    expect(retry.statusCode).toBe(201);
    expect(retry.json()).toEqual(first.json());
    expect(invitations.invitations).toHaveLength(1);
    expect(invitations.outbox).toHaveLength(1);
  });

  it('requires a UUID Idempotency-Key', async () => {
    const { post, invitations } = await setup();
    expect((await post(CLINICIAN, { key: null })).statusCode).toBe(400);
    expect((await post(CLINICIAN, { key: 'not-a-uuid' })).statusCode).toBe(400);
    expect(invitations.invitations).toHaveLength(0);
  });

  it('spec 2.6 queues a creation audit event with the invitation id, in the same step', async () => {
    const { post, invitations } = await setup();
    const res = await post(CLINICIAN);
    const id = res.json<{ id: string }>().id;
    expect(invitations.outbox).toMatchObject([
      {
        action: 'enrolment.created',
        outcome: 'success',
        org_id: ORG,
        resource: { type: 'enrolment_invitation', id },
        actor: { id: IDENTITY_REF, role: 'clinician' },
      },
    ]);
    expect(JSON.stringify(invitations.outbox)).not.toContain(res.json<{ token: string }>().token);
  });

  it('issues a different token every time', async () => {
    const { post } = await setup();
    const a = (await post(CLINICIAN)).json<{ token: string }>().token;
    const b = (await post(CLINICIAN)).json<{ token: string }>().token;
    expect(a).not.toBe(b);
  });

  it.each([
    ['inactive', { clinicianId: CLINICIAN_ID, role: 'clinician', active: false }],
    ['now an org admin', { clinicianId: CLINICIAN_ID, role: 'org_admin', active: true }],
  ] as const)('refuses a clinician whose membership is %s, and audits it', async (_n, m) => {
    const { post, invitations, audit } = await setup(m);
    expect((await post(CLINICIAN)).statusCode).toBe(403);
    expect(invitations.invitations).toHaveLength(0);
    expect(await audit.readRange(1, 10)).toMatchObject([
      { outcome: 'denied', reason: 'authz.inactive_subject' },
    ]);
  });

  it.each([
    [
      'clinician of another organisation',
      { ...CLINICIAN, org_id: '01900000-0000-7000-8000-00000000000b' },
    ],
    ['clinician without an organisation', { ...CLINICIAN, org_id: null }],
    ['org_admin', { ...CLINICIAN, role: 'org_admin' }],
    ['glucorp_support', { ...CLINICIAN, role: 'glucorp_support', org_id: null }],
  ] as const)('refuses a %s and stores nothing', async (_name, claims) => {
    const { post, invitations } = await setup();
    expect((await post(claims)).statusCode).toBe(403);
    expect(invitations.invitations).toHaveLength(0);
  });

  it('RISK-S03 refuses clinician claims vouched for by the patient BFF', async () => {
    const { post, patientBff, invitations } = await setup();
    expect((await post(CLINICIAN, { signer: patientBff })).statusCode).toBe(401);
    expect(invitations.invitations).toHaveLength(0);
  });

  it('refuses an unauthenticated caller', async () => {
    const { post, invitations } = await setup();
    expect((await post(null)).statusCode).toBe(401);
    expect(invitations.invitations).toHaveLength(0);
  });

  it('audits the decision without the token, and never logs the token', async () => {
    const { post, audit, logs } = await setup();
    const token = (await post(CLINICIAN)).json<{ token: string }>().token;
    const events = await audit.readRange(1, 10);
    expect(events).toMatchObject([{ action: 'enrolment.create', outcome: 'success', org_id: ORG }]);
    expect(JSON.stringify(events)).not.toContain(token);
    expect(logs.join('\n')).not.toContain(token);
  });
});

import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { AuditWriter, InMemoryAuditStore } from '@endo/audit';
import {
  InMemoryConsentStore,
  InMemoryIdempotentInvitationStore,
  InMemoryMembershipStore,
  type InvitationState,
  type ReservationRequest,
} from '@endo/clinical-store';
import { DevKeyManager, EnvelopeSealer } from '@endo/crypto';
import {
  ServiceTokenVerifier,
  WorkloadTokenSigner,
  WorkloadTokenVerifier,
  generateServiceKeyPair,
} from '@endo/service-kit';
import { buildApi, type ApiDeps } from './app.ts';
import type { EnrolmentCoordination } from './routes/coordinator.ts';

const ORG = '01900000-0000-7000-8000-00000000000a';
const INVITATION = '01900000-0000-7000-8000-0000000000c1';
const TX = '01900000-0000-7000-8000-0000000000d1';
const PATIENT = '01900000-0000-7000-8000-0000000000e1';
// The marker stands in for a link token: neither it nor its hash may reach logs or audit.
const TOKEN = 'SYNTHETIC_PHI_MARKER-link-token';
const HASH = createHash('sha256').update(TOKEN).digest('hex');

async function setup(coordination: EnrolmentCoordination | null = fake()) {
  const identity = await generateServiceKeyPair();
  const clinic = await generateServiceKeyPair();
  const patient = await generateServiceKeyPair();
  const audit = new InMemoryAuditStore();
  const logs: string[] = [];
  const deps: ApiDeps = {
    logLevel: 'info',
    verifier: new ServiceTokenVerifier('api', {
      'bff-patient': { publicJwk: patient.publicJwk, roles: ['patient'] },
    }),
    workloadVerifier: new WorkloadTokenVerifier('api', {
      identity: { publicJwk: identity.publicJwk, scopes: ['api.enrolment.coordinate'] },
      'bff-clinic': { publicJwk: clinic.publicJwk, scopes: ['api.membership.resolve'] },
    }),
    audit: new AuditWriter(audit),
    invitations: new InMemoryIdempotentInvitationStore(),
    memberships: new InMemoryMembershipStore(),
    sealer: new EnvelopeSealer(new DevKeyManager('test'), 'kms/clinical'),
    now: () => new Date(),
    consents: new InMemoryConsentStore(),
    logStream: { write: (m: string) => logs.push(m) },
    ...(coordination ? { coordination } : {}),
  };
  const app = await buildApi(deps);
  const bearer = async (key: typeof identity, who: 'identity' | 'bff-clinic', scope: string) => ({
    authorization: `Bearer ${await new WorkloadTokenSigner(key.privateJwk, who).sign([scope], 'api')}`,
  });
  const asIdentity = () => bearer(identity, 'identity', 'api.enrolment.coordinate');
  const post = async (url: string, payload: object, headers?: Record<string, string>) =>
    app.inject({
      method: 'POST',
      url: `/internal/v1/enrolment/invitations/${url}`,
      headers: headers ?? (await asIdentity()),
      payload,
    });
  return {
    app,
    audit,
    logs,
    post,
    asClinic: () => bearer(clinic, 'bff-clinic', 'api.membership.resolve'),
  };
}

const reservations: (ReservationRequest & { op: string })[] = [];

function fake(
  state: InvitationState = { status: 'live', reservedBy: null },
): EnrolmentCoordination {
  return {
    find: (h) =>
      Promise.resolve(
        h === HASH ? { invitationId: INVITATION, orgId: ORG, reserved: false } : null,
      ),
    state: (o, i) => Promise.resolve(o === ORG && i === INVITATION ? state : { status: 'missing' }),
    reserve: (r) => {
      reservations.push({ op: 'reserve', ...r });
      return Promise.resolve(
        r.invitationId === INVITATION
          ? {
              outcome: 'done',
              changed: true,
              state: { status: 'live', reservedBy: r.transactionId },
            }
          : { outcome: 'refused', state: { status: 'revoked', reservedBy: null } },
      );
    },
    release: (r) => {
      reservations.push({ op: 'release', ...r });
      return Promise.resolve({
        outcome: 'done',
        changed: false,
        state: { status: 'live', reservedBy: null },
      });
    },
  };
}

describe('REQ-001 ADR-0021 section 13: API coordinator routes (identity service only)', () => {
  it('finds a live invitation by its token hash, and never records the hash', async () => {
    const { post, audit, logs } = await setup();
    const res = await post('find', { token_hash: HASH });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ invitation_id: INVITATION, org_id: ORG, reserved: false });
    const events = await audit.readRange(1, 10);
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ action: 'api.enrolment.invitation.find', outcome: 'success' }),
        expect.objectContaining({
          action: 'api.enrolment.invitation.found',
          resource: { type: 'enrolment_invitation', id: INVITATION },
        }),
      ]),
    );
    const recorded = JSON.stringify(events) + logs.join('');
    expect(recorded).not.toContain(HASH);
    expect(recorded).not.toContain('SYNTHETIC_PHI_MARKER');
  });

  it('answers 404 alike for any link that is not live', async () => {
    const { post, audit } = await setup();
    const res = await post('find', { token_hash: 'a'.repeat(64) });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({
      type: 'https://errors.glucorp.health/enrolment.link_invalid',
    });
    expect(await audit.readRange(1, 10)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          action: 'api.enrolment.invitation.found',
          resource: { type: 'enrolment_invitation', id: null },
        }),
      ]),
    );
  });

  it.each([
    [
      { status: 'live', reservedBy: null },
      { status: 'live', reserved_by: null },
    ],
    [
      { status: 'live', reservedBy: TX },
      { status: 'live', reserved_by: TX },
    ],
    [
      { status: 'revoked', reservedBy: TX },
      { status: 'revoked', reserved_by: TX },
    ],
    [
      { status: 'claimed', reservedBy: TX, patientId: PATIENT },
      { status: 'claimed', reserved_by: TX, patient_id: PATIENT },
    ],
  ] as [InvitationState, object][])('reports the invitation state %#', async (state, body) => {
    const { post } = await setup(fake(state));
    const res = await post('state', { org_id: ORG, invitation_id: INVITATION });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual(body);
  });

  it('reports a missing invitation, including one in another organisation', async () => {
    const { post } = await setup();
    const other = '01900000-0000-7000-8000-00000000000b';
    const res = await post('state', { org_id: other, invitation_id: INVITATION });
    expect(res.json()).toEqual({ status: 'missing' });
  });

  it('refuses every caller but the identity service with its scope', async () => {
    const { post, asClinic, audit } = await setup();
    expect((await post('find', { token_hash: HASH }, {})).statusCode).toBe(401);
    expect((await post('find', { token_hash: HASH }, await asClinic())).statusCode).toBe(403);
    expect(
      (await post('state', { org_id: ORG, invitation_id: INVITATION }, await asClinic()))
        .statusCode,
    ).toBe(403);
    const denied = (await audit.readRange(1, 10)).filter((e) => e.outcome === 'denied');
    expect(denied.length).toBeGreaterThanOrEqual(3);
    expect(
      (await audit.readRange(1, 10)).some((e) => e.action === 'api.enrolment.invitation.found'),
    ).toBe(false);
  });

  it('rejects malformed bodies without echoing them anywhere', async () => {
    const { post, audit, logs } = await setup();
    const bad = await post('find', { token_hash: TOKEN });
    expect(bad.statusCode).toBe(400);
    const extra = await post('find', { token_hash: HASH, extra: 1 });
    expect(extra.statusCode).toBe(400);
    expect((await post('state', { org_id: 'x', invitation_id: INVITATION })).statusCode).toBe(400);
    const recorded =
      bad.body + extra.body + JSON.stringify(await audit.readRange(1, 50)) + logs.join('');
    expect(recorded).not.toContain('SYNTHETIC_PHI_MARKER');
    expect(recorded).not.toContain(HASH);
  });

  it('keeps the hash out of responses, logs and audit when the store fails', async () => {
    const failing: EnrolmentCoordination = {
      find: () => Promise.reject(new Error(`store failed for ${HASH} SYNTHETIC_PHI_MARKER`)),
      state: () => Promise.reject(new Error('store failed SYNTHETIC_PHI_MARKER')),
      reserve: () => Promise.reject(new Error('unused')),
      release: () => Promise.reject(new Error('unused')),
    };
    const { post, audit, logs } = await setup(failing);
    const res = await post('find', { token_hash: HASH });
    expect(res.statusCode).toBe(500);
    const state = await post('state', { org_id: ORG, invitation_id: INVITATION });
    expect(state.statusCode).toBe(500);
    const recorded =
      res.body + state.body + JSON.stringify(await audit.readRange(1, 50)) + logs.join('');
    expect(recorded).not.toContain('SYNTHETIC_PHI_MARKER');
    expect(recorded).not.toContain(HASH);
    // The failure itself is audited, as an error with a safe code.
    expect(await audit.readRange(1, 50)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ action: 'api.enrolment.invitation.find', outcome: 'error' }),
      ]),
    );
  });

  it('does not exist without a clinical store (fail closed)', async () => {
    const { post } = await setup(null);
    expect((await post('find', { token_hash: HASH })).statusCode).toBe(404);
  });

  it('reserves and releases for a transaction, queuing the audit event with the change', async () => {
    const { post } = await setup();
    reservations.length = 0;
    const body = { org_id: ORG, invitation_id: INVITATION, transaction_id: TX };
    const reserved = await post('reserve', body);
    expect(reserved.statusCode).toBe(200);
    expect(reserved.json()).toEqual({
      outcome: 'done',
      changed: true,
      state: { status: 'live', reserved_by: TX },
    });
    const refused = await post('reserve', { ...body, invitation_id: PATIENT });
    expect(refused.json()).toEqual({
      outcome: 'refused',
      state: { status: 'revoked', reserved_by: null },
    });
    expect((await post('release', body)).json()).toMatchObject({ outcome: 'done', changed: false });
    expect(reservations.map((r) => r.op)).toEqual(['reserve', 'reserve', 'release']);
    expect(reservations[0]).toMatchObject({
      orgId: ORG,
      invitationId: INVITATION,
      transactionId: TX,
      auditEvent: {
        action: 'api.enrolment.invitation.reserved',
        resource: { type: 'enrolment_invitation', id: INVITATION },
        org_id: ORG,
      },
    });
  });

  it('refuses reserve and release to any other caller', async () => {
    const { post, asClinic } = await setup();
    const body = { org_id: ORG, invitation_id: INVITATION, transaction_id: TX };
    expect((await post('reserve', body, {})).statusCode).toBe(401);
    expect((await post('release', body, await asClinic())).statusCode).toBe(403);
    expect((await post('reserve', { ...body, transaction_id: 'x' })).statusCode).toBe(400);
  });
});

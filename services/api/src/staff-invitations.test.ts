import { describe, expect, it } from 'vitest';
import { createHash, randomUUID } from 'node:crypto';
import { AuditWriter, InMemoryAuditStore } from '@endo/audit';
import {
  InMemoryConsentStore,
  InMemoryIdempotentInvitationStore,
  InMemoryMembershipStore,
  type OrgAdminStore,
  type StaffInvitation,
  type StaffInvitationStore,
} from '@endo/clinical-store';
import { DevKeyManager, EnvelopeSealer } from '@endo/crypto';
import {
  ServiceTokenSigner,
  ServiceTokenVerifier,
  WorkloadTokenSigner,
  WorkloadTokenVerifier,
  generateServiceKeyPair,
} from '@endo/service-kit';
import { buildApi } from './app.ts';

const ORG = '01900000-0000-7000-8000-00000000000a';
const ADMIN_REF = randomUUID();
const ADMIN_ID = randomUUID();
const STALE_REF = randomUUID();

class FakeInvitations implements StaffInvitationStore {
  rows: (StaffInvitation & { hash: string })[] = [];
  members = new Set<string>();
  audits: unknown[] = [];
  create(i: Parameters<StaffInvitationStore['create']>[0]) {
    if (i.createdBy !== ADMIN_ID) return Promise.resolve('not_admin' as const);
    const row = {
      id: i.id,
      role: i.role,
      createdAt: new Date(),
      expiresAt: new Date(Date.now() + i.days * 86_400_000),
      claimedAt: null,
      revokedAt: null,
      hash: i.tokenHash,
    };
    this.rows.push(row);
    this.audits.push(i.auditEvent);
    return Promise.resolve(row);
  }
  list() {
    return Promise.resolve(this.rows);
  }
  revoke(_o: string, id: string, auditEvent: unknown) {
    const r = this.rows.find((x) => x.id === id && !x.claimedAt && !x.revokedAt);
    if (!r) return Promise.resolve(false);
    Object.assign(r, { revokedAt: new Date() });
    this.audits.push(auditEvent);
    return Promise.resolve(true);
  }
  claim(c: Parameters<StaffInvitationStore['claim']>[0]) {
    const r = this.rows.find((x) => x.hash === c.tokenHash && !x.claimedAt && !x.revokedAt);
    if (!r) return Promise.resolve({ outcome: 'unavailable' as const });
    if (this.members.has(c.identityRef))
      return Promise.resolve({ outcome: 'already_member' as const });
    Object.assign(r, { claimedAt: new Date() });
    this.members.add(c.identityRef);
    this.audits.push(c.auditEvent);
    return Promise.resolve({ outcome: 'claimed' as const, orgId: ORG, role: r.role });
  }
}

async function setup() {
  const keys = await generateServiceKeyPair();
  const workload = await generateServiceKeyPair();
  const staffInvitations = new FakeInvitations();
  const logs: string[] = [];
  const app = await buildApi({
    logLevel: 'info',
    logStream: { write: (l) => logs.push(l) },
    verifier: new ServiceTokenVerifier('api', {
      'bff-clinic': { publicJwk: keys.publicJwk, roles: ['clinician', 'org_admin'] },
    }),
    workloadVerifier: new WorkloadTokenVerifier('api', {
      'bff-clinic': { publicJwk: workload.publicJwk, scopes: ['api.staff.join'] },
    }),
    audit: new AuditWriter(new InMemoryAuditStore()),
    invitations: new InMemoryIdempotentInvitationStore(),
    memberships: new InMemoryMembershipStore()
      .add(ORG, ADMIN_REF, { clinicianId: ADMIN_ID, role: 'org_admin', active: true })
      // Still an admin when the request was authorised, not when the store writes.
      .add(ORG, STALE_REF, { clinicianId: randomUUID(), role: 'org_admin', active: true }),
    sealer: new EnvelopeSealer(new DevKeyManager('test'), 'kms/clinical'),
    relayOutbox: () => Promise.resolve(),
    now: () => new Date(),
    consents: new InMemoryConsentStore(),
    orgAdmin: { orgAdmin: {} as OrgAdminStore, staffInvitations },
  });
  const signer = new ServiceTokenSigner(keys.privateJwk, 'bff-clinic');
  const admin = async (method: 'GET' | 'POST', url: string, payload?: object, sub = ADMIN_REF) =>
    app.inject({
      method,
      url,
      headers: {
        authorization: `Bearer ${await signer.sign({ sub, role: 'org_admin', org_id: ORG, patient_id: null }, 'api')}`,
      },
      ...(payload ? { payload } : {}),
    });
  const claim = async (
    payload: object,
    w = new WorkloadTokenSigner(workload.privateJwk, 'bff-clinic'),
  ) =>
    app.inject({
      method: 'POST',
      url: '/internal/v1/staff-invitations/claim',
      headers: { authorization: `Bearer ${await w.sign(['api.staff.join'], 'api')}` },
      payload,
    });
  return { admin, claim, staffInvitations, logs };
}

describe('REQ-010 staff invitations', () => {
  it('returns the token once, stores its hash, and the clinic BFF claims it once', async () => {
    const { admin, claim, staffInvitations, logs } = await setup();
    const made = await admin('POST', '/v1/org/staff-invitations', { role: 'clinician' });
    expect(made.statusCode).toBe(201);
    expect(made.headers['cache-control']).toBe('no-store');
    const { id, token } = made.json<{ id: string; token: string }>();
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const hash = createHash('sha256').update(token).digest('hex');
    expect(staffInvitations.rows[0]?.hash).toBe(hash);
    expect(JSON.stringify(staffInvitations.rows)).not.toContain(token);
    expect(logs.join('\n')).not.toContain(token);
    const list = await admin('GET', '/v1/org/staff-invitations');
    expect(list.json()).toMatchObject({ invitations: [{ id, status: 'open', role: 'clinician' }] });
    expect(list.body).not.toContain(hash);

    const person = randomUUID();
    const ok = await claim({ token_hash: hash, person_id: person });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toEqual({ org_id: ORG, role: 'clinician' });
    expect((await claim({ token_hash: hash, person_id: randomUUID() })).statusCode).toBe(404);
    // Another invitation for someone already in the organisation.
    const t2 = (
      await admin('POST', '/v1/org/staff-invitations', { role: 'org_admin', days: 3 })
    ).json<{
      token: string;
    }>().token;
    const again = await claim({
      token_hash: createHash('sha256').update(t2).digest('hex'),
      person_id: person,
    });
    expect(again.statusCode).toBe(409);
    expect((await admin('GET', '/v1/org/staff-invitations')).json()).toMatchObject({
      invitations: [{ status: 'accepted' }, { status: 'open' }],
    });
    // A key without the scope cannot claim.
    const other = await generateServiceKeyPair();
    expect(
      (
        await claim(
          { token_hash: hash, person_id: person },
          new WorkloadTokenSigner(other.privateJwk, 'bff-clinic'),
        )
      ).statusCode,
    ).toBe(401);
  });

  it('refuses a maker who is no longer an active admin when the store writes', async () => {
    const { admin } = await setup();
    const res = await admin('POST', '/v1/org/staff-invitations', { role: 'org_admin' }, STALE_REF);
    expect(res.statusCode).toBe(403);
  });

  it('stops an open invitation once; refuses bad input', async () => {
    const { admin, staffInvitations } = await setup();
    const { id } = (await admin('POST', '/v1/org/staff-invitations', { role: 'clinician' })).json<{
      id: string;
    }>();
    expect((await admin('POST', `/v1/org/staff-invitations/${id}/revoke`)).statusCode).toBe(204);
    expect((await admin('POST', `/v1/org/staff-invitations/${id}/revoke`)).statusCode).toBe(404);
    expect(staffInvitations.audits).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ action: 'staff_invitation.created' }),
        expect.objectContaining({ action: 'staff_invitation.revoked' }),
      ]),
    );
    expect((await admin('POST', '/v1/org/staff-invitations', { role: 'owner' })).statusCode).toBe(
      400,
    );
    expect(
      (await admin('POST', '/v1/org/staff-invitations', { role: 'clinician', days: 30 }))
        .statusCode,
    ).toBe(400);
  });
});

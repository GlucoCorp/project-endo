import { describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { AuditWriter, InMemoryAuditStore } from '@endo/audit';
import {
  InMemoryConsentStore,
  InMemoryIdempotentInvitationStore,
  InMemoryMembershipStore,
  type MemberChangeOutcome,
  type OrgAdminStore,
  type OrgMember,
  type OrgSettings,
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
const ADMIN_REF = randomUUID();
const ADMIN_ID = randomUUID();
const CLIN_REF = randomUUID();
const CLIN_ID = randomUUID();

class FakeOrgAdmin implements OrgAdminStore {
  current: OrgSettings = {
    defaultReviewIntervalWeeks: null,
    languages: ['en'],
    emergencyNumber: null,
    updatedAt: null,
  };
  audits: unknown[] = [];
  rows: OrgMember[] = [
    {
      clinicianId: ADMIN_ID,
      identityRef: ADMIN_REF,
      role: 'org_admin',
      active: true,
      createdAt: new Date('2026-11-01T00:00:00Z'),
    },
    {
      clinicianId: CLIN_ID,
      identityRef: CLIN_REF,
      role: 'clinician',
      active: true,
      createdAt: new Date('2026-11-02T00:00:00Z'),
    },
  ];
  settings() {
    return Promise.resolve(this.current);
  }
  saveSettings(s: Parameters<OrgAdminStore['saveSettings']>[0]) {
    this.current = {
      defaultReviewIntervalWeeks: s.defaultReviewIntervalWeeks,
      languages: s.languages,
      emergencyNumber: s.emergencyNumber,
      updatedAt: new Date('2026-11-16T00:00:00Z'),
    };
    this.audits.push(s.auditEvent);
    return Promise.resolve(this.current);
  }
  members() {
    return Promise.resolve(this.rows);
  }
  force: MemberChangeOutcome | null = null;
  changeMember(c: Parameters<OrgAdminStore['changeMember']>[0]) {
    if (this.force) return Promise.resolve(this.force);
    const actor = this.rows.find((r) => r.clinicianId === c.actorId);
    if (!actor || actor.role !== 'org_admin' || !actor.active)
      return Promise.resolve('not_admin' as const);
    const m = this.rows.find((r) => r.clinicianId === c.clinicianId);
    if (!m) return Promise.resolve('not_found' as const);
    if (m.role === c.role && m.active === c.active) return Promise.resolve('unchanged' as const);
    const after = this.rows.map((r) =>
      r.clinicianId === c.clinicianId ? { ...r, role: c.role, active: c.active } : r,
    );
    if (!after.some((r) => r.role === 'org_admin' && r.active))
      return Promise.resolve('last_admin' as const);
    this.rows = after;
    this.audits.push(c.auditEvent);
    return Promise.resolve('changed' as const);
  }
}

async function setup() {
  const keys = await generateServiceKeyPair();
  const orgAdmin = new FakeOrgAdmin();
  const app = await buildApi({
    logLevel: 'silent',
    verifier: new ServiceTokenVerifier('api', {
      'bff-clinic': { publicJwk: keys.publicJwk, roles: ['clinician', 'org_admin'] },
    }),
    audit: new AuditWriter(new InMemoryAuditStore()),
    invitations: new InMemoryIdempotentInvitationStore(),
    memberships: new InMemoryMembershipStore()
      .add(ORG, ADMIN_REF, { clinicianId: ADMIN_ID, role: 'org_admin', active: true })
      .add(ORG, CLIN_REF, { clinicianId: CLIN_ID, role: 'clinician', active: true }),
    sealer: new EnvelopeSealer(new DevKeyManager('test'), 'kms/clinical'),
    relayOutbox: () => Promise.resolve(),
    now: () => new Date(),
    consents: new InMemoryConsentStore(),
    orgAdmin: { orgAdmin },
  });
  const signer = new ServiceTokenSigner(keys.privateJwk, 'bff-clinic');
  const as = (who: 'admin' | 'clinician' | 'other-org'): ServiceClaims =>
    who === 'admin'
      ? { sub: ADMIN_REF, role: 'org_admin', org_id: ORG, patient_id: null }
      : who === 'clinician'
        ? { sub: CLIN_REF, role: 'clinician', org_id: ORG, patient_id: null }
        : { sub: ADMIN_REF, role: 'org_admin', org_id: randomUUID(), patient_id: null };
  const call = async (
    method: 'GET' | 'POST',
    url: string,
    payload?: object,
    who: 'admin' | 'clinician' | 'other-org' = 'admin',
  ) =>
    app.inject({
      method,
      url,
      headers: { authorization: `Bearer ${await signer.sign(as(who), 'api')}` },
      ...(payload ? { payload } : {}),
    });
  return { call, orgAdmin };
}

const valid = {
  default_review_interval_weeks: 8,
  languages: ['en', 'sw'],
  emergency_number: '112',
};

describe('REQ-010 organisation settings', () => {
  it('lets the org admin read and set them, audited', async () => {
    const { call, orgAdmin } = await setup();
    expect((await call('GET', '/v1/org/settings')).json()).toMatchObject({
      languages: ['en'],
      emergency_number: null,
    });
    const res = await call('POST', '/v1/org/settings', valid);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ...valid, updated_at: '2026-11-16T00:00:00.000Z' });
    expect(orgAdmin.audits).toContainEqual(
      expect.objectContaining({ action: 'org.settings.updated' }),
    );
  });

  it('refuses bad values, clinicians and other organisations', async () => {
    const { call } = await setup();
    for (const body of [
      { ...valid, default_review_interval_weeks: 2 },
      { ...valid, languages: [] },
      { ...valid, languages: ['english'] },
      { ...valid, emergency_number: '+1 call me' },
      { ...valid, extra: true },
    ])
      expect((await call('POST', '/v1/org/settings', body)).statusCode).toBe(400);
    expect((await call('POST', '/v1/org/settings', valid, 'clinician')).statusCode).toBe(403);
    expect((await call('GET', '/v1/org/settings', undefined, 'clinician')).statusCode).toBe(403);
    expect((await call('GET', '/v1/org/settings', undefined, 'other-org')).statusCode).toBe(403);
  });
});

describe('REQ-010 her app uses her clinic settings', () => {
  it('gives her the emergency number and languages of her own organisation only', async () => {
    const keys = await generateServiceKeyPair();
    const orgAdmin = new FakeOrgAdmin();
    orgAdmin.current = { ...orgAdmin.current, emergencyNumber: '999', languages: ['en', 'sw'] };
    const PATIENT = randomUUID();
    const app = await buildApi({
      logLevel: 'silent',
      verifier: new ServiceTokenVerifier('api', {
        'bff-patient': { publicJwk: keys.publicJwk, roles: ['patient'] },
      }),
      audit: new AuditWriter(new InMemoryAuditStore()),
      invitations: new InMemoryIdempotentInvitationStore(),
      memberships: new InMemoryMembershipStore(),
      sealer: new EnvelopeSealer(new DevKeyManager('test'), 'kms/clinical'),
      relayOutbox: () => Promise.resolve(),
      now: () => new Date(),
      consents: new InMemoryConsentStore(),
      orgAdmin: { orgAdmin },
    });
    const signer = new ServiceTokenSigner(keys.privateJwk, 'bff-patient');
    const res = await app.inject({
      method: 'GET',
      url: '/v1/me/clinic-settings',
      headers: {
        authorization: `Bearer ${await signer.sign({ sub: randomUUID(), role: 'patient', org_id: ORG, patient_id: PATIENT }, 'api')}`,
      },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ emergency_number: '999', languages: ['en', 'sw'] });
  });
});

describe('REQ-010 managing clinicians', () => {
  it('lists members, deactivates and reactivates, never their own or the last admin', async () => {
    const { call, orgAdmin } = await setup();
    const list = (await call('GET', '/v1/org/clinicians')).json<{
      clinicians: { clinician_id: string; you: boolean }[];
    }>();
    expect(list.clinicians).toHaveLength(2);
    expect(list.clinicians.find((c) => c.you)?.clinician_id).toBe(ADMIN_ID);
    const url = `/v1/org/clinicians/${CLIN_ID}`;
    expect((await call('POST', url, { role: 'clinician', active: false })).json()).toEqual({
      clinician_id: CLIN_ID,
      role: 'clinician',
      active: false,
    });
    expect(orgAdmin.audits).toContainEqual(
      expect.objectContaining({ action: 'org.clinician.changed' }),
    );
    expect((await call('POST', url, { role: 'clinician', active: true })).statusCode).toBe(200);
    // Their own membership: refused.
    const own = await call('POST', `/v1/org/clinicians/${ADMIN_ID}`, {
      role: 'clinician',
      active: true,
    });
    expect(own.statusCode).toBe(409);
    expect(own.json<{ type: string }>().type).toContain('org.own_membership');
    // The last admin is protected: a concurrent change can leave none, and the store refuses.
    orgAdmin.force = 'last_admin';
    const last = await call('POST', url, { role: 'clinician', active: true });
    expect(last.statusCode).toBe(409);
    expect(last.json<{ type: string }>().type).toContain('org.last_admin');
    orgAdmin.force = null;
    // Removed while the request was in flight: the store re-checks the acting admin.
    orgAdmin.rows = orgAdmin.rows.map((r) =>
      r.clinicianId === ADMIN_ID ? { ...r, active: false } : r,
    );
    expect((await call('POST', url, { role: 'clinician', active: false })).statusCode).toBe(403);
    orgAdmin.rows = orgAdmin.rows.map((r) =>
      r.clinicianId === ADMIN_ID ? { ...r, active: true } : r,
    );
    expect(
      (
        await call('POST', `/v1/org/clinicians/${randomUUID()}`, {
          role: 'clinician',
          active: true,
        })
      ).statusCode,
    ).toBe(404);
    expect((await call('GET', '/v1/org/clinicians', undefined, 'clinician')).statusCode).toBe(403);
    expect((await call('POST', url, { role: 'superuser', active: true })).statusCode).toBe(400);
  });
});

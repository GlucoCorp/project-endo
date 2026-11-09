import { describe, expect, it } from 'vitest';
import { AuditWriter, InMemoryAuditStore } from '@endo/audit';
import { InMemoryIdempotentInvitationStore, InMemoryMembershipStore } from '@endo/clinical-store';
import { DevKeyManager, EnvelopeSealer } from '@endo/crypto';
import {
  ServiceTokenSigner,
  ServiceTokenVerifier,
  WorkloadTokenSigner,
  WorkloadTokenVerifier,
  generateServiceKeyPair,
} from '@endo/service-kit';
import { buildApi, type ApiDeps } from './app.ts';

const PERSON = '01900000-0000-7000-8000-0000000000e1';
const ORG_A = '01900000-0000-7000-8000-00000000000a';
const ORG_B = '01900000-0000-7000-8000-00000000000b';

async function setup(overrides: Partial<ApiDeps> = {}, withoutWorkload = false) {
  const clinic = await generateServiceKeyPair();
  const patient = await generateServiceKeyPair();
  const audit = new InMemoryAuditStore();
  const memberships = new InMemoryMembershipStore()
    .add(ORG_A, PERSON, { clinicianId: 'c1', role: 'clinician', active: true })
    .add(ORG_B, PERSON, { clinicianId: 'c2', role: 'org_admin', active: true });
  const base: ApiDeps = {
    logLevel: 'info',
    verifier: new ServiceTokenVerifier('api', {
      'bff-patient': { publicJwk: patient.publicJwk, roles: ['patient'] },
    }),
    audit: new AuditWriter(audit),
    invitations: new InMemoryIdempotentInvitationStore(),
    memberships,
    sealer: new EnvelopeSealer(new DevKeyManager('test'), 'kms/clinical'),
    now: () => new Date(),
    loadConsents: () => Promise.resolve(new Set()),
  };
  const workloadVerifier = new WorkloadTokenVerifier('api', {
    'bff-clinic': { publicJwk: clinic.publicJwk, scopes: ['api.membership.resolve'] },
  });
  const deps: ApiDeps = withoutWorkload
    ? { ...base, ...overrides }
    : { ...base, workloadVerifier, ...overrides };
  return finish(await buildApi(deps));

  function finish(app: Awaited<ReturnType<typeof buildApi>>) {
    const resolve = (headers: Record<string, string>, payload: object = { identity_ref: PERSON }) =>
      app.inject({ method: 'POST', url: '/internal/v1/memberships/resolve', headers, payload });
    const workload = async () => ({
      authorization: `Bearer ${await new WorkloadTokenSigner(clinic.privateJwk, 'bff-clinic').sign(['api.membership.resolve'], 'api')}`,
    });
    return { app, audit, resolve, workload, clinic, patient };
  }
}

describe('ADR-0019 POST /internal/v1/memberships/resolve (clinic BFF, workload token)', () => {
  it('returns the active memberships of a person, organisation and role only', async () => {
    const { resolve, workload, audit } = await setup();
    const res = await resolve(await workload());
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      memberships: [
        { org_id: ORG_A, role: 'clinician' },
        { org_id: ORG_B, role: 'org_admin' },
      ],
    });
    expect(await audit.readRange(1, 10)).toMatchObject([
      { action: 'api.membership.resolve', outcome: 'success', actor: { role: 'system' } },
    ]);
  });

  it('returns an empty list for an unknown person', async () => {
    const { resolve, workload } = await setup();
    const res = await resolve(await workload(), {
      identity_ref: '01900000-0000-7000-8000-000000000999',
    });
    expect(res.json()).toEqual({ memberships: [] });
  });

  it('refuses a user service token, even a valid one (token types never mix)', async () => {
    const { resolve, patient } = await setup();
    const user = await new ServiceTokenSigner(patient.privateJwk, 'bff-patient').sign(
      { sub: PERSON, role: 'patient', org_id: null, patient_id: PERSON },
      'api',
    );
    expect((await resolve({ authorization: `Bearer ${user}` })).statusCode).toBe(401);
  });

  it('refuses a workload token without the scope, and audits the refusal', async () => {
    const { resolve, clinic, audit } = await setup({
      workloadVerifier: new WorkloadTokenVerifier('api', {
        'bff-clinic': {
          publicJwk: (await generateServiceKeyPair()).publicJwk,
          scopes: ['api.membership.resolve'],
        },
      }),
    });
    const wrongKey = await new WorkloadTokenSigner(clinic.privateJwk, 'bff-clinic').sign(
      ['api.membership.resolve'],
      'api',
    );
    expect((await resolve({ authorization: `Bearer ${wrongKey}` })).statusCode).toBe(401);
    expect(await audit.readRange(1, 10)).toMatchObject([
      { outcome: 'denied', reason: 'authn.invalid' },
    ]);
  });

  it('fails closed with no workload verifier configured', async () => {
    const { resolve, workload } = await setup({}, true);
    expect((await resolve(await workload())).statusCode).toBe(401);
  });

  it('rejects a malformed identity reference and unknown fields', async () => {
    const { resolve, workload } = await setup();
    expect((await resolve(await workload(), { identity_ref: 'x' })).statusCode).toBe(400);
    expect(
      (await resolve(await workload(), { identity_ref: PERSON, org_id: ORG_A })).statusCode,
    ).toBe(400);
  });
});

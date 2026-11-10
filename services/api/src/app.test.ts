import { describe, expect, it } from 'vitest';
import { AuditWriter, InMemoryAuditStore, verifyChain, type AuditEvent } from '@endo/audit';
import {
  InMemoryConsentStore,
  InMemoryIdempotentInvitationStore,
  InMemoryMembershipStore,
} from '@endo/clinical-store';
import { DevKeyManager, EnvelopeSealer } from '@endo/crypto';
import {
  RouteDeclarationError,
  ServiceTokenSigner,
  ServiceTokenVerifier,
  generateServiceKeyPair,
  type ServiceClaims,
} from '@endo/service-kit';
import type { Role } from '@endo/domain';
import { buildApi, createApiInstance, isRoutePolicy, type ApiDeps } from './app.ts';

const PATIENT: ServiceClaims = {
  sub: '01900000-0000-7000-8000-000000000001',
  role: 'patient',
  org_id: null,
  patient_id: '01900000-0000-7000-8000-0000000000c1',
};

/** `roles`: what the test issuer may vouch for. Widened only to exercise the authz layer behind it. */
async function setup(overrides: Partial<ApiDeps> = {}, roles: readonly Role[] = ['patient']) {
  const keys = await generateServiceKeyPair();
  const store = new InMemoryAuditStore();
  const logs: string[] = [];
  const app = await buildApi({
    logLevel: 'info',
    verifier: new ServiceTokenVerifier('api', {
      'bff-patient': { publicJwk: keys.publicJwk, roles },
    }),
    audit: new AuditWriter(store),
    invitations: new InMemoryIdempotentInvitationStore(),
    sealer: new EnvelopeSealer(new DevKeyManager('test'), 'kms/clinical'),
    memberships: new InMemoryMembershipStore(),
    now: () => new Date(),
    consents: new InMemoryConsentStore(),
    logStream: { write: (l) => logs.push(l) },
    ...overrides,
  });
  const signer = new ServiceTokenSigner(keys.privateJwk, 'bff-patient');
  const bearer = async (c: ServiceClaims = PATIENT) => `Bearer ${await signer.sign(c, 'api')}`;
  const events = async (): Promise<readonly AuditEvent[]> => store.readRange(1, 100);
  return { app, bearer, events, logs, keys };
}

describe('GET /v1/hello (M0 walking skeleton, spec 2.5, 2.6)', () => {
  it('allows an authenticated patient and audits the access', async () => {
    const { app, bearer, events } = await setup();
    const res = await app.inject({ url: '/v1/hello', headers: { authorization: await bearer() } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      message: 'hello',
      role: 'patient',
      request_id: res.headers['x-request-id'],
    });
    const audit = await events();
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({
      actor: { id: PATIENT.sub, role: 'patient' },
      action: 'system.hello',
      outcome: 'success',
      request_id: res.headers['x-request-id'],
    });
    expect(verifyChain(audit).ok).toBe(true);
  });

  it('rejects a missing token with 401 and audits the denial', async () => {
    const { app, events } = await setup();
    const res = await app.inject({ url: '/v1/hello' });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toMatchObject({ type: 'https://errors.glucorp.health/authn.missing' });
    expect(await events()).toMatchObject([
      { actor: { role: 'anonymous' }, outcome: 'denied', reason: 'authn.missing' },
    ]);
  });

  it('rejects a token from an untrusted signer', async () => {
    const { app, events } = await setup();
    const other = await generateServiceKeyPair();
    const forged = await new ServiceTokenSigner(other.privateJwk, 'bff-patient').sign(
      PATIENT,
      'api',
    );
    const res = await app.inject({
      url: '/v1/hello',
      headers: { authorization: `Bearer ${forged}` },
    });
    expect(res.statusCode).toBe(401);
    expect(await events()).toMatchObject([{ reason: 'authn.invalid' }]);
  });

  it('RISK-S03 rejects a platform-admin claim from the patient BFF at authentication, and audits it', async () => {
    const { app, bearer, events } = await setup();
    const admin: ServiceClaims = { ...PATIENT, role: 'glucorp_platform_admin', patient_id: null };
    const res = await app.inject({
      url: '/v1/hello',
      headers: { authorization: await bearer(admin) },
    });
    expect(res.statusCode).toBe(401);
    expect(await events()).toMatchObject([{ outcome: 'denied', reason: 'authn.invalid' }]);
  });

  it('denies platform admins inside the app even from a trusted issuer (break-glass is infra-only)', async () => {
    const { app, bearer, events } = await setup({}, ['patient', 'glucorp_platform_admin']);
    const admin: ServiceClaims = { ...PATIENT, role: 'glucorp_platform_admin', patient_id: null };
    const res = await app.inject({
      url: '/v1/hello',
      headers: { authorization: await bearer(admin) },
    });
    expect(res.statusCode).toBe(403);
    expect(await events()).toMatchObject([
      { outcome: 'denied', reason: 'authz.role_not_permitted' },
    ]);
  });

  it('fails closed with 500 if the audit write fails', async () => {
    const failing = new AuditWriter({
      head: () => Promise.resolve(null),
      append: () => Promise.reject(new Error('audit store down')),
      appendNext: () => Promise.reject(new Error('audit store down')),
      readRange: () => Promise.resolve([]),
    });
    const { app, bearer } = await setup({ audit: failing });
    const res = await app.inject({ url: '/v1/hello', headers: { authorization: await bearer() } });
    expect(res.statusCode).toBe(500);
    expect(res.body).not.toContain('hello');
  });

  it('sets no-store and security headers', async () => {
    const { app, bearer } = await setup();
    const res = await app.inject({ url: '/v1/hello', headers: { authorization: await bearer() } });
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
  });

  it('propagates a UUID request id from the BFF', async () => {
    const { app, bearer } = await setup();
    const id = '01900000-0000-7000-8000-0000000000ff';
    const res = await app.inject({
      url: '/v1/hello',
      headers: { authorization: await bearer(), 'x-request-id': id },
    });
    expect(res.headers['x-request-id']).toBe(id);
  });
});

describe('platform routes', () => {
  it('RISK-D01 rate-limits callers before authentication, with a problem response', async () => {
    const { app, events } = await setup({ rateLimitPerMinute: 2 });
    const codes: number[] = [];
    for (let i = 0; i < 3; i++) codes.push((await app.inject({ url: '/v1/hello' })).statusCode);
    expect(codes).toEqual([401, 401, 429]);
    const limited = await app.inject({ url: '/v1/hello' });
    expect(limited.headers['content-type']).toContain('application/problem+json');
    expect(limited.json()).toMatchObject({ type: 'https://errors.glucorp.health/rate_limited' });
    expect(limited.headers['retry-after']).toBeDefined();
    expect(limited.headers['cache-control']).toBe('no-store');
    // Throttled requests never reach token verification, so they add no audit events.
    expect(await events()).toHaveLength(2);
  });

  it('does not rate-limit liveness probes', async () => {
    const { app } = await setup({ rateLimitPerMinute: 1 });
    for (let i = 0; i < 3; i++)
      expect((await app.inject({ url: '/healthz' })).statusCode).toBe(200);
  });

  it('healthz is public and writes no audit event', async () => {
    const { app, events } = await setup();
    const res = await app.inject({ url: '/healthz' });
    expect(res.statusCode).toBe(200);
    expect(await events()).toHaveLength(0);
  });

  it('unknown routes return a 404 problem', async () => {
    const { app } = await setup();
    const res = await app.inject({ url: '/v1/nope' });
    expect(res.statusCode).toBe(404);
    expect(res.headers['content-type']).toContain('application/problem+json');
  });

  it('logs contain only allowlisted fields and no token material (RISK-I02)', async () => {
    const { app, bearer, logs } = await setup();
    const auth = await bearer();
    await app.inject({ url: '/v1/hello?SYNTHETIC_PHI_MARKER=1', headers: { authorization: auth } });
    const joined = logs.join('\n');
    expect(joined).toContain('request.completed');
    expect(joined).not.toContain('SYNTHETIC_PHI_MARKER');
    expect(joined).not.toContain(auth.slice(7, 40));
    for (const line of logs) {
      const keys = Object.keys(JSON.parse(line) as object);
      for (const k of keys)
        expect([
          'level',
          'time',
          'service',
          'event',
          'reqId',
          'method',
          'route',
          'statusCode',
          'durationMs',
          'errorCode',
          'errorName',
          'outcome',
        ]).toContain(k);
    }
  });
});

describe('deny by default: route policy enforcement (spec 2.5, 10.4)', () => {
  async function bareInstance() {
    const keys = await generateServiceKeyPair();
    return createApiInstance({
      logLevel: 'silent',
      verifier: new ServiceTokenVerifier('api', {
        'bff-patient': { publicJwk: keys.publicJwk, roles: ['patient'] },
      }),
      audit: new AuditWriter(new InMemoryAuditStore()),
      invitations: new InMemoryIdempotentInvitationStore(),
      sealer: new EnvelopeSealer(new DevKeyManager('test'), 'kms/clinical'),
      memberships: new InMemoryMembershipStore(),
      now: () => new Date(),
      consents: new InMemoryConsentStore(),
    });
  }

  it.each([
    ['missing', undefined],
    ['public with an unlisted reason', { kind: 'public', reason: 'because' }],
    ['unknown action', { kind: 'protected', action: 'everything.do', resource: () => ({}) }],
    ['missing a resource builder', { kind: 'protected', action: 'system.hello' }],
    ['not an object', 'system.hello'],
  ])('refuses to register a route whose policy is %s', async (_l, policy) => {
    const app = await bareInstance();
    expect(() => app.get('/v1/x', { config: { policy } as never }, () => 'x')).toThrow(
      RouteDeclarationError,
    );
    expect(isRoutePolicy(policy)).toBe(false);
  });

  it('accepts a valid protected policy', async () => {
    const app = await bareInstance();
    const policy = {
      kind: 'protected',
      action: 'system.hello',
      resourceType: 'system',
      purpose: 'system_check',
      resource: () => ({}),
    };
    expect(() => app.get('/v1/x', { config: { policy } as never }, () => 'x')).not.toThrow();
  });
});

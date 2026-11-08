import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApi } from '@endo/api/app';
import { AuditWriter, InMemoryAuditStore, verifyChain } from '@endo/audit';
import { InMemoryInvitationStore, InMemoryMembershipStore } from '@endo/clinical-store';
import { uuidv7 } from '@endo/domain';
import {
  ServiceTokenSigner,
  ServiceTokenVerifier,
  generateServiceKeyPair,
} from '@endo/service-kit';
import { buildBff } from './app.ts';
import { DevSessionStore, SESSION_COOKIE } from './sessions.ts';

/**
 * M0 exit criterion (spec 22): a "hello" route passes through BFF, authz and audit.
 * Real HTTP between BFF and API on loopback; synthetic subjects only.
 */
describe('M0 walking skeleton: browser -> bff-patient -> api -> authz -> audit', () => {
  let api: FastifyInstance;
  let bff: FastifyInstance;
  const auditStore = new InMemoryAuditStore();
  const sessions = new DevSessionStore('test');
  const logs: string[] = [];

  beforeAll(async () => {
    const keys = await generateServiceKeyPair();
    api = await buildApi({
      logLevel: 'info',
      verifier: new ServiceTokenVerifier('api', {
        'bff-patient': { publicJwk: keys.publicJwk, roles: ['patient'] },
      }),
      audit: new AuditWriter(auditStore),
      invitations: new InMemoryInvitationStore(),
      memberships: new InMemoryMembershipStore(),
      now: () => new Date(),
      loadConsents: () => Promise.resolve(new Set()),
      logStream: { write: (l) => logs.push(l) },
    });
    await api.listen({ host: '127.0.0.1', port: 0 });
    const address = api.addresses()[0];
    bff = await buildBff({
      logLevel: 'info',
      sessions,
      signer: new ServiceTokenSigner(keys.privateJwk, 'bff-patient'),
      apiBaseUrl: `http://127.0.0.1:${address?.port ?? 0}`,
      fetch,
      logStream: { write: (l) => logs.push(l) },
    });
  });

  afterAll(async () => {
    await bff.close();
    await api.close();
  });

  it('serves hello for a signed-in patient and leaves a valid audit chain', async () => {
    const patientId = uuidv7();
    const token = sessions.create({
      sub: uuidv7(),
      role: 'patient',
      org_id: null,
      patient_id: patientId,
    });
    const res = await bff.inject({
      url: '/v1/hello',
      headers: { cookie: `${SESSION_COOKIE}=${token}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ message: string; role: string; request_id: string }>();
    expect(body).toMatchObject({ message: 'hello', role: 'patient' });

    // The BFF's request id is carried to the API and into the audit event.
    const events = await auditStore.readRange(1, 100);
    const event = events.find((e) => e.request_id === body.request_id);
    expect(event).toMatchObject({
      action: 'system.hello',
      outcome: 'success',
      actor: { role: 'patient' },
    });
    expect(verifyChain(events).ok).toBe(true);
  });

  it('applies spec 12.2 security headers on browser responses', async () => {
    const res = await bff.inject({ url: '/healthz' });
    expect(res.headers['content-security-policy']).toContain("frame-ancestors 'none'");
    expect(res.headers['strict-transport-security']).toContain('max-age=63072000');
    expect(res.headers['cross-origin-opener-policy']).toBe('same-origin');
    expect(res.headers['referrer-policy']).toBe('no-referrer');
  });

  it('never exposes the service token to the browser', async () => {
    const token = sessions.create({
      sub: uuidv7(),
      role: 'patient',
      org_id: null,
      patient_id: uuidv7(),
    });
    const res = await bff.inject({
      url: '/v1/hello',
      headers: { cookie: `${SESSION_COOKIE}=${token}` },
    });
    expect(JSON.stringify(res.headers)).not.toMatch(/eyJ[A-Za-z0-9_-]+\./);
    expect(res.body).not.toMatch(/eyJ[A-Za-z0-9_-]+\./);
  });

  it('passes through a denial from the API without its body', async () => {
    const token = sessions.create({
      sub: uuidv7(),
      role: 'glucorp_platform_admin',
      org_id: null,
      patient_id: null,
    });
    const res = await bff.inject({
      url: '/v1/hello',
      headers: { cookie: `${SESSION_COOKIE}=${token}` },
    });
    // The API refuses a platform-admin claim from the patient BFF at authentication (RISK-S03).
    expect(res.statusCode).toBe(401);
    expect(res.json()).toMatchObject({ type: 'https://errors.glucorp.health/authn.rejected' });
  });

  it('writes no session tokens or URLs into any log line (RISK-I02)', async () => {
    const token = sessions.create({
      sub: uuidv7(),
      role: 'patient',
      org_id: null,
      patient_id: uuidv7(),
    });
    await bff.inject({
      url: '/v1/hello?SYNTHETIC_PHI_MARKER=1',
      headers: { cookie: `${SESSION_COOKIE}=${token}` },
    });
    const all = logs.join('\n');
    expect(all).not.toContain(token);
    expect(all).not.toContain('SYNTHETIC_PHI_MARKER');
  });
});

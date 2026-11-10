import { describe, expect, it } from 'vitest';
import { AuditWriter, InMemoryAuditStore } from '@endo/audit';
import {
  DevKeyManager,
  FieldCipher,
  InMemoryPatientKeyStore,
  KeyDestroyedError,
} from '@endo/crypto';
import {
  WorkloadTokenSigner,
  WorkloadTokenVerifier,
  generateServiceKeyPair,
} from '@endo/service-kit';
import { buildIdentity } from './app.ts';
import { InMemoryPersonStore } from './persons.ts';

const SYNTHETIC_PHI_MARKER = 'SYNTHETIC_PHI_MARKER-identity-svc-5d1e';

async function setup(opts: { rateLimitPerMinute?: number; failErrorAudits?: boolean } = {}) {
  const api = await generateServiceKeyPair();
  const jobs = await generateServiceKeyPair();
  const clinic = await generateServiceKeyPair();
  const cipher = new FieldCipher(
    new DevKeyManager('test'),
    new InMemoryPatientKeyStore(),
    'kms/identity',
  );
  const persons = new InMemoryPersonStore(cipher);
  const audit = new InMemoryAuditStore();
  const store = opts.failErrorAudits
    ? {
        head: () => audit.head(),
        readRange: (a: number, b: number) => audit.readRange(a, b),
        append: (e: Parameters<InMemoryAuditStore['append']>[0]) =>
          e.outcome === 'error' ? Promise.reject(new Error('audit down')) : audit.append(e),
        appendNext: async (build: Parameters<InMemoryAuditStore['appendNext']>[0]) => {
          const e = build(await audit.head());
          if (e.outcome === 'error') throw new Error('audit down');
          return audit.appendNext(() => e);
        },
      }
    : audit;
  const logs: string[] = [];
  const app = await buildIdentity({
    logLevel: 'info',
    verifier: new WorkloadTokenVerifier('identity', {
      api: { publicJwk: api.publicJwk, scopes: ['identity.person.create'] },
      jobs: { publicJwk: jobs.publicJwk, scopes: ['identity.person.erase'] },
      'bff-clinic': { publicJwk: clinic.publicJwk, scopes: ['identity.subject.resolve'] },
    }),
    audit: new AuditWriter(store),
    persons,
    ...(opts.rateLimitPerMinute ? { rateLimitPerMinute: opts.rateLimitPerMinute } : {}),
    idpIssuer: 'https://kc.test/realms/endo-dev',
    logStream: { write: (l) => logs.push(l) },
  });
  const apiSigner = new WorkloadTokenSigner(api.privateJwk, 'api');
  const jobsSigner = new WorkloadTokenSigner(jobs.privateJwk, 'jobs');
  const clinicSigner = new WorkloadTokenSigner(clinic.privateJwk, 'bff-clinic');
  const auth = async (signer: WorkloadTokenSigner, scope: string) => ({
    authorization: `Bearer ${await signer.sign([scope], 'identity')}`,
  });
  return { app, persons, cipher, audit, logs, apiSigner, jobsSigner, clinicSigner, auth };
}

describe('spec 5.2 identity service: create and erase people (ADR-0018)', () => {
  it('creates a person with fields encrypted under her own key; plaintext appears nowhere', async () => {
    const { app, persons, cipher, logs, auth, apiSigner } = await setup();
    const res = await app.inject({
      method: 'POST',
      url: '/internal/v1/persons',
      headers: await auth(apiSigner, 'identity.person.create'),
      payload: {
        email: `${SYNTHETIC_PHI_MARKER}@example.test`,
        display_name: SYNTHETIC_PHI_MARKER,
      },
    });
    expect(res.statusCode).toBe(201);
    expect(res.body).not.toContain(SYNTHETIC_PHI_MARKER);
    const id = res.json<{ person_id: string }>().person_id;
    const row = persons.rows.get(id);
    expect(JSON.stringify(row)).not.toContain(SYNTHETIC_PHI_MARKER);
    await expect(
      cipher.decrypt(row!.displayName!, {
        patientId: id,
        field: 'person.display_name',
        recordId: id,
      }),
    ).resolves.toBe(SYNTHETIC_PHI_MARKER);
    expect(logs.join('\n')).not.toContain(SYNTHETIC_PHI_MARKER);
  });

  it('accepts a person with no contact fields, and rejects unknown or malformed fields', async () => {
    const { app, auth, apiSigner } = await setup();
    const post = async (payload: object) =>
      app.inject({
        method: 'POST',
        url: '/internal/v1/persons',
        headers: await auth(apiSigner, 'identity.person.create'),
        payload,
      });
    expect((await post({})).statusCode).toBe(201);
    expect((await post({ email: 'not-an-email' })).statusCode).toBe(400);
    expect((await post({ phone: '+254700000000' })).statusCode).toBe(400);
  });

  it('REQ-009 erases: the key is shredded and the fields can no longer be decrypted', async () => {
    const { app, persons, cipher, auth, apiSigner, jobsSigner } = await setup();
    const created = await app.inject({
      method: 'POST',
      url: '/internal/v1/persons',
      headers: await auth(apiSigner, 'identity.person.create'),
      payload: { display_name: SYNTHETIC_PHI_MARKER },
    });
    const id = created.json<{ person_id: string }>().person_id;
    const erase = async () =>
      app.inject({
        method: 'POST',
        url: `/internal/v1/persons/${id}/erasure`,
        headers: await auth(jobsSigner, 'identity.person.erase'),
      });
    expect((await erase()).statusCode).toBe(204);
    expect((await erase()).statusCode).toBe(204); // idempotent
    await expect(
      cipher.decrypt(persons.rows.get(id)!.displayName!, {
        patientId: id,
        field: 'person.display_name',
        recordId: id,
      }),
    ).rejects.toBeInstanceOf(KeyDestroyedError);
  });

  it('answers 404 for an unknown person and 400 for a malformed id', async () => {
    const { app, auth, jobsSigner } = await setup();
    const post = async (id: string) =>
      app.inject({
        method: 'POST',
        url: `/internal/v1/persons/${id}/erasure`,
        headers: await auth(jobsSigner, 'identity.person.erase'),
      });
    expect((await post('01900000-0000-7000-8000-000000000999')).statusCode).toBe(404);
    expect((await post('not-a-uuid')).statusCode).toBe(400);
  });

  it('denies a caller without the route scope, and an unauthenticated caller; both audited', async () => {
    const { app, audit, auth, apiSigner } = await setup();
    // The API may create people but not erase them.
    const denied = await app.inject({
      method: 'POST',
      url: '/internal/v1/persons/01900000-0000-7000-8000-000000000001/erasure',
      headers: await auth(apiSigner, 'identity.person.create'),
    });
    expect(denied.statusCode).toBe(403);
    const anon = await app.inject({ method: 'POST', url: '/internal/v1/persons', payload: {} });
    expect(anon.statusCode).toBe(401);
    expect(await audit.readRange(1, 10)).toMatchObject([
      { action: 'identity.person.erase', outcome: 'denied', reason: 'authz.scope_missing' },
      { action: 'identity.person.create', outcome: 'denied', reason: 'authn.missing' },
    ]);
  });

  it('spec 2.6 audits the decision, then the result with the person id', async () => {
    const { app, audit, auth, apiSigner } = await setup();
    const res = await app.inject({
      method: 'POST',
      url: '/internal/v1/persons',
      headers: await auth(apiSigner, 'identity.person.create'),
      payload: {},
    });
    const id = res.json<{ person_id: string }>().person_id;
    expect(await audit.readRange(1, 10)).toMatchObject([
      { action: 'identity.person.create', outcome: 'success', resource: { id: null } },
      { action: 'identity.person.created', outcome: 'success', resource: { type: 'person', id } },
    ]);
  });

  it('audits an authorised request that then fails as an error, never as a success', async () => {
    const { app, audit, auth, apiSigner, jobsSigner } = await setup();
    await app.inject({
      method: 'POST',
      url: '/internal/v1/persons',
      headers: await auth(apiSigner, 'identity.person.create'),
      payload: { email: 'bad' },
    });
    await app.inject({
      method: 'POST',
      url: '/internal/v1/persons/01900000-0000-7000-8000-000000000999/erasure',
      headers: await auth(jobsSigner, 'identity.person.erase'),
    });
    const events = await audit.readRange(1, 10);
    expect(events.filter((e) => e.outcome === 'error')).toMatchObject([
      { action: 'identity.person.create', reason: 'http.status_400' },
      { action: 'identity.person.erase', reason: 'http.status_404' },
    ]);
    expect(events.some((e) => e.action.endsWith('.created') || e.action.endsWith('.erased'))).toBe(
      false,
    );
  });

  it('answers 400, not 500, for an id the audit schema would reject', async () => {
    const { app, audit, auth, jobsSigner } = await setup();
    const res = await app.inject({
      method: 'POST',
      url: '/internal/v1/persons/00000000-0000-0000-0000-000000000000/erasure',
      headers: await auth(jobsSigner, 'identity.person.erase'),
    });
    expect(res.statusCode).toBe(400);
    expect((await audit.readRange(1, 10))[0]).toMatchObject({ resource: { id: null } });
  });

  it('ADR-0019 resolves a sign-in subject to its person, and never an erased one', async () => {
    const { app, persons, auth, clinicSigner, apiSigner, jobsSigner } = await setup();
    const created = await app.inject({
      method: 'POST',
      url: '/internal/v1/persons',
      headers: await auth(apiSigner, 'identity.person.create'),
      payload: {},
    });
    const id = created.json<{ person_id: string }>().person_id;
    persons.subjects.set('kc-sub-1', id);
    const resolve = async (signer = clinicSigner, issuer = 'https://kc.test/realms/endo-dev') =>
      app.inject({
        method: 'POST',
        url: '/internal/v1/subjects/resolve',
        headers: await auth(signer, 'identity.subject.resolve'),
        payload: { idp_issuer: issuer, idp_subject: 'kc-sub-1' },
      });
    const ok = await resolve();
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toEqual({ person_id: id });
    // Only the clinic BFF holds this scope.
    expect((await resolve(apiSigner)).statusCode).toBe(401);
    // Another issuer's subject never resolves.
    expect((await resolve(clinicSigner, 'https://evil.test/realms/x')).statusCode).toBe(404);
    await app.inject({
      method: 'POST',
      url: `/internal/v1/persons/${id}/erasure`,
      headers: await auth(jobsSigner, 'identity.person.erase'),
    });
    expect((await resolve()).statusCode).toBe(404);
  });

  it('RISK-D01 rate-limits callers before any work', async () => {
    const { app, auth, apiSigner } = await setup({ rateLimitPerMinute: 1 });
    const post = async () =>
      app.inject({
        method: 'POST',
        url: '/internal/v1/persons',
        headers: await auth(apiSigner, 'identity.person.create'),
        payload: {},
      });
    expect((await post()).statusCode).toBe(201);
    expect((await post()).statusCode).toBe(429);
  });

  it('logs, without failing the response, when the error audit write fails', async () => {
    const { app, logs, auth, apiSigner } = await setup({ failErrorAudits: true });
    const res = await app.inject({
      method: 'POST',
      url: '/internal/v1/persons',
      headers: await auth(apiSigner, 'identity.person.create'),
      payload: { email: 'bad' },
    });
    expect(res.statusCode).toBe(400);
    // onResponse hooks run after the response is handed back to inject().
    await new Promise((r) => setTimeout(r, 100));
    expect(logs.join('\n')).toContain('audit.write_failed');
  });

  it('serves liveness without authentication and sets security headers', async () => {
    const { app } = await setup();
    const res = await app.inject({ url: '/healthz' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
  });
});

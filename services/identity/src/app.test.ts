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

async function setup() {
  const api = await generateServiceKeyPair();
  const jobs = await generateServiceKeyPair();
  const cipher = new FieldCipher(
    new DevKeyManager('test'),
    new InMemoryPatientKeyStore(),
    'kms/identity',
  );
  const persons = new InMemoryPersonStore(cipher);
  const audit = new InMemoryAuditStore();
  const logs: string[] = [];
  const app = await buildIdentity({
    logLevel: 'info',
    verifier: new WorkloadTokenVerifier('identity', {
      api: { publicJwk: api.publicJwk, scopes: ['identity.person.create'] },
      jobs: { publicJwk: jobs.publicJwk, scopes: ['identity.person.erase'] },
    }),
    audit: new AuditWriter(audit),
    persons,
    logStream: { write: (l) => logs.push(l) },
  });
  const apiSigner = new WorkloadTokenSigner(api.privateJwk, 'api');
  const jobsSigner = new WorkloadTokenSigner(jobs.privateJwk, 'jobs');
  const auth = async (signer: WorkloadTokenSigner, scope: string) => ({
    authorization: `Bearer ${await signer.sign([scope], 'identity')}`,
  });
  return { app, persons, cipher, audit, logs, apiSigner, jobsSigner, auth };
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

  it('serves liveness without authentication and sets security headers', async () => {
    const { app } = await setup();
    const res = await app.inject({ url: '/healthz' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
  });
});

import { describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { SignJWT, exportJWK, generateKeyPair } from 'jose';
import type { ApiPort } from './api-client.ts';
import { ApiUnavailableError } from './api-client.ts';
import { buildIntegration, isIntegrationAuth } from './app.ts';
import type { Client } from './smart.ts';

const BASE = 'https://fhir.test';
const ORG = '01900000-0000-7000-8000-00000000000a';
const PATIENT = '01900000-0000-7000-8000-0000000000a1';
const CLIENT_ID = 'c'.repeat(24);
const MARKER = 'SYNTHETIC_PHI_MARKER-integration';

async function setup(opts: { scopes?: string[]; down?: boolean } = {}) {
  const { privateKey, publicKey } = await generateKeyPair('ES384');
  const jwk = { ...(await exportJWK(publicKey)), alg: 'ES384', kid: 'k1' };
  let clock = Date.parse('2026-11-16T10:00:00Z');
  const client: Client = {
    id: randomUUID(),
    orgId: ORG,
    jwks: { keys: [jwk] },
    scopes: opts.scopes ?? ['system/Patient.rs', 'system/CarePlan.rs', 'system/Observation.rs'],
    active: true,
  };
  const reads: string[] = [];
  const logs: string[] = [];
  const api: ApiPort = {
    resolveClient: (id) => {
      if (opts.down) return Promise.reject(new ApiUnavailableError());
      return Promise.resolve(id === CLIENT_ID ? client : null);
    },
    patient: (orgId, patientId) => {
      reads.push(`${orgId}/${patientId}`);
      return Promise.resolve(
        patientId === PATIENT
          ? {
              resourceType: 'Bundle',
              entry: [
                {
                  fullUrl: `urn:uuid:${PATIENT}`,
                  resource: { resourceType: 'Patient', id: PATIENT },
                },
                { resource: { resourceType: 'CarePlan', id: 'cp', description: MARKER } },
              ],
            }
          : null,
      );
    },
  };
  const app = await buildIntegration({
    logLevel: 'info',
    logStream: { write: (l) => logs.push(l) },
    baseUrl: BASE,
    api,
    now: () => clock,
  });
  const assertion = (claims: { exp?: number; aud?: string } = {}, key = privateKey, kid = 'k1') =>
    new SignJWT({ jti: randomUUID() })
      .setProtectedHeader({ alg: 'ES384', kid })
      .setIssuer(CLIENT_ID)
      .setSubject(CLIENT_ID)
      .setAudience(claims.aud ?? `${BASE}/oauth/token`)
      .setIssuedAt(Math.floor(clock / 1000))
      .setExpirationTime(claims.exp ?? Math.floor(clock / 1000) + 240)
      .sign(key);
  const token = async (scope: string, a?: string) =>
    app.inject({
      method: 'POST',
      url: '/oauth/token',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: new URLSearchParams({
        grant_type: 'client_credentials',
        client_assertion_type: 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer',
        client_assertion: a ?? (await assertion()),
        scope,
      }).toString(),
    });
  const get = (url: string, bearer: string) =>
    app.inject({ url, headers: { authorization: `Bearer ${bearer}` } });
  return {
    app,
    client,
    token,
    assertion,
    get,
    reads,
    logs,
    advance: (ms: number) => {
      clock += ms;
    },
  };
}

describe('M7 discovery (spec 9.3)', () => {
  it('publishes the SMART configuration and a CapabilityStatement', async () => {
    const { app } = await setup();
    const smart = (await app.inject({ url: '/.well-known/smart-configuration' })).json<{
      token_endpoint: string;
      token_endpoint_auth_methods_supported: string[];
    }>();
    expect(smart.token_endpoint).toBe(`${BASE}/oauth/token`);
    expect(smart.token_endpoint_auth_methods_supported).toEqual(['private_key_jwt']);
    const meta = await app.inject({ url: '/fhir/r4/metadata' });
    expect(meta.headers['content-type']).toContain('application/fhir+json');
    expect(meta.json()).toMatchObject({
      resourceType: 'CapabilityStatement',
      fhirVersion: '4.0.1',
    });
    expect((await app.inject({ url: '/healthz' })).json()).toEqual({ status: 'ok' });
    expect(isIntegrationAuth({ kind: 'bearer', resource: 'Practitioner' })).toBe(false);
    expect(isIntegrationAuth(null)).toBe(false);
  });
});

describe('M7 SMART Backend Services tokens (spec 16.3)', () => {
  it('issues a 5-minute token for a signed assertion, with only the granted scopes', async () => {
    const { token } = await setup();
    const res = await token('system/Patient.rs system/Goal.rs');
    expect(res.statusCode).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.json()).toMatchObject({
      token_type: 'bearer',
      expires_in: 300,
      scope: 'system/Patient.rs',
    });
  });

  it('refuses a replayed, foreign, long-lived or wrongly addressed assertion', async () => {
    const { token, assertion } = await setup();
    const once = await assertion();
    expect((await token('system/Patient.rs', once)).statusCode).toBe(200);
    expect((await token('system/Patient.rs', once)).statusCode).toBe(401); // jti reused
    const other = await generateKeyPair('ES384');
    expect(
      (await token('system/Patient.rs', await assertion({}, other.privateKey))).statusCode,
    ).toBe(401);
    expect(
      (await token('system/Patient.rs', await assertion({}, undefined, 'k9'))).statusCode,
    ).toBe(401);
    expect(
      (
        await token(
          'system/Patient.rs',
          await assertion({ exp: Math.floor(Date.parse('2026-11-16T10:00:00Z') / 1000) + 3600 }),
        )
      ).statusCode,
    ).toBe(401);
    expect(
      (await token('system/Patient.rs', await assertion({ aud: 'https://evil.test' }))).statusCode,
    ).toBe(401);
    expect((await token('system/Patient.rs', 'not.a.jwt')).statusCode).toBe(401);
    expect((await token('system/Goal.rs')).statusCode).toBe(400); // not registered for it
  });

  it('refuses an unknown or switched-off client, and fails closed when the API is down', async () => {
    const s = await setup();
    Object.assign(s.client, { active: false });
    expect((await s.token('system/Patient.rs')).statusCode).toBe(401);
    const down = await setup({ down: true });
    expect((await down.token('system/Patient.rs')).statusCode).toBe(503);
  });
});

describe('M7 FHIR reads (spec 9.3, 16.4)', () => {
  it('reads her Patient and searches by patient, through the API, never logging content', async () => {
    const { token, get, reads, logs } = await setup();
    const t = (await token('system/Patient.rs system/CarePlan.rs system/Observation.rs')).json<{
      access_token: string;
    }>().access_token;
    const patient = await get(`/fhir/r4/Patient/${PATIENT}`, t);
    expect(patient.statusCode).toBe(200);
    expect(patient.json()).toEqual({ resourceType: 'Patient', id: PATIENT });
    const plans = await get(`/fhir/r4/CarePlan?patient=Patient/${PATIENT}`, t);
    expect(plans.json()).toMatchObject({ resourceType: 'Bundle', type: 'searchset', total: 1 });
    expect((await get(`/fhir/r4/Patient?_id=${PATIENT}`, t)).json()).toMatchObject({ total: 1 });
    // Shadow verdicts are never released.
    expect((await get(`/fhir/r4/Observation?patient=${PATIENT}`, t)).json()).toMatchObject({
      total: 0,
    });
    expect(reads).toEqual([`${ORG}/${PATIENT}`, `${ORG}/${PATIENT}`, `${ORG}/${PATIENT}`]);
    expect(logs.join('\n')).not.toContain(MARKER);
  });

  it('answers OperationOutcome for a missing patient, a bad search, a missing scope or token', async () => {
    const { token, get, advance, client } = await setup();
    const t = (await token('system/Patient.rs')).json<{ access_token: string }>().access_token;
    const missing = await get(`/fhir/r4/Patient/${randomUUID()}`, t);
    expect(missing.statusCode).toBe(404);
    expect(missing.json()).toMatchObject({
      resourceType: 'OperationOutcome',
      issue: [{ code: 'not-found' }],
    });
    expect((await get('/fhir/r4/Patient?name=x', t)).statusCode).toBe(400);
    expect((await get('/fhir/r4/Patient', t)).statusCode).toBe(400);
    expect((await get(`/fhir/r4/CarePlan?patient=${PATIENT}`, t)).statusCode).toBe(403);
    expect((await get(`/fhir/r4/Patient/${PATIENT}`, 'nope')).json()).toMatchObject({
      issue: [{ code: 'login' }],
    });
    expect((await get(`/fhir/r4/Patient/not-a-uuid`, t)).statusCode).toBe(404);
    // The kill switch takes effect on the next request.
    Object.assign(client, { active: false });
    expect((await get(`/fhir/r4/Patient/${PATIENT}`, t)).statusCode).toBe(403);
    Object.assign(client, { active: true });
    // Tokens expire after 5 minutes.
    advance(301_000);
    expect((await get(`/fhir/r4/Patient/${PATIENT}`, t)).statusCode).toBe(401);
  });
});

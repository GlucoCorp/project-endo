import { describe, expect, it } from 'vitest';
import { createHash, randomBytes } from 'node:crypto';
import { uuidv7 } from '@endo/domain';
import {
  ServiceTokenSigner,
  WorkloadTokenSigner,
  WorkloadTokenVerifier,
  generateServiceKeyPair,
} from '@endo/service-kit';
import { buildBff } from './app.ts';
import { DevSessionStore, readCookie } from './sessions.ts';
import { ENROLMENT_COOKIE } from './enrolment.ts';

const ORIGIN = 'https://app.endo.test';
const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');
const linkToken = () => randomBytes(32).toString('base64url');

/** A fake identity service: one transaction per (token hash, binding hash), as the real one. */
function fakeIdentity() {
  const byBinding = new Map<string, { id: string; status: string }>();
  const knownTokens = new Set<string>();
  const seen: { path: string; body: Record<string, string>; auth: string | null }[] = [];
  const later = new Date(Date.now() + 60 * 60_000).toISOString();
  let next: Response | null = null;
  const view = (id: string, status: string) => ({
    transaction_id: id,
    status,
    expired: false,
    state_deadline: later,
    expires_at: later,
  });
  const json = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  const fetchImpl = ((input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) =>
    Promise.resolve(answer(input, init))) as typeof fetch;
  function answer(input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) {
    // The BFF always passes a URL object and a JSON string body.
    const url = input as URL;
    const body = JSON.parse(init?.body as string) as Record<string, string>;
    const headers = new Headers(init?.headers);
    seen.push({ path: url.pathname, body, auth: headers.get('authorization') });
    if (next) {
      const r = next;
      next = null;
      return r;
    }
    if (url.pathname === '/internal/v1/enrolment/transactions') {
      if (!knownTokens.has(body['token_hash']!)) return json(404, {});
      const open = byBinding.get(body['binding_hash']!);
      if (open) return json(200, view(open.id, open.status));
      const id = uuidv7();
      byBinding.set(body['binding_hash']!, { id, status: 'awaiting-confirmation' });
      return json(201, { ...view(id, 'awaiting-confirmation'), code: '123456' });
    }
    const m = /^\/internal\/v1\/enrolment\/transactions\/([^/]+)\/(status|cancel)$/.exec(
      url.pathname,
    );
    const tx = [...byBinding.entries()].find(
      ([b, t]) => t.id === m?.[1] && b === body['binding_hash'],
    );
    if (!m || !tx) return json(404, {});
    if (m[2] === 'cancel') tx[1].status = 'cancelling';
    return json(200, view(tx[1].id, tx[1].status));
  }
  return {
    fetchImpl,
    seen,
    knownTokens,
    failNext: (r: Response) => (next = r),
  };
}

async function setup(startsPerMinute = 20) {
  const identity = fakeIdentity();
  const service = await generateServiceKeyPair();
  const workload = await generateServiceKeyPair();
  const logs: string[] = [];
  const app = await buildBff({
    logLevel: 'info',
    sessions: new DevSessionStore('test'),
    signer: new ServiceTokenSigner(service.privateJwk, 'bff-patient'),
    apiBaseUrl: 'http://api.internal',
    fetch: identity.fetchImpl,
    logStream: { write: (m: string) => logs.push(m) },
    enrolment: {
      identityBaseUrl: 'http://identity.internal',
      signer: new WorkloadTokenSigner(workload.privateJwk, 'bff-patient'),
      patientOrigin: ORIGIN,
      fetch: identity.fetchImpl,
      now: () => new Date(),
      startsPerMinute,
    },
  });
  const verifier = new WorkloadTokenVerifier('identity', {
    'bff-patient': { publicJwk: workload.publicJwk, scopes: ['identity.enrolment.patient'] },
  });
  const post = (url: string, payload: object, headers: Record<string, string> = {}) =>
    app.inject({
      method: 'POST',
      url,
      headers: { origin: ORIGIN, 'content-type': 'application/json', ...headers },
      payload: JSON.stringify(payload),
    });
  const cookieFrom = (res: { headers: Record<string, string | string[] | number | undefined> }) => {
    const raw = res.headers['set-cookie'];
    const set = typeof raw === 'string' ? raw : '';
    return { header: set, value: readCookie(set.split(';')[0], ENROLMENT_COOKIE) };
  };
  return { app, identity, verifier, logs, post, cookieFrom };
}

describe('REQ-001, RISK-S05 ADR-0021 section 4: patient enrolment in the BFF', () => {
  it('starts with the link token, binds the browser by cookie, and shows the code once', async () => {
    const { identity, verifier, post, cookieFrom, app } = await setup();
    const token = linkToken();
    identity.knownTokens.add(sha256(token));

    const res = await post('/v1/enrolment/start', { token });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ status: 'awaiting-confirmation', code: '123456' });
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.headers['referrer-policy']).toBe('no-referrer');
    const { header, value } = cookieFrom(res);
    expect(header).toMatch(
      /^__Host-endo_enrolment=[^;]+; Path=\/; Secure; HttpOnly; SameSite=Lax; Max-Age=\d+$/,
    );
    const maxAge = Number(/Max-Age=(\d+)/.exec(header)?.[1]);
    expect(maxAge).toBeGreaterThan(59 * 60);
    expect(maxAge).toBeLessThanOrEqual(60 * 60);

    // Identity receives hashes only, with a workload token for exactly its scope.
    const call = identity.seen[0]!;
    expect(Object.keys(call.body).sort()).toEqual(['binding_hash', 'token_hash']);
    expect(call.body['token_hash']).toBe(sha256(token));
    const secret = value!.slice(36);
    expect(call.body['binding_hash']).toBe(sha256(secret));
    expect(JSON.stringify(identity.seen)).not.toContain(token);
    expect(JSON.stringify(identity.seen)).not.toContain(secret);
    expect(await verifier.verifyHeader(call.auth ?? undefined)).toMatchObject({
      service: 'bff-patient',
      scopes: ['identity.enrolment.patient'],
    });

    // The same browser starting again: the same transaction, no code.
    const again = await post(
      '/v1/enrolment/start',
      { token },
      { cookie: `${ENROLMENT_COOKIE}=${value!}` },
    );
    expect(again.statusCode).toBe(200);
    expect(again.json()).not.toHaveProperty('code');
    expect(cookieFrom(again).value).toBe(value);

    // Status with the cookie: never a code.
    const status = await app.inject({
      url: '/v1/enrolment/status',
      headers: { cookie: `${ENROLMENT_COOKIE}=${value!}` },
    });
    expect(status.statusCode).toBe(200);
    const shown = status.json<Record<string, unknown>>();
    expect(Object.keys(shown).sort()).toEqual([
      'expired',
      'expires_at',
      'state_deadline',
      'status',
    ]);
    expect(shown).toMatchObject({ status: 'awaiting-confirmation', expired: false });
  });

  it('refuses a cross-site or non-JSON start, and never contacts identity for it', async () => {
    const { identity, post, app } = await setup();
    const token = linkToken();
    identity.knownTokens.add(sha256(token));
    expect(
      (await post('/v1/enrolment/start', { token }, { origin: 'https://evil.test' })).statusCode,
    ).toBe(403);
    const noOrigin = await app.inject({
      method: 'POST',
      url: '/v1/enrolment/start',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ token }),
    });
    expect(noOrigin.statusCode).toBe(403);
    const form = await app.inject({
      method: 'POST',
      url: '/v1/enrolment/start',
      headers: { origin: ORIGIN, 'content-type': 'application/x-www-form-urlencoded' },
      payload: `token=${token}`,
    });
    expect(form.statusCode).toBeGreaterThanOrEqual(400);
    // Opening the link (a GET) starts nothing.
    expect((await app.inject({ url: '/v1/enrolment/start' })).statusCode).toBe(404);
    expect(identity.seen).toHaveLength(0);
  });

  it('answers a bad link and a malformed token alike, and maps refusals safely', async () => {
    const { identity, post } = await setup();
    const unknown = await post('/v1/enrolment/start', { token: linkToken() });
    expect(unknown.statusCode).toBe(404);
    expect((await post('/v1/enrolment/start', { token: 'short' })).statusCode).toBe(400);
    const token = linkToken();
    identity.knownTokens.add(sha256(token));
    identity.failNext(
      new Response(JSON.stringify({ type: 'https://errors.glucorp.health/enrolment.locked' }), {
        status: 409,
      }),
    );
    const locked = await post('/v1/enrolment/start', { token });
    expect(locked.statusCode).toBe(409);
    expect(locked.json()).toMatchObject({ type: 'https://errors.glucorp.health/enrolment.locked' });
    identity.failNext(new Response('{}', { status: 409 }));
    expect((await post('/v1/enrolment/start', { token })).json()).toMatchObject({
      type: 'https://errors.glucorp.health/enrolment.unavailable',
    });
    // Upstream trouble, or an answer that does not fit, is a 502; never passed through.
    identity.failNext(new Response('{}', { status: 500 }));
    expect((await post('/v1/enrolment/start', { token })).statusCode).toBe(502);
    identity.failNext(new Response(JSON.stringify({ status: 'x' }), { status: 201 }));
    expect((await post('/v1/enrolment/start', { token })).statusCode).toBe(502);
  });

  it('needs the cookie for status and cancel, and cancel clears it', async () => {
    const { identity, post, app, cookieFrom } = await setup();
    expect((await app.inject({ url: '/v1/enrolment/status' })).statusCode).toBe(404);
    const forged = `${ENROLMENT_COOKIE}=${uuidv7()}${randomBytes(32).toString('base64url')}`;
    expect(
      (await app.inject({ url: '/v1/enrolment/status', headers: { cookie: forged } })).statusCode,
    ).toBe(404);
    expect(
      (
        await app.inject({
          url: '/v1/enrolment/status',
          headers: { cookie: `${ENROLMENT_COOKIE}=junk` },
        })
      ).statusCode,
    ).toBe(404);

    const token = linkToken();
    identity.knownTokens.add(sha256(token));
    const { value } = cookieFrom(await post('/v1/enrolment/start', { token }));
    const cookie = `${ENROLMENT_COOKIE}=${value!}`;
    // Cancel is a state change: cross-site is refused.
    expect(
      (await post('/v1/enrolment/cancel', {}, { cookie, origin: 'https://evil.test' })).statusCode,
    ).toBe(403);
    const cancelled = await post('/v1/enrolment/cancel', {}, { cookie });
    expect(cancelled.statusCode).toBe(200);
    expect(cancelled.json()).toMatchObject({ status: 'cancelling' });
    expect(cookieFrom(cancelled).header).toMatch(/^__Host-endo_enrolment=; .*Max-Age=0$/);
  });

  it('maps cancel refusals and an unreachable identity service safely', async () => {
    const { identity, post, cookieFrom, app } = await setup();
    const token = linkToken();
    identity.knownTokens.add(sha256(token));
    const { value } = cookieFrom(await post('/v1/enrolment/start', { token }));
    const cookie = `${ENROLMENT_COOKIE}=${value!}`;

    identity.failNext(new Response('{}', { status: 409 }));
    const late = await post('/v1/enrolment/cancel', {}, { cookie });
    expect(late.statusCode).toBe(409);
    expect(late.json()).toMatchObject({
      type: 'https://errors.glucorp.health/enrolment.cannot_cancel',
    });

    identity.failNext(new Response('{}', { status: 500 }));
    expect((await post('/v1/enrolment/cancel', {}, { cookie })).statusCode).toBe(502);
    identity.failNext(new Response('{}', { status: 500 }));
    expect(
      (await app.inject({ url: '/v1/enrolment/status', headers: { cookie } })).statusCode,
    ).toBe(502);

    // Not hers (any longer): the cookie is cleared.
    identity.failNext(new Response('{}', { status: 404 }));
    const gone = await post('/v1/enrolment/cancel', {}, { cookie });
    expect(gone.statusCode).toBe(404);
    expect(cookieFrom(gone).header).toMatch(/Max-Age=0$/);

    // A JSON body declared under another type is refused before identity is called.
    const before = identity.seen.length;
    const textJson = await app.inject({
      method: 'POST',
      url: '/v1/enrolment/cancel',
      headers: { origin: ORIGIN, 'content-type': 'text/plain', cookie },
      payload: '{}',
    });
    expect(textJson.statusCode).toBe(415);
    expect(identity.seen.length).toBe(before);
  });

  it('answers 502 when the identity service cannot be reached', async () => {
    const keys = await generateServiceKeyPair();
    const workload = await generateServiceKeyPair();
    const app = await buildBff({
      logLevel: 'silent',
      sessions: new DevSessionStore('test'),
      signer: new ServiceTokenSigner(keys.privateJwk, 'bff-patient'),
      apiBaseUrl: 'http://api.internal',
      fetch: () => Promise.reject(new TypeError('fetch failed')),
      enrolment: {
        identityBaseUrl: 'http://identity.internal',
        signer: new WorkloadTokenSigner(workload.privateJwk, 'bff-patient'),
        patientOrigin: ORIGIN,
        fetch: () => Promise.reject(new TypeError('fetch failed')),
        now: () => new Date(),
      },
    });
    const res = await app.inject({
      method: 'POST',
      url: '/v1/enrolment/start',
      headers: { origin: ORIGIN, 'content-type': 'application/json' },
      payload: JSON.stringify({ token: linkToken() }),
    });
    expect(res.statusCode).toBe(502);
  });

  it('cannot tell two first Starts without a cookie from two browsers (the page serialises them)', async () => {
    // ADR-0021 section 4 landing-page requirement: without a cookie the BFF sees two browsers,
    // so both get a transaction and the browser keeps the last cookie. With the page holding a
    // Web Lock, the second Start carries the first one's cookie and gets the same transaction.
    const { identity, post, cookieFrom } = await setup();
    const token = linkToken();
    identity.knownTokens.add(sha256(token));
    const [a, b] = await Promise.all([
      post('/v1/enrolment/start', { token }),
      post('/v1/enrolment/start', { token }),
    ]);
    expect([a.statusCode, b.statusCode]).toEqual([201, 201]);
    expect(cookieFrom(a).value).not.toBe(cookieFrom(b).value);

    const serialised = await post(
      '/v1/enrolment/start',
      { token },
      { cookie: `${ENROLMENT_COOKIE}=${cookieFrom(a).value!}` },
    );
    expect(serialised.statusCode).toBe(200);
    expect(serialised.json()).not.toHaveProperty('code');
  });

  it('limits starts per client', async () => {
    const { post } = await setup(5);
    const codes: number[] = [];
    for (let i = 0; i < 7; i++)
      codes.push((await post('/v1/enrolment/start', { token: linkToken() })).statusCode);
    expect(codes.slice(0, 5).every((c) => c === 404)).toBe(true);
    expect(codes.slice(5)).toEqual([429, 429]);
  });

  it('never logs the link token, the secret or the code', async () => {
    const { identity, post, logs, cookieFrom } = await setup();
    const token = `${linkToken().slice(0, 23)}SYNTHETIC_PHI_MARKER`;
    expect(token).toHaveLength(43);
    identity.knownTokens.add(sha256(token));
    const res = await post('/v1/enrolment/start', { token });
    const secret = cookieFrom(res).value!.slice(36);
    const text = logs.join('');
    expect(text).not.toContain('SYNTHETIC_PHI_MARKER');
    expect(text).not.toContain(secret);
    expect(text).not.toContain('123456');
  });

  it('does not exist without its configuration (fail closed)', async () => {
    const keys = await generateServiceKeyPair();
    const app = await buildBff({
      logLevel: 'silent',
      sessions: new DevSessionStore('test'),
      signer: new ServiceTokenSigner(keys.privateJwk, 'bff-patient'),
      apiBaseUrl: 'http://api.internal',
      fetch: () => Promise.reject(new Error('unused')),
    });
    const res = await app.inject({
      method: 'POST',
      url: '/v1/enrolment/start',
      headers: { origin: ORIGIN, 'content-type': 'application/json' },
      payload: JSON.stringify({ token: linkToken() }),
    });
    expect(res.statusCode).toBe(404);
  });
});

import { describe, expect, it } from 'vitest';
import { uuidv7 } from '@endo/domain';
import {
  RouteDeclarationError,
  ServiceTokenSigner,
  generateServiceKeyPair,
  type ServiceClaims,
} from '@endo/service-kit';
import { buildBff, createBffInstance, isBffAuth, type BffDeps } from './app.ts';
import {
  DevSessionStore,
  PATIENT_ABSOLUTE_MS,
  PATIENT_IDLE_MS,
  SESSION_COOKIE,
  readCookie,
} from './sessions.ts';

const claims = (): ServiceClaims => ({
  sub: uuidv7(),
  role: 'patient',
  org_id: null,
  patient_id: uuidv7(),
});

async function deps(
  fetchImpl: typeof fetch,
  sessions = new DevSessionStore('test'),
): Promise<BffDeps> {
  const keys = await generateServiceKeyPair();
  return {
    logLevel: 'silent',
    sessions,
    signer: new ServiceTokenSigner(keys.privateJwk, 'bff-patient'),
    apiBaseUrl: 'http://api.internal',
    fetch: fetchImpl,
    upstreamTimeoutMs: 50,
  };
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('session handling (spec 10.1, RISK-S02)', () => {
  it('requires a session cookie', async () => {
    const app = await buildBff(await deps(() => Promise.resolve(json(200, {}))));
    const res = await app.inject({ url: '/v1/hello' });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toMatchObject({
      type: 'https://errors.glucorp.health/authn.session_required',
    });
  });

  it('rejects an unknown session token', async () => {
    const app = await buildBff(await deps(() => Promise.resolve(json(200, {}))));
    const res = await app.inject({
      url: '/v1/hello',
      headers: { cookie: `${SESSION_COOKIE}=${'a'.repeat(43)}` },
    });
    expect(res.statusCode).toBe(401);
  });

  it('expires after 30 minutes idle', async () => {
    let t = 0;
    const store = new DevSessionStore('test', () => t);
    const token = store.create(claims());
    t = PATIENT_IDLE_MS - 1;
    expect(await store.resolve(token)).not.toBeNull();
    t += PATIENT_IDLE_MS + 1;
    expect(await store.resolve(token)).toBeNull();
  });

  it('expires after 12 hours even when active', async () => {
    let t = 0;
    const store = new DevSessionStore('test', () => t);
    const token = store.create(claims());
    while (t < PATIENT_ABSOLUTE_MS - PATIENT_IDLE_MS) {
      t += PATIENT_IDLE_MS - 1;
      expect(await store.resolve(token)).not.toBeNull();
    }
    t = PATIENT_ABSOLUTE_MS + 1;
    expect(await store.resolve(token)).toBeNull();
  });

  it('revokes sessions', async () => {
    const store = new DevSessionStore('test');
    const token = store.create(claims());
    await store.revoke(token);
    expect(await store.resolve(token)).toBeNull();
  });

  it.each(['staging', 'production'] as const)('dev sessions are refused in %s', (env) => {
    expect(() => new DevSessionStore(env)).toThrow(/not allowed/);
  });

  it.each([
    [undefined, null],
    ['', null],
    [`${SESSION_COOKIE}=short`, null],
    [`${SESSION_COOKIE}=${'a'.repeat(40)}; ${SESSION_COOKIE}=${'b'.repeat(40)}`, null], // cookie tossing
    [`other=1; ${SESSION_COOKIE}=${'a'.repeat(40)}`, 'a'.repeat(40)],
    [`${SESSION_COOKIE}=${'a'.repeat(40)};x`, 'a'.repeat(40)],
    [`${SESSION_COOKIE}=<script>${'a'.repeat(40)}`, null],
  ])('readCookie(%j)', (header, expected) => {
    expect(readCookie(header, SESSION_COOKIE)).toBe(expected);
  });
});

describe('upstream handling (spec 12.3)', () => {
  async function call(fetchImpl: typeof fetch) {
    const d = await deps(fetchImpl);
    const token = (d.sessions as DevSessionStore).create(claims());
    const app = await buildBff(d);
    return app.inject({ url: '/v1/hello', headers: { cookie: `${SESSION_COOKIE}=${token}` } });
  }

  it('sends a bearer service token and request id to the API', async () => {
    let seen: Headers | undefined;
    const res = await call((_url, init) => {
      seen = new Headers(init?.headers);
      return Promise.resolve(json(200, { message: 'hello', role: 'patient', request_id: 'r' }));
    });
    expect(res.statusCode).toBe(200);
    expect(seen?.get('authorization')).toMatch(/^Bearer ey/);
    expect(seen?.get('x-request-id')).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('maps network failures and timeouts to 502', async () => {
    const res = await call(() => Promise.reject(new Error('ECONNREFUSED')));
    expect(res.statusCode).toBe(502);
    expect(res.body).not.toContain('ECONNREFUSED');
  });

  it('maps upstream 401 without forwarding its body', async () => {
    const res = await call(() => Promise.resolve(json(401, { detail: 'SYNTHETIC_PHI_MARKER' })));
    expect(res.statusCode).toBe(401);
    expect(res.body).not.toContain('SYNTHETIC_PHI_MARKER');
  });

  it('rejects unexpected upstream shapes and errors', async () => {
    expect(
      (
        await call(() =>
          Promise.resolve(json(200, { message: 'x', extra: 'SYNTHETIC_PHI_MARKER' })),
        )
      ).statusCode,
    ).toBe(502);
    expect((await call(() => Promise.resolve(json(500, {})))).statusCode).toBe(502);
  });

  it('ignores a client-supplied request id', async () => {
    const spoofed = '01900000-0000-7000-8000-000000000001';
    let forwarded: string | null = null;
    const d = await deps((_url, init) => {
      forwarded = new Headers(init?.headers).get('x-request-id');
      return Promise.resolve(json(200, { message: 'hello', role: 'patient', request_id: 'r' }));
    });
    const token = (d.sessions as DevSessionStore).create(claims());
    const app = await buildBff(d);
    const res = await app.inject({
      url: '/v1/hello',
      headers: { cookie: `${SESSION_COOKIE}=${token}`, 'x-request-id': spoofed },
    });
    expect(res.statusCode).toBe(200);
    expect(forwarded).toMatch(/^[0-9a-f-]{36}$/);
    expect(forwarded).not.toBe(spoofed);
  });
});

describe('RISK-D01 rate limiting (spec 12.3)', () => {
  it('limits per client IP before session lookup and answers with a problem', async () => {
    let lookups = 0;
    const sessions = {
      resolve: () => {
        lookups++;
        return Promise.resolve(null);
      },
      revoke: () => Promise.resolve(),
      setAppLock: () => Promise.resolve(false),
      lock: () => Promise.resolve(),
    };
    const d = {
      ...(await deps(() => Promise.resolve(json(200, {})))),
      sessions,
      rateLimitPerMinute: 2,
    };
    const app = await buildBff(d);
    const cookie = `${SESSION_COOKIE}=${'a'.repeat(43)}`;
    const codes: number[] = [];
    for (let i = 0; i < 3; i++)
      codes.push((await app.inject({ url: '/v1/hello', headers: { cookie } })).statusCode);
    expect(codes).toEqual([401, 401, 429]);
    expect(lookups).toBe(2);
    const res = await app.inject({ url: '/v1/hello', headers: { cookie } });
    expect(res.json()).toMatchObject({
      type: 'https://errors.glucorp.health/rate_limited',
      status: 429,
    });
    // Throttled responses still carry the spec 12.2 headers.
    expect(res.headers['content-security-policy']).toContain("frame-ancestors 'none'");
  });

  it('does not limit liveness probes', async () => {
    const app = await buildBff({
      ...(await deps(() => Promise.resolve(json(200, {})))),
      rateLimitPerMinute: 1,
    });
    for (let i = 0; i < 3; i++)
      expect((await app.inject({ url: '/healthz' })).statusCode).toBe(200);
  });
});

describe('spec 12.7 security.txt', () => {
  it('serves the configured contact, or nothing at all', async () => {
    const base = await deps(() => Promise.resolve(json(200, {})));
    const none = await buildBff(base);
    expect((await none.inject({ url: '/.well-known/security.txt' })).statusCode).toBe(404);
    const app = await buildBff({
      ...base,
      securityContact: { contact: 'mailto:security@example.test', policy: null },
    });
    const res = await app.inject({ url: '/.well-known/security.txt' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/plain');
    expect(res.body).toContain('Contact: mailto:security@example.test');
    expect(res.body).toMatch(/Expires: \d{4}-/);
  });
});

describe('route declarations (spec 2.5)', () => {
  it.each([undefined, { kind: 'public', reason: 'x' }, { kind: 'nope' }, 'session'])(
    'rejects auth %j',
    async (auth) => {
      const app = await createBffInstance(await deps(() => Promise.resolve(json(200, {}))));
      expect(() => app.get('/v1/x', { config: { auth } as never }, () => 'x')).toThrow(
        RouteDeclarationError,
      );
      expect(isBffAuth(auth)).toBe(false);
    },
  );
});

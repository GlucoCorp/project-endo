import { describe, expect, it } from 'vitest';
import Fastify from 'fastify';
import { SignJWT, importJWK } from 'jose';
import {
  API_SECURITY_HEADERS,
  ProblemError,
  RouteDeclarationError,
  ServiceTokenSigner,
  ServiceTokenVerifier,
  WEB_SECURITY_HEADERS,
  enforceRouteDeclarations,
  filterLogFields,
  generateServiceKeyPair,
  loggerOptions,
  registerProblemHandlers,
  requestIdFrom,
  type ServiceClaims,
} from './index.ts';

const claims: ServiceClaims = {
  sub: '01900000-0000-7000-8000-000000000001',
  role: 'patient',
  org_id: null,
  patient_id: '01900000-0000-7000-8000-0000000000c1',
};

describe('service tokens (ADR-0006, RISK-S01)', () => {
  it('round-trips claims for the right audience and issuer', async () => {
    const { privateJwk, publicJwk } = await generateServiceKeyPair();
    const token = await new ServiceTokenSigner(privateJwk, 'bff-patient').sign(claims, 'api');
    const v = new ServiceTokenVerifier('api', {
      'bff-patient': { publicJwk: publicJwk, roles: ['patient'] },
    });
    await expect(v.verifyHeader(`Bearer ${token}`)).resolves.toEqual({
      ...claims,
      iss: 'bff-patient',
    });
  });

  it.each([
    ['missing header', undefined, 'authn.missing'],
    ['not bearer', 'Basic abc', 'authn.invalid'],
    ['garbage', 'Bearer a.b.c', 'authn.invalid'],
  ])('rejects %s', async (_l, header, code) => {
    const { publicJwk } = await generateServiceKeyPair();
    const v = new ServiceTokenVerifier('api', {
      'bff-patient': { publicJwk: publicJwk, roles: ['patient'] },
    });
    await expect(v.verifyHeader(header)).rejects.toMatchObject({ code });
  });

  it('rejects the wrong audience', async () => {
    const { privateJwk, publicJwk } = await generateServiceKeyPair();
    const token = await new ServiceTokenSigner(privateJwk, 'bff-patient').sign(
      claims,
      'identity' as never,
    );
    const v = new ServiceTokenVerifier('api', {
      'bff-patient': { publicJwk: publicJwk, roles: ['patient'] },
    });
    await expect(v.verifyHeader(`Bearer ${token}`)).rejects.toMatchObject({
      code: 'authn.invalid',
    });
  });

  it('rejects an issuer that is not allowlisted', async () => {
    const { privateJwk, publicJwk } = await generateServiceKeyPair();
    const token = await new ServiceTokenSigner(privateJwk, 'bff-clinic').sign(claims, 'api');
    const v = new ServiceTokenVerifier('api', {
      'bff-patient': { publicJwk: publicJwk, roles: ['patient'] },
    });
    await expect(v.verifyHeader(`Bearer ${token}`)).rejects.toMatchObject({
      code: 'authn.invalid',
    });
  });

  it('rejects a token signed by another key', async () => {
    const a = await generateServiceKeyPair();
    const b = await generateServiceKeyPair();
    const token = await new ServiceTokenSigner(a.privateJwk, 'bff-patient').sign(claims, 'api');
    const v = new ServiceTokenVerifier('api', {
      'bff-patient': { publicJwk: b.publicJwk, roles: ['patient'] },
    });
    await expect(v.verifyHeader(`Bearer ${token}`)).rejects.toMatchObject({
      code: 'authn.invalid',
    });
  });

  it('RISK-S03 rejects a role the issuer may not vouch for', async () => {
    const { privateJwk, publicJwk } = await generateServiceKeyPair();
    const token = await new ServiceTokenSigner(privateJwk, 'bff-patient').sign(
      { ...claims, role: 'clinician', org_id: claims.patient_id, patient_id: null },
      'api',
    );
    const v = new ServiceTokenVerifier('api', {
      'bff-patient': { publicJwk, roles: ['patient'] },
    });
    await expect(v.verifyHeader(`Bearer ${token}`)).rejects.toMatchObject({
      code: 'authn.invalid',
    });
  });

  it('RISK-S03 does not accept one issuer posing as another: each issuer has its own key', async () => {
    const patient = await generateServiceKeyPair();
    const clinic = await generateServiceKeyPair();
    // Signed with the patient BFF's key but claiming to come from the clinic BFF.
    const forged = await new ServiceTokenSigner(patient.privateJwk, 'bff-clinic').sign(
      { ...claims, role: 'clinician', org_id: claims.patient_id, patient_id: null },
      'api',
    );
    const v = new ServiceTokenVerifier('api', {
      'bff-patient': { publicJwk: patient.publicJwk, roles: ['patient'] },
      'bff-clinic': { publicJwk: clinic.publicJwk, roles: ['clinician'] },
    });
    await expect(v.verifyHeader(`Bearer ${forged}`)).rejects.toMatchObject({
      code: 'authn.invalid',
    });
  });

  it('rejects an expired token (60 s lifetime)', async () => {
    const { privateJwk, publicJwk } = await generateServiceKeyPair();
    const t0 = new Date('2026-11-07T12:00:00Z');
    const token = await new ServiceTokenSigner(privateJwk, 'bff-patient', () => t0).sign(
      claims,
      'api',
    );
    const later = new Date(t0.getTime() + 66_000);
    const v = new ServiceTokenVerifier(
      'api',
      {
        'bff-patient': { publicJwk: publicJwk, roles: ['patient'] },
      },
      () => later,
    );
    await expect(v.verifyHeader(`Bearer ${token}`)).rejects.toMatchObject({
      code: 'authn.invalid',
    });
  });

  it('rejects tokens without our typ header (token confusion)', async () => {
    const { privateJwk, publicJwk } = await generateServiceKeyPair();
    const key = await importJWK(privateJwk, 'EdDSA');
    const token = await new SignJWT({ role: 'patient', org_id: null, patient_id: null })
      .setProtectedHeader({ alg: 'EdDSA' })
      .setIssuer('bff-patient')
      .setAudience('api')
      .setSubject(claims.sub)
      .setIssuedAt()
      .setExpirationTime('60s')
      .setJti('x')
      .sign(key);
    const v = new ServiceTokenVerifier('api', {
      'bff-patient': { publicJwk: publicJwk, roles: ['patient'] },
    });
    await expect(v.verifyHeader(`Bearer ${token}`)).rejects.toMatchObject({
      code: 'authn.invalid',
    });
  });

  it('refuses to sign invalid claims', async () => {
    const { privateJwk } = await generateServiceKeyPair();
    const s = new ServiceTokenSigner(privateJwk, 'bff-patient');
    await expect(s.sign({ ...claims, role: 'root' as never }, 'api')).rejects.toThrow();
  });
});

describe('log allowlist (spec 20, RISK-I02)', () => {
  it('drops fields that are not allowlisted and non-scalar values', () => {
    expect(
      filterLogFields({
        reqId: 'r1',
        statusCode: 200,
        email: 'jane@example.com',
        body: { pain: 9 },
        route: { x: 1 },
        event: 'x'.repeat(500),
      }),
    ).toEqual({ reqId: 'r1', statusCode: 200, event: 'x'.repeat(128) });
  });

  it('never writes request URLs, headers or error messages', async () => {
    const lines: string[] = [];
    const app = Fastify({ logger: loggerOptions('test', 'info', { write: (l) => lines.push(l) }) });
    app.get('/p/:id', () => {
      throw new Error('SYNTHETIC_PHI_MARKER pain 9');
    });
    registerProblemHandlers(app);
    await app.inject({
      url: '/p/SYNTHETIC_PHI_MARKER?q=SYNTHETIC_PHI_MARKER',
      headers: { 'x-phi': 'SYNTHETIC_PHI_MARKER' },
    });
    app.log.info({ event: 'manual', patientName: 'SYNTHETIC_PHI_MARKER' });
    await app.close();
    expect(lines.length).toBeGreaterThan(0);
    for (const l of lines) expect(l).not.toContain('SYNTHETIC_PHI_MARKER');
  });
});

describe('problem details (RFC 9457, spec 9.1)', () => {
  async function app() {
    const a = Fastify();
    registerProblemHandlers(a);
    a.get('/problem', () => {
      throw new ProblemError(403, 'authz.no_consent', 'You do not have access.');
    });
    a.get('/boom', () => {
      throw new Error('secret SYNTHETIC_PHI_MARKER');
    });
    a.post('/v', { schema: { body: { type: 'object', required: ['a'] } } }, () => 'ok');
    a.get('/teapot', () => {
      throw Object.assign(new Error('x'), { statusCode: 418 });
    });
    await a.ready();
    return a;
  }

  it('maps ProblemError', async () => {
    const res = await (await app()).inject({ url: '/problem' });
    expect(res.statusCode).toBe(403);
    expect(res.headers['content-type']).toContain('application/problem+json');
    expect(res.json()).toMatchObject({
      type: 'https://errors.glucorp.health/authz.no_consent',
      status: 403,
    });
  });

  it('hides internal error messages', async () => {
    const res = await (await app()).inject({ url: '/boom' });
    expect(res.statusCode).toBe(500);
    expect(res.body).not.toContain('SYNTHETIC_PHI_MARKER');
  });

  it('does not echo invalid input', async () => {
    const res = await (
      await app()
    ).inject({ method: 'POST', url: '/v', payload: { pain: 'SYNTHETIC_PHI_MARKER' } });
    expect(res.statusCode).toBe(400);
    expect(res.body).not.toContain('SYNTHETIC_PHI_MARKER');
  });

  it('handles malformed JSON, oversized bodies, other 4xx and 404', async () => {
    const a = await app();
    const bad = await a.inject({
      method: 'POST',
      url: '/v',
      payload: '{nope',
      headers: { 'content-type': 'application/json' },
    });
    expect(bad.json()).toMatchObject({ status: 400 });
    const small = Fastify({ bodyLimit: 10 });
    registerProblemHandlers(small);
    small.post('/v', () => 'ok');
    const big = await small.inject({ method: 'POST', url: '/v', payload: { a: 'x'.repeat(100) } });
    expect(big.json()).toMatchObject({ status: 413 });
    expect((await a.inject({ url: '/teapot' })).json()).toMatchObject({ status: 418 });
    expect((await a.inject({ url: '/nowhere' })).json()).toMatchObject({ status: 404 });
  });
});

describe('route declarations (spec 2.5)', () => {
  const isPolicy = (v: unknown) => typeof v === 'string' && v.length > 0;

  it('refuses to register a route without a policy', () => {
    const app = Fastify();
    enforceRouteDeclarations(app, 'policy', isPolicy);
    expect(() => app.get('/open', () => 'x')).toThrow(RouteDeclarationError);
    expect(() =>
      app.route({ method: ['GET', 'POST'], url: '/m', config: { other: 1 }, handler: () => 'x' }),
    ).toThrow(/GET,POST \/m/);
  });

  it('accepts routes that declare one', async () => {
    const app = Fastify();
    enforceRouteDeclarations(app, 'policy', isPolicy);
    app.get('/ok', { config: { policy: 'system.hello' } }, () => 'x');
    await app.ready();
    expect((await app.inject({ url: '/ok' })).statusCode).toBe(200);
  });
});

describe('headers and request ids', () => {
  it('API responses are never cached', () => {
    expect(API_SECURITY_HEADERS['cache-control']).toBe('no-store');
  });

  it('web CSP matches spec 12.2', () => {
    const csp = WEB_SECURITY_HEADERS['content-security-policy'] ?? '';
    for (const d of [
      "default-src 'self'",
      "frame-ancestors 'none'",
      "object-src 'none'",
      "require-trusted-types-for 'script'",
    ]) {
      expect(csp).toContain(d);
    }
    expect(WEB_SECURITY_HEADERS['strict-transport-security']).toBe(
      'max-age=63072000; includeSubDomains; preload',
    );
  });

  it('accepts a UUID request id only from trusted callers', () => {
    const id = '01900000-0000-7000-8000-000000000001';
    expect(requestIdFrom(id, true)).toBe(id);
    expect(requestIdFrom(id, false)).not.toBe(id);
    expect(requestIdFrom('<script>', true)).not.toBe('<script>');
    expect(requestIdFrom([id], true)).not.toBe(id);
  });
});

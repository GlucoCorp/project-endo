import { describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import {
  WorkloadTokenSigner,
  WorkloadTokenVerifier,
  generateServiceKeyPair,
} from '@endo/service-kit';
import { ApiUnavailableError, HttpApi } from './api-client.ts';
import {
  AccessTokens,
  AuthError,
  grantScopes,
  verifyClientAssertion,
  type Client,
} from './smart.ts';

describe('M7 HttpApi: the integration service asks the API with its own key', () => {
  async function make(respond: (path: string) => Response | Promise<Response>) {
    const keys = await generateServiceKeyPair();
    const verifier = new WorkloadTokenVerifier('api', {
      integration: {
        publicJwk: keys.publicJwk,
        scopes: ['api.integration.resolve', 'api.fhir.read'],
      },
    });
    const seen: { path: string; scopes: readonly string[]; body: unknown }[] = [];
    const api = new HttpApi({
      apiBaseUrl: 'https://api.test',
      signer: new WorkloadTokenSigner(keys.privateJwk, 'integration'),
      fetch: (async (url: URL, init?: RequestInit) => {
        const caller = await verifier.verifyHeader(
          new Headers(init?.headers).get('authorization') ?? undefined,
        );
        seen.push({
          path: url.pathname,
          scopes: caller.scopes,
          body: JSON.parse(init?.body as string),
        });
        return respond(url.pathname);
      }) as unknown as typeof fetch,
    });
    return { api, seen };
  }
  const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });

  it('resolves a client with api.integration.resolve; unknown is null; errors fail closed', async () => {
    const answers = [
      json(200, { id: 'i', org_id: 'o', jwks: { keys: [] }, scopes: ['s'], active: true }),
      json(404, {}),
      json(500, {}),
    ];
    const { api, seen } = await make(() => answers.shift() ?? json(500, {}));
    expect(await api.resolveClient('c'.repeat(24))).toEqual({
      id: 'i',
      orgId: 'o',
      jwks: { keys: [] },
      scopes: ['s'],
      active: true,
    });
    expect(seen[0]).toMatchObject({
      path: '/internal/v1/integration/clients/resolve',
      scopes: ['api.integration.resolve'],
    });
    expect(await api.resolveClient('c'.repeat(24))).toBeNull();
    await expect(api.resolveClient('c'.repeat(24))).rejects.toBeInstanceOf(ApiUnavailableError);
  });

  it('reserves an assertion id through the API; anything unexpected fails closed', async () => {
    const answers = [
      json(200, { first_use: true }),
      json(200, { first_use: false }),
      json(500, {}),
    ];
    const { api, seen } = await make(() => answers.shift() ?? json(500, {}));
    const exp = new Date('2026-11-16T10:04:00Z');
    expect(await api.reserveAssertion('c'.repeat(24), 'j', exp)).toBe(true);
    expect(seen[0]).toMatchObject({
      path: '/internal/v1/integration/assertions/reserve',
      scopes: ['api.integration.resolve'],
      body: { client_id: 'c'.repeat(24), jti: 'j', expires_at: '2026-11-16T10:04:00.000Z' },
    });
    expect(await api.reserveAssertion('c'.repeat(24), 'j', exp)).toBe(false);
    await expect(api.reserveAssertion('c'.repeat(24), 'j', exp)).rejects.toBeInstanceOf(
      ApiUnavailableError,
    );
  });

  it('reads a patient with api.fhir.read; refused is null; errors and network fail closed', async () => {
    const answers: (Response | Error)[] = [
      json(200, { resourceType: 'Bundle' }),
      json(404, {}),
      json(403, {}),
      json(502, {}),
      new TypeError('network'),
    ];
    const { api, seen } = await make(() => {
      const a = answers.shift() ?? json(500, {});
      if (a instanceof Error) throw a;
      return a;
    });
    const read = () => api.patient('o', 'p', 'c');
    expect(await read()).toEqual({ resourceType: 'Bundle' });
    expect(seen[0]).toMatchObject({
      path: '/internal/v1/fhir/patient',
      scopes: ['api.fhir.read'],
      body: { org_id: 'o', patient_id: 'p', client_id: 'c' },
    });
    expect(await read()).toBeNull();
    expect(await read()).toBeNull();
    await expect(read()).rejects.toBeInstanceOf(ApiUnavailableError);
    await expect(read()).rejects.toBeInstanceOf(ApiUnavailableError);
  });
});

describe('M7 SMART helpers', () => {
  it('grants only registered scopes, and refuses none', () => {
    expect(grantScopes('a b', ['b'])).toEqual(['b']);
    expect(() => grantScopes('', ['b'])).toThrow(AuthError);
    expect(() => grantScopes('a', ['b'])).toThrow(AuthError);
  });

  it('expires access tokens after 5 minutes', () => {
    let t = 0;
    const tokens = new AccessTokens(() => t);
    const { token } = tokens.issue({ clientId: 'c', orgId: 'o', scopes: ['s'] });
    expect(tokens.find(token)?.clientId).toBe('c');
    expect(tokens.find('other')).toBeNull();
    const second = tokens.issue({ clientId: 'c', orgId: 'o', scopes: ['s'] }).token;
    t = 300_001;
    expect(tokens.find(token)).toBeNull();
    tokens.issue({ clientId: 'c', orgId: 'o', scopes: ['s'] }); // prunes the other expired one
    expect(tokens.find(second)).toBeNull();
  });

  it('refuses keys of the wrong kind and malformed assertions', async () => {
    const client: Client = {
      id: randomUUID(),
      orgId: 'o',
      jwks: { keys: [{ kty: 'EC', kid: 'k1', alg: 'ES256' }] },
      scopes: [],
      active: true,
    };
    const header = Buffer.from(JSON.stringify({ alg: 'ES256', kid: 'k1' })).toString('base64url');
    const seen = () => Promise.resolve(true);
    await expect(
      verifyClientAssertion(`${header}.e30.x`, 'c', client, 'https://t', seen, 0),
    ).rejects.toThrow(AuthError);
    await expect(
      verifyClientAssertion('nonsense', 'c', client, 'https://t', seen, 0),
    ).rejects.toThrow(AuthError);
  });
});

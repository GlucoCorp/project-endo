import { describe, expect, it } from 'vitest';
import {
  WorkloadTokenSigner,
  WorkloadTokenVerifier,
  generateServiceKeyPair,
} from '@endo/service-kit';
import { HttpResolver, ResolverError } from './resolve.ts';
import {
  CLINIC_ABSOLUTE_MS,
  CLINIC_IDLE_MS,
  InMemoryClinicSessions,
  readCookie,
  SESSION_COOKIE,
} from './sessions.ts';

const PERSON = '01900000-0000-7000-8000-0000000000e1';
const ORG = '01900000-0000-7000-8000-00000000000a';

describe('HttpResolver (ADR-0019 section 4)', () => {
  const make = async (respond: (url: string) => Response | Promise<Response>) => {
    const keys = await generateServiceKeyPair();
    const seen: { url: string; scopes: readonly string[] }[] = [];
    const verifiers = {
      identity: new WorkloadTokenVerifier('identity', {
        'bff-clinic': { publicJwk: keys.publicJwk, scopes: ['identity.subject.resolve'] },
      }),
      api: new WorkloadTokenVerifier('api', {
        'bff-clinic': { publicJwk: keys.publicJwk, scopes: ['api.membership.resolve'] },
      }),
    };
    const fetchStub = (async (url: string, init?: RequestInit) => {
      const auth = new Headers(init?.headers).get('authorization') ?? undefined;
      const target = url.startsWith('https://identity.test') ? verifiers.identity : verifiers.api;
      const caller = await target.verifyHeader(auth); // proves audience and scope per call
      seen.push({ url, scopes: caller.scopes });
      return respond(url);
    }) as typeof fetch;
    const resolver = new HttpResolver({
      identityBaseUrl: 'https://identity.test',
      apiBaseUrl: 'https://api.test',
      signer: new WorkloadTokenSigner(keys.privateJwk, 'bff-clinic'),
      fetch: fetchStub,
    });
    return { resolver, seen };
  };

  it('resolves a person and memberships, each call with its own audience and single scope', async () => {
    const { resolver, seen } = await make((url) =>
      url.endsWith('/subjects/resolve')
        ? Response.json({ person_id: PERSON })
        : Response.json({ memberships: [{ org_id: ORG, role: 'clinician' }] }),
    );
    expect(await resolver.person('iss', 'sub')).toBe(PERSON);
    expect(await resolver.memberships(PERSON)).toEqual([{ orgId: ORG, role: 'clinician' }]);
    expect(seen.map((s) => s.scopes)).toEqual([
      ['identity.subject.resolve'],
      ['api.membership.resolve'],
    ]);
  });

  it('maps 404 to an unknown person', async () => {
    const { resolver } = await make(() => new Response('{}', { status: 404 }));
    expect(await resolver.person('iss', 'sub')).toBeNull();
  });

  it.each([
    ['an upstream error', () => new Response('{}', { status: 500 })],
    ['a malformed body', () => Response.json({ person_id: 7, memberships: 'x' })],
    [
      'an unexpected role',
      () =>
        Response.json({
          person_id: PERSON,
          memberships: [{ org_id: ORG, role: 'glucorp_support' }],
        }),
    ],
  ])('fails closed on %s', async (_n, respond) => {
    const { resolver } = await make(respond);
    await expect(resolver.memberships(PERSON)).rejects.toBeInstanceOf(ResolverError);
    if (_n !== 'an unexpected role') {
      await expect(resolver.person('iss', 'sub')).rejects.toBeInstanceOf(ResolverError);
    }
  });

  it('fails closed when the network call itself fails', async () => {
    const resolver = new HttpResolver({
      identityBaseUrl: 'https://identity.test',
      apiBaseUrl: 'https://api.test',
      signer: new WorkloadTokenSigner((await generateServiceKeyPair()).privateJwk, 'bff-clinic'),
      fetch: () => Promise.reject(new Error('econnrefused')),
    });
    await expect(resolver.person('iss', 'sub')).rejects.toBeInstanceOf(ResolverError);
  });
});

describe('InMemoryClinicSessions (spec 10.2, ADR-0019 section 5)', () => {
  const base = {
    personId: PERSON,
    issuer: 'iss',
    subject: 'sub',
    sid: null,
    memberships: [{ orgId: ORG, role: 'clinician' as const }],
  };

  it('is refused in staging and production', () => {
    expect(() => new InMemoryClinicSessions('production')).toThrow(/not allowed/);
    expect(() => new InMemoryClinicSessions('staging')).toThrow(/not allowed/);
  });

  it('expires after 15 minutes idle', async () => {
    let t = 0;
    const s = new InMemoryClinicSessions('test', () => t);
    const token = await s.create(base);
    t = CLINIC_IDLE_MS - 1;
    expect(await s.resolve(token)).not.toBeNull(); // activity moves the idle clock
    t += CLINIC_IDLE_MS + 1;
    expect(await s.resolve(token)).toBeNull();
  });

  it('expires after 12 hours however active, and can be revoked', async () => {
    let t = 0;
    const s = new InMemoryClinicSessions('test', () => t);
    const token = await s.create(base);
    while (t < CLINIC_ABSOLUTE_MS) {
      t += CLINIC_IDLE_MS - 1;
      if (t <= CLINIC_ABSOLUTE_MS) expect(await s.resolve(token)).not.toBeNull();
    }
    expect(await s.resolve(token)).toBeNull();
    const other = await s.create(base);
    await s.revoke(other);
    expect(await s.resolve(other)).toBeNull();
    expect(await s.resolve('unknown')).toBeNull();
  });

  it('starts a multi-organisation session pending, and every session gets fresh secrets', async () => {
    const s = new InMemoryClinicSessions('test');
    const a = await s.create({
      ...base,
      memberships: [...base.memberships, { orgId: 'o2', role: 'org_admin' }],
    });
    const b = await s.create(base);
    expect(await s.resolve(a)).toMatchObject({ state: 'pending-org', active: null });
    expect(a).not.toBe(b);
    expect((await s.resolve(a))?.csrfToken).not.toBe((await s.resolve(b))?.csrfToken);
  });
});

describe('readCookie', () => {
  const v = 'a'.repeat(43);
  it('reads one well-formed cookie and refuses duplicates or junk (cookie tossing)', () => {
    expect(readCookie(`${SESSION_COOKIE}=${v}`, SESSION_COOKIE)).toBe(v);
    expect(readCookie(`${SESSION_COOKIE}=${v}; ${SESSION_COOKIE}=${v}`, SESSION_COOKIE)).toBeNull();
    expect(readCookie(`${SESSION_COOKIE}=short`, SESSION_COOKIE)).toBeNull();
    expect(readCookie(undefined, SESSION_COOKIE)).toBeNull();
  });
});

import { describe, expect, it } from 'vitest';
import {
  WorkloadTokenSigner,
  WorkloadTokenVerifier,
  generateServiceKeyPair,
} from '@endo/service-kit';
import { HttpResolver, ResolverError } from './resolve.ts';
import {
  MAX_PENDING_TRANSACTIONS,
  OidcError,
  TRANSACTION_TTL_MS,
  TransactionStore,
} from './oidc.ts';
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
        'bff-clinic': {
          publicJwk: keys.publicJwk,
          scopes: ['api.membership.resolve', 'api.staff.join'],
        },
      }),
    };
    const fetchStub = (async (url: string, init?: RequestInit) => {
      const auth = new Headers(init?.headers).get('authorization') ?? undefined;
      const target = new URL(url).host === 'identity.test' ? verifiers.identity : verifiers.api;
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

  it('REQ-010 claims a staff invitation with the api.staff.join scope', async () => {
    const statuses = [200, 404, 409, 500];
    const { resolver, seen } = await make(
      () => new Response('{}', { status: statuses.shift() ?? 500 }),
    );
    const hash = 'a'.repeat(64);
    expect(await resolver.claimStaff(hash, PERSON)).toBe('claimed');
    expect(seen[0]).toEqual({
      url: 'https://api.test/internal/v1/staff-invitations/claim',
      scopes: ['api.staff.join'],
    });
    expect(await resolver.claimStaff(hash, PERSON)).toBe('unavailable');
    expect(await resolver.claimStaff(hash, PERSON)).toBe('unavailable');
    await expect(resolver.claimStaff(hash, PERSON)).rejects.toBeInstanceOf(ResolverError);
  });

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
    idToken: 'id.token.x',
    refresh: { wrappedKey: 'w', envelope: 'e' },
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

describe('TransactionStore (ADR-0019 section 1)', () => {
  it('prunes expired attempts and refuses beyond its capacity', () => {
    let t = 0;
    const store = new TransactionStore(() => t);
    for (let i = 0; i < 3; i++) store.create('b');
    t = TRANSACTION_TTL_MS + 1;
    store.create('b'); // prunes the three expired ones first
    expect(store.size).toBe(1);
    for (let i = 1; i < MAX_PENDING_TRANSACTIONS; i++) store.create('b');
    expect(() => store.create('b')).toThrow(OidcError);
  });

  it('refuses an expired attempt and a missing binding or state', () => {
    let t = 0;
    const store = new TransactionStore(() => t);
    const tx = store.create('b');
    expect(() => store.consume(null, tx.state)).toThrow(OidcError);
    t = TRANSACTION_TTL_MS + 1;
    expect(() => store.consume('b', tx.state)).toThrow(OidcError);
  });
});

describe('background requests never extend the idle limit (ADR-0019 section 5)', () => {
  it('expires a session that only sees background checks', async () => {
    let t = 0;
    const s = new InMemoryClinicSessions('test', () => t);
    const token = await s.create({
      personId: PERSON,
      issuer: 'i',
      subject: 's',
      sid: null,
      idToken: 'id.token.x',
      refresh: { wrappedKey: 'w', envelope: 'e' },
      memberships: [],
    });
    for (let i = 0; i < 20; i++) {
      t += 60_000;
      if (t <= CLINIC_IDLE_MS) expect(await s.resolve(token, { touch: false })).not.toBeNull();
    }
    expect(await s.resolve(token, { touch: false })).toBeNull();
  });

  it('activation rotates the id and CSRF token and keeps the absolute deadline', async () => {
    const s = new InMemoryClinicSessions('test');
    const old = await s.create({
      personId: PERSON,
      issuer: 'i',
      subject: 's',
      sid: null,
      idToken: 'id.token.x',
      refresh: { wrappedKey: 'w', envelope: 'e' },
      memberships: [],
    });
    const before = await s.resolve(old);
    const next = await s.activate(old, { orgId: ORG, role: 'clinician' });
    expect(next).not.toBeNull();
    expect(await s.resolve(old)).toBeNull();
    const after = await s.resolve(next ?? '');
    expect(after?.csrfToken).not.toBe(before?.csrfToken);
    expect(after?.createdAt).toBe(before?.createdAt);
    expect(await s.activate('gone', { orgId: ORG, role: 'clinician' })).toBeNull();
  });
});

describe('activation respects expiry and background requests (Codex review, slice 5)', () => {
  const base = {
    personId: PERSON,
    issuer: 'i',
    subject: 's',
    sid: null,
    idToken: 'id.token.x',
    refresh: { wrappedKey: 'w', envelope: 'e' },
    memberships: [],
  };

  it('refuses to activate a session that went idle-expired meanwhile (e.g. during a slow lookup)', async () => {
    let t = 0;
    const s = new InMemoryClinicSessions('test', () => t);
    const token = await s.create(base);
    t = CLINIC_IDLE_MS + 1;
    expect(await s.activate(token, { orgId: ORG, role: 'clinician' })).toBeNull();
    expect(await s.resolve(token)).toBeNull();
  });

  it('a background activation rotates but does not extend the idle time', async () => {
    let t = 0;
    const s = new InMemoryClinicSessions('test', () => t);
    const token = await s.create(base);
    t = CLINIC_IDLE_MS - 1000;
    const next = await s.activate(token, { orgId: ORG, role: 'clinician' }, { touch: false });
    expect(next).not.toBeNull();
    t = CLINIC_IDLE_MS + 1;
    expect(await s.resolve(next ?? '', { touch: false })).toBeNull();
  });
});

describe('REQ-010 invitations pending per sign-in attempt', () => {
  it('gives each attempt its own, once, and forgets them when the attempt would expire', async () => {
    const { PendingJoins } = await import('./app.ts');
    let t = 0;
    const joins = new PendingJoins(() => t, 3);
    joins.add('s1', 'a'.repeat(64));
    expect(joins.take('s2')).toBeNull();
    expect(joins.take('s1')).toBe('a'.repeat(64));
    expect(joins.take('s1')).toBeNull();
    joins.add('s3', 'b'.repeat(64));
    t += TRANSACTION_TTL_MS + 1;
    expect(joins.take('s3')).toBeNull();
    // Old entries are pruned when new ones arrive; the map stays bounded.
    joins.add('old', 'c'.repeat(64));
    t += TRANSACTION_TTL_MS + 1;
    for (let i = 0; i < 4; i += 1) joins.add(`s${String(i)}`, 'd'.repeat(64));
    expect(joins.take('old')).toBeNull();
    expect(joins.take('s3')).toBeNull(); // over the bound: not kept
    expect(joins.take('s0')).toBe('d'.repeat(64));
  });
});

describe('M7 SMART launch state', () => {
  it('keeps entries for 10 minutes, once each, within a bound', async () => {
    const { Expiring } = await import('./smart.ts');
    let t = 0;
    const e = new Expiring<string>(() => t, 2);
    expect(e.add('a', '1')).toBe(true);
    expect(e.add('b', '2')).toBe(true);
    expect(e.add('c', '3')).toBe(false); // over the bound
    expect(e.get('a')).toBe('1');
    expect(e.take('a')).toBe('1');
    expect(e.take('a')).toBeNull();
    t = 10 * 60_000 + 1;
    expect(e.get('b')).toBeNull(); // expired
    expect(e.add('d', '4')).toBe(true); // the expired one was pruned
  });
});

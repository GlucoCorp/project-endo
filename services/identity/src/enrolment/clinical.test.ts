import { describe, expect, it } from 'vitest';
import {
  WorkloadTokenSigner,
  WorkloadTokenVerifier,
  generateServiceKeyPair,
} from '@endo/service-kit';
import { ClinicalUnavailableError, HttpClinicalClient } from './clinical.ts';

const INVITATION = '01900000-0000-7000-8000-0000000000c1';
const ORG = '01900000-0000-7000-8000-00000000000a';
const HASH = 'a'.repeat(64);

async function client(respond: (req: Request) => Response | Promise<Response>) {
  const keys = await generateServiceKeyPair();
  const seen: Request[] = [];
  const fake = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const req = new Request(input, init);
    seen.push(req);
    return respond(req);
  }) as typeof fetch;
  const c = new HttpClinicalClient({
    apiBaseUrl: 'http://api.test',
    signer: new WorkloadTokenSigner(keys.privateJwk, 'identity'),
    fetch: fake,
  });
  const verifier = new WorkloadTokenVerifier('api', {
    identity: { publicJwk: keys.publicJwk, scopes: ['api.enrolment.coordinate'] },
  });
  return { c, seen, verifier };
}
const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('REQ-001 ADR-0021 identity -> API invitation lookup client', () => {
  it('asks with one scope, for the API, and returns a checked answer', async () => {
    const { c, seen, verifier } = await client(() =>
      json(200, { invitation_id: INVITATION, org_id: ORG, reserved: true }),
    );
    expect(await c.find(HASH)).toEqual({ invitationId: INVITATION, orgId: ORG, reserved: true });
    const req = seen[0]!;
    expect(req.method).toBe('POST');
    expect(req.url).toBe('http://api.test/internal/v1/enrolment/invitations/find');
    expect(await req.json()).toEqual({ token_hash: HASH });
    // The hash travels in the body, never in the URL.
    expect(req.url).not.toContain(HASH);
    const caller = await verifier.verifyHeader(req.headers.get('authorization') ?? undefined);
    expect(caller).toMatchObject({ service: 'identity', scopes: ['api.enrolment.coordinate'] });
  });

  it('reads 404 as no live invitation', async () => {
    const { c } = await client(() => json(404, {}));
    expect(await c.find(HASH)).toBeNull();
  });

  it.each([
    ['a server error', () => json(500, {})],
    ['a redirect', () => new Response(null, { status: 302, headers: { location: '/x' } })],
    ['a body that is not JSON', () => new Response('nope', { status: 200 })],
    ['a missing field', () => json(200, { invitation_id: INVITATION, org_id: ORG })],
    ['a malformed id', () => json(200, { invitation_id: 'x', org_id: ORG, reserved: false })],
    [
      'a malformed organisation',
      () => json(200, { invitation_id: INVITATION, org_id: 1, reserved: false }),
    ],
    ['a network failure', () => Promise.reject(new TypeError('fetch failed'))],
  ] as const)('fails closed on %s', async (_, respond) => {
    const { c } = await client(respond);
    await expect(c.find(HASH)).rejects.toBeInstanceOf(ClinicalUnavailableError);
  });
});

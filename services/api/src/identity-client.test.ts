import { describe, expect, it } from 'vitest';
import {
  WorkloadTokenSigner,
  WorkloadTokenVerifier,
  generateServiceKeyPair,
} from '@endo/service-kit';
import { HttpIdentityEnrolment, IdentityUnavailableError } from './identity-client.ts';

const req = {
  orgId: '01900000-0000-7000-8000-00000000000a',
  invitationId: '01900000-0000-7000-8000-0000000000d1',
  code: '123456',
  clinicianId: '01900000-0000-7000-8000-0000000000c1',
  attestation: { identified: true, ownPhone: true },
  requestId: 'r1',
} as const;
const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

async function client(respond: () => Response | Promise<Response>) {
  const keys = await generateServiceKeyPair();
  const seen: Request[] = [];
  const c = new HttpIdentityEnrolment({
    identityBaseUrl: 'http://identity.test',
    signer: new WorkloadTokenSigner(keys.privateJwk, 'api'),
    fetch: (input, init) => {
      seen.push(new Request(input, init));
      return Promise.resolve(respond());
    },
  });
  const verifier = new WorkloadTokenVerifier('identity', {
    api: { publicJwk: keys.publicJwk, scopes: ['identity.enrolment.clinic'] },
  });
  return { c, seen, verifier };
}

describe('REQ-001 ADR-0021: API -> identity confirm client', () => {
  it('asks with one scope and sends the attestation; never more', async () => {
    const { c, seen, verifier } = await client(() => json(200, { outcome: 'confirmed' }));
    expect(await c.confirm(req)).toEqual({ outcome: 'confirmed' });
    const r = seen[0]!;
    expect(r.url).toBe('http://identity.test/internal/v1/enrolment/confirm');
    expect(await r.json()).toEqual({
      org_id: req.orgId,
      invitation_id: req.invitationId,
      code: '123456',
      clinician_id: req.clinicianId,
      attestation: { identified: true, own_phone: true },
    });
    expect(await verifier.verifyHeader(r.headers.get('authorization') ?? undefined)).toMatchObject({
      service: 'api',
      scopes: ['identity.enrolment.clinic'],
    });
  });

  it.each([
    [
      { outcome: 'wrong', remaining: 2 },
      { outcome: 'wrong', remaining: 2 },
    ],
    [
      { outcome: 'locked', locked_until: '2026-11-11T12:00:00Z' },
      { outcome: 'locked', lockedUntil: '2026-11-11T12:00:00Z' },
    ],
    [{ outcome: 'unavailable' }, { outcome: 'unavailable' }],
  ])('reads %o', async (body, expected) => {
    const { c } = await client(() => json(200, body));
    expect(await c.confirm(req)).toEqual(expected);
  });

  it.each([
    ['a server error', () => json(500, {})],
    ['an unknown outcome', () => json(200, { outcome: 'maybe' })],
    ['a wrong count that is not a number', () => json(200, { outcome: 'wrong', remaining: 'x' })],
    ['a lock without a time', () => json(200, { outcome: 'locked' })],
    ['a body that is not JSON', () => new Response('nope', { status: 200 })],
    ['a network failure', () => Promise.reject(new TypeError('fetch failed'))],
  ] as const)('fails closed on %s', async (_, respond) => {
    const { c } = await client(respond);
    await expect(c.confirm(req)).rejects.toBeInstanceOf(IdentityUnavailableError);
  });
});

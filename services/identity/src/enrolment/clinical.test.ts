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

  it('reserves with the same single scope and reads done or refused', async () => {
    const tx = '01900000-0000-7000-8000-0000000000f1';
    const r = { orgId: ORG, invitationId: INVITATION, transactionId: tx };
    const ok = await client(() => json(200, { outcome: 'done', changed: true, state: {} }));
    expect(await ok.c.reserve(r)).toBe('done');
    expect(ok.seen[0]?.url).toBe('http://api.test/internal/v1/enrolment/invitations/reserve');
    expect(await ok.seen[0]?.json()).toEqual({
      org_id: ORG,
      invitation_id: INVITATION,
      transaction_id: tx,
    });
    expect(await (await client(() => json(200, { outcome: 'refused' }))).c.reserve(r)).toBe(
      'refused',
    );
    for (const bad of [
      () => json(500, {}),
      () => json(200, { outcome: 'maybe' }),
      () => new Response('nope', { status: 200 }),
      () => Promise.reject(new TypeError('fetch failed')),
    ])
      await expect((await client(bad)).c.reserve(r)).rejects.toBeInstanceOf(
        ClinicalUnavailableError,
      );
  });

  it('claims and writes consents with the coordinate scope, failing closed', async () => {
    const tx = '01900000-0000-7000-8000-0000000000f1';
    const patient = '01900000-0000-7000-8000-0000000000f2';
    const person = '01900000-0000-7000-8000-0000000000f3';
    const claim = {
      orgId: ORG,
      invitationId: INVITATION,
      transactionId: tx,
      patientId: patient,
      identityRef: person,
    };
    const ok = await client(() => json(200, { outcome: 'done', changed: true, state: {} }));
    expect(await ok.c.claim(claim)).toBe('done');
    expect(ok.seen[0]?.url).toBe('http://api.test/internal/v1/enrolment/invitations/claim');
    expect(await ok.seen[0]?.json()).toEqual({
      org_id: ORG,
      invitation_id: INVITATION,
      transaction_id: tx,
      patient_id: patient,
      identity_ref: person,
    });
    expect(await (await client(() => json(200, { outcome: 'refused' }))).c.claim(claim)).toBe(
      'refused',
    );
    for (const bad of [
      () => json(500, {}),
      () => json(200, { outcome: 'x' }),
      () => Promise.reject(new TypeError('down')),
    ])
      await expect((await client(bad)).c.claim(claim)).rejects.toBeInstanceOf(
        ClinicalUnavailableError,
      );

    const chosen = new Date('2026-11-11T11:00:00Z');
    const consents = {
      orgId: ORG,
      patientId: patient,
      decisions: [
        { purpose: 'self_tracking', status: 'granted' as const, version: 1, chosenAt: chosen },
      ],
    };
    const written = await client(() => json(200, { written: 1 }));
    await written.c.consents(consents);
    expect(await written.seen[0]?.json()).toEqual({
      org_id: ORG,
      patient_id: patient,
      decisions: [
        {
          purpose: 'self_tracking',
          status: 'granted',
          version: 1,
          chosen_at: chosen.toISOString(),
        },
      ],
    });
    await expect((await client(() => json(500, {}))).c.consents(consents)).rejects.toBeInstanceOf(
      ClinicalUnavailableError,
    );
    await expect(
      (await client(() => Promise.reject(new TypeError('down')))).c.consents(consents),
    ).rejects.toBeInstanceOf(ClinicalUnavailableError);
  });

  it('ADR-0021 s11 releases and revokes for cleanup, telling a won claim apart', async () => {
    const TX = '01900000-0000-7000-8000-0000000000f1';
    const r = { orgId: ORG, invitationId: INVITATION, transactionId: TX };
    const released = await client(() =>
      json(200, { outcome: 'done', changed: true, state: { status: 'live', reserved_by: null } }),
    );
    expect(await released.c.release(r)).toBe('released');
    expect(released.seen[0]?.url).toBe('http://api.test/internal/v1/enrolment/invitations/release');
    expect(await released.seen[0]?.json()).toEqual({
      org_id: ORG,
      invitation_id: INVITATION,
      transaction_id: TX,
    });
    const missing = await client(() =>
      json(200, { outcome: 'refused', state: { status: 'missing' } }),
    );
    expect(await missing.c.release(r)).toBe('released');
    const won = await client(() =>
      json(200, {
        outcome: 'refused',
        state: { status: 'claimed', reserved_by: TX, patient_id: INVITATION },
      }),
    );
    expect(await won.c.release(r)).toBe('claimed');
    for (const odd of [
      () => json(200, { outcome: 'refused', state: { status: 'claimed', reserved_by: 'other' } }),
      () => json(200, { outcome: 'maybe', state: { status: 'live' } }),
      () => json(200, { outcome: 'done' }),
      () => json(503, {}),
      () => Promise.reject(new TypeError('down')),
    ]) {
      await expect((await client(odd)).c.release(r)).rejects.toBeInstanceOf(
        ClinicalUnavailableError,
      );
    }
    const revoked = await client(() =>
      json(200, { outcome: 'done', changed: true, state: { status: 'revoked', reserved_by: TX } }),
    );
    expect(await revoked.c.revokeHeld(r)).toBe('done');
    expect(revoked.seen[0]?.url).toBe('http://api.test/internal/v1/enrolment/invitations/revoke');
    const notHeld = await client(() =>
      json(200, { outcome: 'refused', state: { status: 'live', reserved_by: null } }),
    );
    expect(await notHeld.c.revokeHeld(r)).toBe('refused');
  });
});

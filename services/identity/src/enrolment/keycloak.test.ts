import { describe, expect, it } from 'vitest';
import {
  WorkloadTokenSigner,
  WorkloadTokenVerifier,
  generateServiceKeyPair,
} from '@endo/service-kit';
import {
  HttpKeycloakAdmin,
  KEYCLOAK_ADMIN_SCOPE,
  KEYCLOAK_EMAIL_SCOPE,
  KEYCLOAK_ERASE_SCOPE,
} from './keycloak.ts';

const SUBJECT = '01900000-0000-7000-8000-0000000000d1';
const TX = '01900000-0000-7000-8000-0000000000f1';

async function admin(respond: (req: Request) => Response | Promise<Response>) {
  const keys = await generateServiceKeyPair();
  const seen: Request[] = [];
  const fake = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const req = new Request(input, init);
    seen.push(req);
    return respond(req);
  }) as typeof fetch;
  const a = new HttpKeycloakAdmin({
    realmUrl: 'http://keycloak.test/realms/endo/',
    signer: new WorkloadTokenSigner(keys.privateJwk, 'identity'),
    fetch: fake,
  });
  const verifier = new WorkloadTokenVerifier('keycloak', {
    identity: {
      publicJwk: keys.publicJwk,
      scopes: [KEYCLOAK_ADMIN_SCOPE, KEYCLOAK_EMAIL_SCOPE, KEYCLOAK_ERASE_SCOPE],
    },
  });
  return { a, seen, verifier };
}
const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('REQ-001 ADR-0021 section 10 identity -> Keycloak finalise client', () => {
  it('finalises with the admin scope only, for Keycloak, naming subject and transaction', async () => {
    const { a, seen, verifier } = await admin(() => json(200, { finalised: true }));
    expect(await a.finalise(SUBJECT, TX)).toBe(true);
    const req = seen[0]!;
    expect(req.url).toBe('http://keycloak.test/realms/endo/endo-enrolment/finalise');
    expect(req.redirect).toBe('error');
    const caller = await verifier.verifyHeader(req.headers.get('authorization') ?? undefined);
    expect(caller).toEqual({ service: 'identity', scopes: [KEYCLOAK_ADMIN_SCOPE] });
    expect(await req.json()).toEqual({ subject: SUBJECT, transaction_id: TX });
  });

  it('counts only a 200 that says so; refusals, outages and odd bodies are "not yet"', async () => {
    for (const r of [
      () => json(409, {}),
      () => json(401, {}),
      () => json(404, {}),
      () => json(500, {}),
      () => json(200, { finalised: 'yes' }),
      () => new Response('not json', { status: 200 }),
      () => {
        throw new TypeError('network');
      },
    ]) {
      const { a } = await admin(r);
      expect(await a.finalise(SUBJECT, TX)).toBe(false);
    }
  });

  it('RISK-S04 deletes a provisional user through the same narrow endpoint', async () => {
    const { a, seen } = await admin(() => json(200, { deleted: true }));
    expect(await a.deleteProvisional(SUBJECT, TX)).toBe(true);
    expect(seen[0]!.url).toBe('http://keycloak.test/realms/endo/endo-enrolment/delete');
  });

  it('ADR-0026 sends a code email through the extension with its own scope only', async () => {
    const { a, seen, verifier } = await admin(() => json(200, { sent: true }));
    expect(await a.send('a@example.test', '123456', 'confirm')).toBe(true);
    const req = seen[0]!;
    const caller = await verifier.verifyHeader(req.headers.get('authorization') ?? undefined);
    expect(caller.scopes).toEqual([KEYCLOAK_EMAIL_SCOPE]);
    expect(req.url).toBe('http://keycloak.test/realms/endo/endo-enrolment/send-email');
    expect(await req.json()).toEqual({ to: 'a@example.test', code: '123456', purpose: 'confirm' });
    for (const r of [
      () => json(503, {}),
      () => json(200, {}),
      () => Promise.reject(new TypeError('down')),
    ]) {
      const { a: other } = await admin(r);
      expect(await other.send('a@example.test', '123456', 'sign-in')).toBe(false);
    }
  });

  it('REQ-009 erases her account with its own scope, naming only her subject', async () => {
    const { a, seen, verifier } = await admin(() => json(200, { erased: true }));
    expect(await a.eraseUser(SUBJECT)).toBe(true);
    const req = seen[0]!;
    expect(req.url).toBe('http://keycloak.test/realms/endo/endo-enrolment/erase');
    const caller = await verifier.verifyHeader(req.headers.get('authorization') ?? undefined);
    expect(caller.scopes).toEqual([KEYCLOAK_ERASE_SCOPE]);
    expect(await req.json()).toEqual({ subject: SUBJECT });
    for (const r of [
      () => json(409, {}),
      () => json(200, { erased: 'yes' }),
      () => Promise.reject(new TypeError('down')),
    ]) {
      const { a: other } = await admin(r);
      expect(await other.eraseUser(SUBJECT)).toBe(false);
    }
  });
});

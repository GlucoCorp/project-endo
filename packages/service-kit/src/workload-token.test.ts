import { describe, expect, it } from 'vitest';
import {
  ServiceTokenSigner,
  ServiceTokenVerifier,
  WorkloadTokenSigner,
  WorkloadTokenVerifier,
  generateServiceKeyPair,
} from './index.ts';

describe('ADR-0018 workload tokens (service-to-service, no end user)', () => {
  const setup = async () => {
    const api = await generateServiceKeyPair();
    const jobs = await generateServiceKeyPair();
    const verifier = new WorkloadTokenVerifier('identity', {
      api: { publicJwk: api.publicJwk, scopes: ['identity.person.create', 'identity.link.create'] },
      jobs: { publicJwk: jobs.publicJwk, scopes: ['identity.person.erase'] },
    });
    return { api, jobs, verifier };
  };

  it('accepts a trusted caller requesting allowed scopes', async () => {
    const { api, verifier } = await setup();
    const token = await new WorkloadTokenSigner(api.privateJwk, 'api').sign(
      ['identity.person.create'],
      'identity',
    );
    await expect(verifier.verifyHeader(`Bearer ${token}`)).resolves.toEqual({
      service: 'api',
      scopes: ['identity.person.create'],
    });
  });

  it('rejects a scope the caller may not hold', async () => {
    const { api, verifier } = await setup();
    const token = await new WorkloadTokenSigner(api.privateJwk, 'api').sign(
      ['identity.person.erase'],
      'identity',
    );
    await expect(verifier.verifyHeader(`Bearer ${token}`)).rejects.toMatchObject({
      code: 'authn.invalid',
    });
  });

  it('rejects one caller posing as another, the wrong audience, and unknown callers', async () => {
    const { api, verifier } = await setup();
    const posing = await new WorkloadTokenSigner(api.privateJwk, 'jobs').sign(
      ['identity.person.erase'],
      'identity',
    );
    const wrongAud = await new WorkloadTokenSigner(api.privateJwk, 'api').sign(
      ['identity.person.create'],
      'api',
    );
    const unknown = await new WorkloadTokenSigner(api.privateJwk, 'bff-patient').sign(
      ['identity.person.create'],
      'identity',
    );
    for (const t of [posing, wrongAud, unknown]) {
      await expect(verifier.verifyHeader(`Bearer ${t}`)).rejects.toMatchObject({
        code: 'authn.invalid',
      });
    }
  });

  it.each([
    ['missing', undefined, 'authn.missing'],
    ['not bearer', 'Basic x', 'authn.invalid'],
    ['garbage', 'Bearer a.b.c', 'authn.invalid'],
  ])('rejects a %s header', async (_n, header, code) => {
    const { verifier } = await setup();
    await expect(verifier.verifyHeader(header)).rejects.toMatchObject({ code });
  });

  it('rejects an expired token', async () => {
    const { api } = await setup();
    const t0 = new Date('2026-11-08T12:00:00Z');
    const token = await new WorkloadTokenSigner(api.privateJwk, 'api', () => t0).sign(
      ['identity.person.create'],
      'identity',
    );
    const later = new WorkloadTokenVerifier(
      'identity',
      { api: { publicJwk: api.publicJwk, scopes: ['identity.person.create'] } },
      () => new Date(t0.getTime() + 66_000),
    );
    await expect(later.verifyHeader(`Bearer ${token}`)).rejects.toMatchObject({
      code: 'authn.invalid',
    });
  });

  it('refuses to sign malformed or empty scopes', async () => {
    const { api } = await setup();
    const signer = new WorkloadTokenSigner(api.privateJwk, 'api');
    await expect(signer.sign([], 'identity')).rejects.toThrow();
    await expect(signer.sign(['Not A Scope'], 'identity')).rejects.toThrow();
  });

  it('cannot be confused with an end-user service token, in either direction', async () => {
    const { api, verifier } = await setup();
    const serviceToken = await new ServiceTokenSigner(api.privateJwk, 'api').sign(
      {
        sub: '01900000-0000-7000-8000-000000000001',
        role: 'patient',
        org_id: null,
        patient_id: null,
      },
      'identity',
    );
    await expect(verifier.verifyHeader(`Bearer ${serviceToken}`)).rejects.toMatchObject({
      code: 'authn.invalid',
    });
    const workload = await new WorkloadTokenSigner(api.privateJwk, 'api').sign(
      ['identity.person.create'],
      'identity',
    );
    const serviceVerifier = new ServiceTokenVerifier('identity', {
      api: { publicJwk: api.publicJwk, roles: ['patient'] },
    });
    await expect(serviceVerifier.verifyHeader(`Bearer ${workload}`)).rejects.toMatchObject({
      code: 'authn.invalid',
    });
  });
});

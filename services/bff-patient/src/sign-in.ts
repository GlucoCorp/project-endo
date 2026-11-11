import { randomBytes } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import {
  OidcError,
  authorizationUrl,
  exchangeCode,
  validateIdToken,
  type OidcConfig,
} from '@endo/oidc';
import { ProblemError, type ServiceClaims } from '@endo/service-kit';
import { sessionCookie, type EnrolmentDeps } from './enrolment.ts';
import { PATIENT_ABSOLUTE_MS, SESSION_COOKIE, readCookie } from './sessions.ts';

/** Binds a sign-in attempt to this browser (Lax: Keycloak's return is a cross-site navigation). */
export const SIGNIN_COOKIE = '__Host-endo_signin';
const SIGNIN_TTL_S = 600;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/**
 * A returning patient signs in with her passkey (REQ-001; spec 10.1), the same way as the clinic
 * portal (ADR-0019): authorisation code with PKCE, `state` bound to this browser by its own
 * cookie, a validated ID token, then the identity service names her person and patient record.
 * Only then is a patient session created, with a fresh token. Every refusal looks the same.
 */
export function registerSignIn(
  app: FastifyInstance,
  deps: EnrolmentDeps,
  h: NonNullable<EnrolmentDeps['handoff']>,
): void {
  const oidc: OidcConfig = { ...h.oidc, redirectUri: `${deps.patientOrigin}/auth/callback` };
  const auth = { auth: { kind: 'public', reason: 'sign-in' } } as const;

  app.get(
    '/auth/sign-in',
    {
      config: auth,
      schema: { querystring: { type: 'object', additionalProperties: false, maxProperties: 0 } },
    },
    async (_request, reply) => {
      const binding =
        readCookie(_request.headers.cookie, SIGNIN_COOKIE) ?? randomBytes(32).toString('base64url');
      const attempt = h.transactions.create(binding);
      return reply
        .header(
          'set-cookie',
          `${SIGNIN_COOKIE}=${binding}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=${String(SIGNIN_TTL_S)}`,
        )
        .redirect(authorizationUrl(oidc, attempt), 302);
    },
  );

  const resolve = async (request: FastifyRequest, issuer: string, subject: string) => {
    const token = await deps.signer.sign(['identity.patient.resolve'], 'identity');
    let res: Response;
    try {
      res = await deps.fetch(new URL('/internal/v1/patients/resolve', deps.identityBaseUrl), {
        method: 'POST',
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
          'x-request-id': request.id,
        },
        body: JSON.stringify({ idp_issuer: issuer, idp_subject: subject }),
        redirect: 'error',
        signal: AbortSignal.timeout(5_000),
      });
    } catch {
      throw new OidcError();
    }
    if (!res.ok) throw new OidcError();
    const b = (await res.json().catch(() => null)) as Record<string, unknown> | null;
    const { person_id: sub, patient_id: patient, org_id: org } = b ?? {};
    if (typeof sub !== 'string' || typeof patient !== 'string' || typeof org !== 'string')
      throw new OidcError();
    if (!UUID.test(sub) || !UUID.test(patient) || !UUID.test(org)) throw new OidcError();
    const claims: ServiceClaims = { sub, role: 'patient', org_id: org, patient_id: patient };
    return claims;
  };

  app.get(
    '/auth/callback',
    {
      config: auth,
      schema: {
        querystring: {
          type: 'object',
          additionalProperties: false,
          properties: {
            code: { type: 'string', maxLength: 2048 },
            state: { type: 'string', maxLength: 256 },
            session_state: { type: 'string', maxLength: 256 },
            iss: { type: 'string', maxLength: 512 },
            error: { type: 'string', maxLength: 256 },
            error_description: { type: 'string', maxLength: 1024 },
          },
        },
      },
    },
    async (request, reply) => {
      const q = request.query as { code?: string; state?: string; error?: string; iss?: string };
      try {
        const binding = readCookie(request.headers.cookie, SIGNIN_COOKIE);
        if (!binding || !q.state) throw new OidcError();
        const attempt = h.transactions.consume(binding, q.state);
        // RFC 9207: if the provider names itself, it must be ours.
        if (q.error || !q.code || (q.iss !== undefined && q.iss !== oidc.issuer))
          throw new OidcError();
        const { idToken } = await exchangeCode(oidc, q.code, attempt, deps.fetch);
        const who = await validateIdToken(oidc, idToken, attempt, h.keys, deps.now);
        const claims = await resolve(request, who.issuer, who.subject);
        // A fresh session, never one the browser brought (fixation); any old one ends.
        const old = readCookie(request.headers.cookie, SESSION_COOKIE);
        if (old) await h.sessions.revoke(old);
        sessionCookie(reply, await h.sessions.createPatient(claims), PATIENT_ABSOLUTE_MS);
        // A same-origin page completes the navigation, so the Strict session cookie is sent on
        // the next request (this callback arrives cross-site).
        return await reply
          .type('text/html; charset=utf-8')
          .send(
            '<!doctype html><meta charset="utf-8"><meta http-equiv="refresh" content="0;url=/">' +
              '<title>Signing in</title><p><a href="/">Continue</a></p>',
          );
      } catch (error) {
        if (!(error instanceof OidcError)) throw error;
        request.log.warn({ event: 'sign_in.failed' });
        throw new ProblemError(401, 'authn.sign_in_failed', 'Sign-in did not work. Try again.');
      }
    },
  );

  /** Whether this browser has a patient session; never her ids. */
  app.get('/v1/session', { config: { auth: { kind: 'session' } } }, () => ({ signed_in: true }));
}

import { createHash, randomBytes } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { ProblemError, rateLimitedError, type WorkloadTokenSigner } from '@endo/service-kit';
import type { JWTVerifyGetKey } from 'jose';
import {
  OidcError,
  authorizationUrl,
  codeChallenge,
  exchangeCode,
  validateIdToken,
  type OidcConfig,
  type TransactionStore,
} from '@endo/oidc';
import { registerSignIn } from './sign-in.ts';
import { registerEmailSettings } from './email-settings.ts';
import {
  CONSENT_PENDING_ABSOLUTE_MS,
  PATIENT_ABSOLUTE_MS,
  SESSION_COOKIE,
  readCookie,
  type ConsentSessions,
  type SessionResolver,
} from './sessions.ts';

/**
 * The browser binding cookie (ADR-0021 section 4): `__Host-` (Secure, Path=/, no Domain),
 * HttpOnly, SameSite=Lax. Holds the transaction id and a 256-bit secret; only their SHA-256 ever
 * leaves this service. It expires exactly at the transaction's absolute deadline and is never
 * renewed; the coordinator enforces every deadline itself.
 */
export const ENROLMENT_COOKIE = '__Host-endo_enrolment';

export interface EnrolmentDeps {
  readonly identityBaseUrl: string;
  /** Workload signer for `identity.enrolment.patient` (ADR-0018). */
  readonly signer: WorkloadTokenSigner;
  /** Exact origin of the patient app, e.g. `https://app.example`. State changes must match it. */
  readonly patientOrigin: string;
  readonly fetch: typeof fetch;
  readonly now: () => Date;
  /** Starts per client IP per minute (default 10), on top of the BFF's general limit. */
  readonly startsPerMinute?: number;
  /**
   * The handoff into Keycloak for her first passkey (ADR-0021 sections 5 and 7). Without it,
   * "Continue" and the callback do not exist.
   */
  readonly handoff?: {
    readonly oidc: OidcConfig;
    /** Keycloak's signing keys, from the configured JWKS URL (never from a token). */
    readonly keys: JWTVerifyGetKey;
    readonly transactions: TransactionStore;
    /** Her consent-pending session and its rotation into a patient session (section 12). */
    readonly sessions: ConsentSessions;
  };
  /** Reads her current patient session at sign-in (app-lock choice carries over). */
  readonly sessionsResolver?: SessionResolver;
}

/** Appends a Set-Cookie header, keeping any set earlier in this reply. */
export function addCookie(reply: FastifyReply, value: string): void {
  const prior = reply.getHeader('set-cookie');
  const list = prior === undefined ? [] : Array.isArray(prior) ? prior : [String(prior)];
  void reply.header('set-cookie', list.length === 0 ? value : [...list, value]);
}

/** Strict: the page's own requests carry it, no other site's ever do (spec 8.4). */
export function sessionCookie(reply: FastifyReply, token: string | null, maxAgeMs = 0): void {
  addCookie(
    reply,
    `${SESSION_COOKIE}=${token ?? ''}; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=${String(
      token ? Math.floor(maxAgeMs / 1000) : 0,
    )}`,
  );
}

const LINK_TOKEN = /^[A-Za-z0-9_-]{43}$/;
// The transaction id (always 36 characters) followed by the secret: only characters the shared
// cookie reader accepts.
const COOKIE_VALUE =
  /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12})([A-Za-z0-9_-]{43})$/;
const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

/** What her page may see. The code appears only in the response to the Start that drew it. */
interface View {
  readonly status: string;
  readonly expired: boolean;
  readonly state_deadline: string | null;
  readonly expires_at: string;
  readonly code?: string;
}

const unavailable = () =>
  new ProblemError(
    502,
    'upstream_unavailable',
    'The service is not available right now. Try again soon.',
  );
/** One answer for no cookie, a damaged cookie and a transaction that is not hers. */
const noEnrolment = () =>
  new ProblemError(404, 'enrolment.not_found', 'Start again from your link.');

interface Account {
  readonly person_id: string;
  readonly patient_id: string;
  readonly org_id: string;
  readonly subject: string;
}
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** The coordinator's account ids for an active transaction; never sent to the browser. */
function parseAccount(body: unknown): Account | null {
  const a = (body as { account?: Partial<Record<keyof Account, unknown>> } | null)?.account;
  if (
    !a ||
    typeof a.person_id !== 'string' ||
    !UUID.test(a.person_id) ||
    typeof a.patient_id !== 'string' ||
    !UUID.test(a.patient_id) ||
    typeof a.org_id !== 'string' ||
    !UUID.test(a.org_id) ||
    typeof a.subject !== 'string'
  )
    return null;
  return {
    person_id: a.person_id,
    patient_id: a.patient_id,
    org_id: a.org_id,
    subject: a.subject,
  };
}

function parseView(body: unknown, withCode: boolean): View {
  const v = body as Partial<Record<keyof View | 'transaction_id', unknown>> | null;
  if (
    !v ||
    typeof v.status !== 'string' ||
    typeof v.expired !== 'boolean' ||
    !(v.state_deadline === null || typeof v.state_deadline === 'string') ||
    typeof v.expires_at !== 'string' ||
    Number.isNaN(Date.parse(v.expires_at)) ||
    (withCode ? typeof v.code !== 'string' || !/^[0-9]{6}$/.test(v.code) : v.code !== undefined)
  )
    throw unavailable();
  return {
    status: v.status,
    expired: v.expired,
    state_deadline: v.state_deadline,
    expires_at: v.expires_at,
    ...(withCode ? { code: v.code as string } : {}),
  };
}

/**
 * Patient enrolment, before she has an account (ADR-0021 sections 3, 4 and 13). The link token
 * arrives in a POST body (the page took it from the URL fragment, which servers never see), and
 * opening the link never starts anything. State changes need the exact patient Origin and a JSON
 * body, which a cross-site page cannot send without a CORS preflight this service never allows.
 */
export function registerEnrolmentRoutes(app: FastifyInstance, deps: EnrolmentDeps): void {
  const startLimit = app.rateLimit({
    max: deps.startsPerMinute ?? 10,
    timeWindow: 60_000,
    errorResponseBuilder: () => rateLimitedError(),
  });

  const sameOrigin = (request: FastifyRequest): Promise<void> => {
    if (request.headers.origin !== deps.patientOrigin)
      return Promise.reject(new ProblemError(403, 'csrf.origin_mismatch', 'Request refused.'));
    if (!/^application\/json(;|$)/.test(request.headers['content-type'] ?? ''))
      return Promise.reject(new ProblemError(415, 'request.json_required', 'Request refused.'));
    return Promise.resolve();
  };

  const call = async (request: FastifyRequest, path: string, body: object): Promise<Response> => {
    const token = await deps.signer.sign(['identity.enrolment.patient'], 'identity');
    try {
      return await deps.fetch(new URL(path, deps.identityBaseUrl), {
        method: 'POST',
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
          'x-request-id': request.id,
        },
        body: JSON.stringify(body),
        redirect: 'error',
        signal: AbortSignal.timeout(5_000),
      });
    } catch {
      throw unavailable();
    }
  };

  const setCookie = (reply: FastifyReply, txId: string, secret: string, expiresAt: string) => {
    const seconds = Math.max(0, Math.floor((Date.parse(expiresAt) - deps.now().getTime()) / 1000));
    // Set on its own (Start sets no other cookie): the reviewed scan exception names this line.
    void reply.header(
      'set-cookie',
      `${ENROLMENT_COOKIE}=${txId}${secret}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=${String(seconds)}`,
    );
  };
  const clearCookie = (reply: FastifyReply) => {
    addCookie(reply, `${ENROLMENT_COOKIE}=; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=0`);
  };
  const sessionToken = (request: FastifyRequest) =>
    readCookie(request.headers.cookie, SESSION_COOKIE);

  const fromCookie = (request: FastifyRequest) => {
    const m = COOKIE_VALUE.exec(readCookie(request.headers.cookie, ENROLMENT_COOKIE) ?? '');
    const [, txId, secret] = m ?? [];
    return txId && secret ? { txId, secret } : null;
  };

  app.post(
    '/v1/enrolment/start',
    {
      config: { auth: { kind: 'enrolment' }, ownRateLimit: true },
      onRequest: [startLimit],
      preValidation: sameOrigin,
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['token'],
          properties: { token: { type: 'string', pattern: LINK_TOKEN.source } },
        },
      },
    },
    async (request, reply) => {
      const { token } = request.body as { token: string };
      // The same browser keeps its secret, so a repeated Start finds the same transaction.
      const secret = fromCookie(request)?.secret ?? randomBytes(32).toString('base64url');
      const res = await call(request, '/internal/v1/enrolment/transactions', {
        token_hash: sha256(token),
        binding_hash: sha256(secret),
      });
      if (res.status === 404)
        throw new ProblemError(404, 'enrolment.link_invalid', 'This link cannot be used.');
      if (res.status === 409) {
        const type = ((await res.json().catch(() => null)) as { type?: unknown } | null)?.type;
        const code = typeof type === 'string' ? type.split('/').pop() : undefined;
        throw new ProblemError(
          409,
          code === 'enrolment.locked' || code === 'enrolment.busy' ? code : 'enrolment.unavailable',
          'This link cannot be used right now.',
        );
      }
      if (res.status !== 200 && res.status !== 201) throw unavailable();
      const body = (await res.json().catch(() => null)) as { transaction_id?: unknown } | null;
      const view = parseView(body, res.status === 201);
      const txId = body?.transaction_id;
      if (typeof txId !== 'string' || !COOKIE_VALUE.test(`${txId}${secret}`)) throw unavailable();
      setCookie(reply, txId, secret, view.expires_at);
      return reply.code(res.status).send(view);
    },
  );

  app.get(
    '/v1/enrolment/status',
    { config: { auth: { kind: 'enrolment' } } },
    async (request, reply) => {
      const bound = fromCookie(request);
      if (!bound) throw noEnrolment();
      const res = await call(request, `/internal/v1/enrolment/transactions/${bound.txId}/status`, {
        binding_hash: sha256(bound.secret),
      });
      if (res.status === 404) throw noEnrolment();
      if (!res.ok) throw unavailable();
      const body: unknown = await res.json().catch(() => null);
      const view = parseView(body, false);
      const sessions = deps.handoff?.sessions;
      const token = sessionToken(request);
      if (sessions && token) await settleSession(sessions, token, bound.txId, view, body, reply);
      return view;
    },
  );

  /**
   * Section 12: once the transaction is active, her consent-pending session rotates into a patient
   * session (new token; the enrolment cookie has done its job). Once it can no longer become
   * active, the consent-pending session ends. Any other session is left alone.
   */
  const settleSession = async (
    sessions: ConsentSessions,
    token: string,
    txId: string,
    view: View,
    body: unknown,
    reply: FastifyReply,
  ): Promise<void> => {
    const pending = await sessions.consentPending(token);
    if (!pending || pending.transactionId !== txId) return;
    if (view.status === 'cancelling' || view.status === 'cancelled') {
      await sessions.revoke(token);
      sessionCookie(reply, null);
      return;
    }
    if (view.status !== 'active') return;
    const account = parseAccount(body);
    if (!account || account.subject !== pending.subject) throw unavailable();
    const rotated = await sessions.rotate(token, txId, pending.subject, {
      sub: account.person_id,
      role: 'patient',
      org_id: account.org_id,
      patient_id: account.patient_id,
    });
    if (!rotated) return;
    sessionCookie(reply, rotated, PATIENT_ABSOLUTE_MS);
    clearCookie(reply);
  };

  app.post(
    '/v1/enrolment/cancel',
    { config: { auth: { kind: 'enrolment' } }, preValidation: sameOrigin },
    async (request, reply) => {
      const bound = fromCookie(request);
      if (!bound) throw noEnrolment();
      const res = await call(request, `/internal/v1/enrolment/transactions/${bound.txId}/cancel`, {
        binding_hash: sha256(bound.secret),
      });
      if (res.status === 404) {
        clearCookie(reply);
        throw noEnrolment();
      }
      if (res.status === 409)
        throw new ProblemError(409, 'enrolment.cannot_cancel', 'This can no longer be cancelled.');
      if (!res.ok) throw unavailable();
      const view = parseView(await res.json().catch(() => null), false);
      clearCookie(reply);
      return reply.send(view);
    },
  );

  if (deps.handoff) {
    registerHandoff(app, deps, deps.handoff, { sameOrigin, call, fromCookie });
    registerSignIn(app, deps, deps.handoff);
    registerEmailSettings(app, deps);
  }

  /** Ends whichever session this browser holds (section 12: allowed while consent is pending). */
  app.post(
    '/v1/session/sign-out',
    { config: { auth: { kind: 'public', reason: 'sign-out' } }, preValidation: sameOrigin },
    async (request, reply) => {
      const token = sessionToken(request);
      if (token && deps.handoff) await deps.handoff.sessions.revoke(token);
      sessionCookie(reply, null);
      return reply.code(204).send();
    },
  );

  const decision = {
    type: 'object',
    additionalProperties: false,
    required: ['status', 'version', 'decided_at'],
    properties: {
      status: { type: 'string', enum: ['granted', 'declined'] },
      version: { type: 'integer', minimum: 1, maximum: 999_999_999 },
      decided_at: { type: 'string', format: 'date-time' },
    },
  } as const;

  /**
   * Her four consent decisions (spec 13.1; ADR-0021 sections 10 and 12), each with the version of
   * the explanation she read and when she chose. Declining self-tracking ends enrolment.
   */
  app.post(
    '/v1/enrolment/consent',
    {
      config: { auth: { kind: 'enrolment' } },
      preValidation: sameOrigin,
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['decisions'],
          properties: {
            decisions: {
              type: 'object',
              additionalProperties: false,
              required: [
                'self_tracking',
                'share_with_care_team',
                'research_deidentified',
                'org_aggregate_reporting',
              ],
              properties: {
                self_tracking: decision,
                share_with_care_team: decision,
                research_deidentified: decision,
                org_aggregate_reporting: decision,
              },
            },
          },
        },
      },
    },
    async (request) => {
      const bound = fromCookie(request);
      if (!bound) throw noEnrolment();
      // Section 12: only her consent-pending session for this transaction may decide.
      const token = sessionToken(request);
      const pending =
        token && deps.handoff ? await deps.handoff.sessions.consentPending(token) : null;
      if (pending?.transactionId !== bound.txId)
        throw new ProblemError(401, 'authn.session_required', 'Sign in to continue.');
      const { decisions } = request.body as { decisions: object };
      const res = await call(request, `/internal/v1/enrolment/transactions/${bound.txId}/consent`, {
        binding_hash: sha256(bound.secret),
        decisions,
      });
      if (res.status === 404) throw noEnrolment();
      if (res.status === 400)
        throw new ProblemError(400, 'request.invalid', 'Every choice is needed.');
      if (res.status === 409) throw new ProblemError(409, 'enrolment.not_ready', 'Not ready yet.');
      if (!res.ok) throw unavailable();
      return parseView(await res.json().catch(() => null), false);
    },
  );
}

/**
 * "Create your sign-in" (ADR-0021 sections 5 and 7). The BFF starts its own OIDC attempt, bound
 * to this browser's enrolment secret, and asks the coordinator for a handoff bound to that exact
 * request. Only the opaque handoff reference goes into Keycloak's URL. The callback is accepted
 * only for this browser's attempt, with a valid ID token, and the coordinator checks the subject
 * is the provisional user it created.
 */
function registerHandoff(
  app: FastifyInstance,
  deps: EnrolmentDeps,
  h: NonNullable<EnrolmentDeps['handoff']>,
  helpers: {
    sameOrigin: (request: FastifyRequest) => Promise<void>;
    call: (request: FastifyRequest, path: string, body: object) => Promise<Response>;
    fromCookie: (request: FastifyRequest) => { txId: string; secret: string } | null;
  },
): void {
  app.post(
    '/v1/enrolment/continue',
    { config: { auth: { kind: 'enrolment' } }, preValidation: helpers.sameOrigin },
    async (request) => {
      const bound = helpers.fromCookie(request);
      if (!bound) throw noEnrolment();
      const attempt = h.transactions.create(bound.secret);
      const res = await helpers.call(
        request,
        `/internal/v1/enrolment/transactions/${bound.txId}/handoff`,
        {
          binding_hash: sha256(bound.secret),
          kind: 'enrol',
          issuer: h.oidc.issuer,
          client_id: h.oidc.clientId,
          redirect_uri: h.oidc.redirectUri,
          code_challenge: codeChallenge(attempt),
          state: attempt.state,
          nonce: attempt.nonce,
        },
      );
      if (res.status === 404) throw noEnrolment();
      if (res.status === 409) throw new ProblemError(409, 'enrolment.not_ready', 'Not ready yet.');
      if (res.status !== 201) throw unavailable();
      const ref = ((await res.json().catch(() => null)) as { handoff_ref?: unknown } | null)
        ?.handoff_ref;
      if (typeof ref !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(ref)) throw unavailable();
      // The page navigates there; nothing else about the request is in the URL.
      return { location: authorizationUrl(h.oidc, attempt, { endo_handoff: ref }) };
    },
  );

  app.get(
    '/auth/enrolment/callback',
    { config: { auth: { kind: 'enrolment' } } },
    async (request, reply) => {
      const q = request.query as { code?: unknown; state?: unknown };
      const bound = helpers.fromCookie(request);
      // One way back for every failure: her page shows where she is from the transaction.
      const back = () => reply.redirect('/enrol', 303);
      if (!bound || typeof q.code !== 'string' || typeof q.state !== 'string') return back();
      try {
        const attempt = h.transactions.consume(bound.secret, q.state);
        const { idToken } = await exchangeCode(h.oidc, q.code, attempt, deps.fetch);
        const who = await validateIdToken(h.oidc, idToken, attempt, h.keys, deps.now);
        const res = await helpers.call(
          request,
          `/internal/v1/enrolment/transactions/${bound.txId}/callback`,
          { binding_hash: sha256(bound.secret), subject: who.subject },
        );
        if (!res.ok) {
          request.log.warn({ event: 'enrolment.callback_refused', status: res.status });
        } else {
          const status = ((await res.json().catch(() => null)) as { status?: unknown } | null)
            ?.status;
          if (status === 'consent-pending') {
            // A fresh session, never one the browser brought (fixation); any old one ends.
            const old = readCookie(request.headers.cookie, SESSION_COOKIE);
            if (old) await h.sessions.revoke(old);
            const token = await h.sessions.createConsentPending(bound.txId, who.subject);
            sessionCookie(reply, token, CONSENT_PENDING_ABSOLUTE_MS);
          }
        }
      } catch (error) {
        if (!(error instanceof OidcError) && !(error instanceof ProblemError)) throw error;
        request.log.warn({ event: 'enrolment.callback_failed' });
      }
      return back();
    },
  );
}

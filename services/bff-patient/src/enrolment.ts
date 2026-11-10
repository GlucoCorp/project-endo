import { createHash, randomBytes } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { ProblemError, rateLimitedError, type WorkloadTokenSigner } from '@endo/service-kit';
import { readCookie } from './sessions.ts';

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
    void reply.header(
      'set-cookie',
      `${ENROLMENT_COOKIE}=${txId}${secret}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=${String(seconds)}`,
    );
  };
  const clearCookie = (reply: FastifyReply) =>
    void reply.header(
      'set-cookie',
      `${ENROLMENT_COOKIE}=; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=0`,
    );

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

  app.get('/v1/enrolment/status', { config: { auth: { kind: 'enrolment' } } }, async (request) => {
    const bound = fromCookie(request);
    if (!bound) throw noEnrolment();
    const res = await call(request, `/internal/v1/enrolment/transactions/${bound.txId}/status`, {
      binding_hash: sha256(bound.secret),
    });
    if (res.status === 404) throw noEnrolment();
    if (!res.ok) throw unavailable();
    return parseView(await res.json().catch(() => null), false);
  });

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
}

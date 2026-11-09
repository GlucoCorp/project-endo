import Fastify, { LogController, type FastifyInstance, type FastifyReply } from 'fastify';
import rateLimit from '@fastify/rate-limit';
import type { JWTVerifyGetKey } from 'jose';
import {
  ProblemError,
  WEB_SECURITY_HEADERS,
  enforceRouteDeclarations,
  loggerOptions,
  rateLimitedError,
  registerProblemHandlers,
  requestIdFrom,
} from '@endo/service-kit';
import {
  OidcError,
  TRANSACTION_TTL_MS,
  authorizationUrl,
  exchangeCode,
  validateIdToken,
  type OidcConfig,
  type TransactionStore,
} from './oidc.ts';
import type { Resolver } from './resolve.ts';
import {
  OIDC_COOKIE,
  SESSION_COOKIE,
  readCookie,
  type ClinicSession,
  type InMemoryClinicSessions,
} from './sessions.ts';

/** Every route declares how it is reached (spec 2.5); the service will not start otherwise. */
export type ClinicAuth =
  | { readonly kind: 'public'; readonly reason: 'liveness' }
  | { readonly kind: 'oidc'; readonly step: 'start' | 'callback' }
  | { readonly kind: 'session' };

declare module 'fastify' {
  interface FastifyContextConfig {
    auth?: ClinicAuth;
  }
  interface FastifyRequest {
    session: ClinicSession | null;
  }
}

export function isClinicAuth(value: unknown): value is ClinicAuth {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Partial<ClinicAuth> & { step?: unknown; reason?: unknown };
  if (v.kind === 'public') return v.reason === 'liveness';
  if (v.kind === 'oidc') return v.step === 'start' || v.step === 'callback';
  return v.kind === 'session';
}

export interface ClinicBffDeps {
  readonly logLevel: string;
  readonly oidc: OidcConfig;
  /** Keycloak's signing keys, from the configured JWKS URL (never from a token). */
  readonly keys: JWTVerifyGetKey;
  readonly transactions: TransactionStore;
  readonly sessions: InMemoryClinicSessions;
  readonly resolver: Resolver;
  readonly fetch: typeof fetch;
  readonly now: () => Date;
  readonly logStream?: { write(msg: string): void };
  readonly rateLimitPerMinute?: number;
}

const oidcCookie = (value: string, maxAgeSeconds: number) =>
  `${OIDC_COOKIE}=${value}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=${String(maxAgeSeconds)}`;
const sessionCookie = (value: string) =>
  `${SESSION_COOKIE}=${value}; Path=/; Secure; HttpOnly; SameSite=Strict`;

/** Generic refusal: never says which check failed (ADR-0019 section 4). */
function refuse(reply: FastifyReply): never {
  void reply.header('set-cookie', oidcCookie('', 0));
  throw new ProblemError(
    401,
    'authn.sign_in_failed',
    'Sign-in did not complete. Please try again.',
  );
}

/**
 * Backend-for-frontend for the standalone clinic portal (spec 8.2, 8.4; ADR-0019). Tokens never
 * reach the browser; it holds only HttpOnly cookies.
 */
export async function buildClinicBff(deps: ClinicBffDeps): Promise<FastifyInstance> {
  const app = Fastify({
    logger: loggerOptions('bff-clinic', deps.logLevel, deps.logStream),
    bodyLimit: 16 * 1024,
    trustProxy: false,
    genReqId: (req) => requestIdFrom(req.headers['x-request-id'], false),
    logController: new LogController({ disableRequestLogging: true }),
    return503OnClosing: true,
    routerOptions: { ignoreTrailingSlash: false, caseSensitive: true },
    ajv: { customOptions: { removeAdditional: false } },
  });

  app.decorateRequest('session', null);
  enforceRouteDeclarations(app, 'auth', isClinicAuth);
  registerProblemHandlers(app);

  app.addHook('onRequest', async (_request, reply) => {
    void reply.headers(WEB_SECURITY_HEADERS);
  });

  await app.register(rateLimit, { global: false });
  const limit = app.rateLimit({
    max: deps.rateLimitPerMinute ?? 120,
    timeWindow: 60_000,
    errorResponseBuilder: () => rateLimitedError(),
  });
  app.addHook('onRequest', async function (request, reply) {
    if (request.routeOptions.config.auth?.kind === 'public') return;
    await limit.call(this, request, reply);
  });

  app.addHook('onRequest', async (request) => {
    if (request.routeOptions.config.auth?.kind !== 'session') return;
    const token = readCookie(request.headers.cookie, SESSION_COOKIE);
    const session = token ? await deps.sessions.resolve(token) : null;
    if (!session) throw new ProblemError(401, 'authn.session_required', 'Sign in to continue.');
    request.session = session;
  });

  app.get('/healthz', { config: { auth: { kind: 'public', reason: 'liveness' } } }, () => ({
    status: 'ok',
  }));

  // Start: a new transaction bound to this browser by a cookie, then off to Keycloak.
  app.get(
    '/auth/login',
    {
      config: { auth: { kind: 'oidc', step: 'start' } },
      schema: { querystring: { type: 'object', additionalProperties: false, maxProperties: 0 } },
    },
    async (_request, reply) => {
      const tx = deps.transactions.create();
      return reply
        .header('set-cookie', oidcCookie(tx.id, TRANSACTION_TTL_MS / 1000))
        .redirect(authorizationUrl(deps.oidc, tx), 302);
    },
  );

  // Callback: the cookie AND the state must match one live transaction, consumed once.
  app.get(
    '/auth/callback',
    {
      config: { auth: { kind: 'oidc', step: 'callback' } },
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
        const tx = deps.transactions.consume(
          readCookie(request.headers.cookie, OIDC_COOKIE),
          q.state ?? null,
        );
        // RFC 9207: if the provider names itself, it must be ours.
        if (q.error || !q.code || (q.iss !== undefined && q.iss !== deps.oidc.issuer)) {
          throw new OidcError();
        }
        const { idToken } = await exchangeCode(deps.oidc, q.code, tx, deps.fetch);
        const who = await validateIdToken(deps.oidc, idToken, tx, deps.keys, deps.now);
        const personId = await deps.resolver.person(who.issuer, who.subject);
        if (!personId) refuse(reply);
        const memberships = await deps.resolver.memberships(personId);
        if (memberships.length === 0) refuse(reply);
        const token = await deps.sessions.create({
          personId,
          issuer: who.issuer,
          subject: who.subject,
          sid: who.sid,
          memberships,
        });
        // A same-origin page completes the navigation, so the Strict session cookie is sent on
        // the next request (the callback itself arrives cross-site).
        return await reply
          .header('set-cookie', [oidcCookie('', 0), sessionCookie(token)])
          .type('text/html; charset=utf-8')
          .send(
            '<!doctype html><meta charset="utf-8"><meta http-equiv="refresh" content="0;url=/">' +
              '<title>Signing in</title><p><a href="/">Continue</a></p>',
          );
      } catch (error) {
        if (error instanceof ProblemError) throw error;
        return refuse(reply);
      }
    },
  );

  // What the portal needs to render: never identity data, only state and organisations.
  app.get('/v1/session', { config: { auth: { kind: 'session' } } }, (request) => {
    const s = request.session;
    return {
      state: s?.state ?? 'pending-org',
      organisations: (s?.candidates ?? []).map((m) => ({ org_id: m.orgId, role: m.role })),
      active: s?.active ? { org_id: s.active.orgId, role: s.active.role } : null,
    };
  });

  app.addHook('onResponse', async (request, reply) => {
    request.log.info({
      event: 'request.completed',
      method: request.method,
      route: request.routeOptions.url ?? 'unmatched',
      statusCode: reply.statusCode,
      durationMs: Math.round(reply.elapsedTime),
    });
  });

  await app.ready();
  return app;
}

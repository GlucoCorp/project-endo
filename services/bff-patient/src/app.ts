import Fastify, { LogController, type FastifyInstance } from 'fastify';
import rateLimit from '@fastify/rate-limit';
import { z } from 'zod';
import {
  ProblemError,
  WEB_SECURITY_HEADERS,
  enforceRouteDeclarations,
  loggerOptions,
  rateLimitedError,
  registerProblemHandlers,
  requestIdFrom,
  type ServiceClaims,
  type ServiceTokenSigner,
} from '@endo/service-kit';
import { SESSION_COOKIE, readCookie, type SessionResolver } from './sessions.ts';
import { registerEnrolmentRoutes, type EnrolmentDeps } from './enrolment.ts';
import { registerAppShell, type AppShell } from './app-shell.ts';

/**
 * Every BFF route declares how it is authenticated (spec 2.5). `enrolment`: before she has an
 * account, bound to the browser by the enrolment cookie, checked by the route (ADR-0021 section 4).
 */
export type BffAuth =
  | { readonly kind: 'session' }
  | { readonly kind: 'enrolment' }
  | { readonly kind: 'public'; readonly reason: 'liveness' | 'app-shell' | 'sign-out' };

declare module 'fastify' {
  interface FastifyContextConfig {
    auth?: BffAuth;
    /**
     * The route applies its own, stricter rate limit instead of the general one (the plugin runs
     * only one limiter per request).
     */
    ownRateLimit?: true;
  }
  interface FastifyRequest {
    claims: ServiceClaims | null;
  }
}

export function isBffAuth(value: unknown): value is BffAuth {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Partial<BffAuth>;
  return (
    v.kind === 'session' ||
    v.kind === 'enrolment' ||
    (v.kind === 'public' &&
      (v.reason === 'liveness' || v.reason === 'app-shell' || v.reason === 'sign-out'))
  );
}

export interface BffDeps {
  readonly logLevel: string;
  readonly sessions: SessionResolver;
  readonly signer: ServiceTokenSigner;
  readonly apiBaseUrl: string;
  readonly fetch: typeof fetch;
  readonly upstreamTimeoutMs?: number;
  /** The built patient app, served from this origin with a per-response CSP nonce. */
  readonly appShell?: AppShell;
  /** Patient enrolment (ADR-0021). Without it the enrolment routes do not exist (fail closed). */
  readonly enrolment?: EnrolmentDeps;
  readonly logStream?: { write(msg: string): void };
  /**
   * Requests per minute per client IP (spec 12.3; RISK-D01). Per-session and per-account limits,
   * and stricter limits on sign-in endpoints, arrive with real sessions in M1.
   */
  readonly rateLimitPerMinute?: number;
}

const HelloResponse = z.strictObject({
  message: z.string(),
  role: z.string(),
  request_id: z.string(),
});

/**
 * Backend-for-frontend for the patient PWA (spec 8.2, 8.4). The browser holds only an HttpOnly
 * session cookie; service tokens are minted here per call and never reach the browser.
 */
export async function createBffInstance(deps: BffDeps): Promise<FastifyInstance> {
  const app = Fastify({
    logger: loggerOptions('bff-patient', deps.logLevel, deps.logStream),
    bodyLimit: 100 * 1024,
    trustProxy: false,
    // Browser-facing: never trust a client-supplied request id.
    genReqId: (req) => requestIdFrom(req.headers['x-request-id'], false),
    logController: new LogController({ disableRequestLogging: true }),
    return503OnClosing: true,
    routerOptions: { ignoreTrailingSlash: false, caseSensitive: true },
  });

  app.decorateRequest('claims', null);
  enforceRouteDeclarations(app, 'auth', isBffAuth);
  registerProblemHandlers(app);

  // Security headers first, so every response (including 429s) carries them.
  app.addHook('onRequest', async (_request, reply) => {
    void reply.headers(WEB_SECURITY_HEADERS);
  });

  // Registered (and awaited) before the session hook so floods are rejected before session lookups.
  // Keyed by client IP; `trustProxy` is set per deployment behind the load balancer (ADR-0012).
  // App-level hook (not the plugin's per-route hooks, which Fastify runs after app-level ones), so
  // it runs after the headers hook and before authentication. Liveness routes are exempt.
  await app.register(rateLimit, { global: false });
  const limit = app.rateLimit({
    max: deps.rateLimitPerMinute ?? 120,
    timeWindow: 60_000,
    errorResponseBuilder: () => rateLimitedError(),
  });
  app.addHook('onRequest', async function (request, reply) {
    const config = request.routeOptions.config;
    // Liveness only: the app shell is public but still rate limited.
    if (
      (config.auth?.kind === 'public' && config.auth.reason === 'liveness') ||
      config.ownRateLimit
    )
      return;
    await limit.call(this, request, reply);
  });

  app.addHook('onRequest', async (request) => {
    const auth = request.routeOptions.config.auth;
    if (!auth || auth.kind !== 'session') return;
    const token = readCookie(request.headers.cookie, SESSION_COOKIE);
    const session = token ? await deps.sessions.resolve(token) : null;
    if (!session) throw new ProblemError(401, 'authn.session_required', 'Sign in to continue.');
    request.claims = session.claims;
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

  return app;
}

export async function buildBff(deps: BffDeps): Promise<FastifyInstance> {
  const app = await createBffInstance(deps);
  const timeoutMs = deps.upstreamTimeoutMs ?? 5000;

  app.get('/healthz', { config: { auth: { kind: 'public', reason: 'liveness' } } }, () => ({
    status: 'ok',
  }));

  app.get('/v1/hello', { config: { auth: { kind: 'session' } } }, async (request, reply) => {
    if (!request.claims)
      throw new ProblemError(401, 'authn.session_required', 'Sign in to continue.');
    const serviceToken = await deps.signer.sign(request.claims, 'api');
    let res: Response;
    try {
      res = await deps.fetch(new URL('/v1/hello', deps.apiBaseUrl), {
        headers: {
          authorization: `Bearer ${serviceToken}`,
          'x-request-id': request.id,
          accept: 'application/json',
        },
        signal: AbortSignal.timeout(timeoutMs),
        redirect: 'error',
      });
    } catch {
      throw new ProblemError(
        502,
        'upstream_unavailable',
        'The service is not available right now. Try again soon.',
      );
    }
    if (res.status === 401 || res.status === 403) {
      // Pass through the status, never the upstream body.
      throw new ProblemError(
        res.status,
        res.status === 401 ? 'authn.rejected' : 'authz.denied',
        'You do not have access to this.',
      );
    }
    const parsed = res.ok ? HelloResponse.safeParse(await res.json()) : null;
    if (!parsed?.success) {
      throw new ProblemError(
        502,
        'upstream_error',
        'The service is not available right now. Try again soon.',
      );
    }
    return reply.send(parsed.data);
  });

  if (deps.enrolment) registerEnrolmentRoutes(app, deps.enrolment);
  if (deps.appShell) registerAppShell(app, deps.appShell);

  await app.ready();
  return app;
}

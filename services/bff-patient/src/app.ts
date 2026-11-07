import Fastify, { LogController, type FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  ProblemError,
  WEB_SECURITY_HEADERS,
  enforceRouteDeclarations,
  loggerOptions,
  registerProblemHandlers,
  requestIdFrom,
  type ServiceClaims,
  type ServiceTokenSigner,
} from '@endo/service-kit';
import { SESSION_COOKIE, readCookie, type SessionResolver } from './sessions.ts';

/** Every BFF route declares how it is authenticated (spec 2.5). */
export type BffAuth =
  { readonly kind: 'session' } | { readonly kind: 'public'; readonly reason: 'liveness' };

declare module 'fastify' {
  interface FastifyContextConfig {
    auth?: BffAuth;
  }
  interface FastifyRequest {
    claims: ServiceClaims | null;
  }
}

export function isBffAuth(value: unknown): value is BffAuth {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Partial<BffAuth>;
  return v.kind === 'session' || (v.kind === 'public' && v.reason === 'liveness');
}

export interface BffDeps {
  readonly logLevel: string;
  readonly sessions: SessionResolver;
  readonly signer: ServiceTokenSigner;
  readonly apiBaseUrl: string;
  readonly fetch: typeof fetch;
  readonly upstreamTimeoutMs?: number;
  readonly logStream?: { write(msg: string): void };
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
export function createBffInstance(deps: BffDeps): FastifyInstance {
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

  app.addHook('onRequest', async (request, reply) => {
    void reply.headers(WEB_SECURITY_HEADERS);
    const auth = request.routeOptions.config.auth;
    if (!auth || auth.kind === 'public') return;
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
  const app = createBffInstance(deps);
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

  await app.ready();
  return app;
}

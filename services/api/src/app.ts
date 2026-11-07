import Fastify, { LogController, type FastifyInstance, type FastifyRequest } from 'fastify';
import {
  can,
  isAction,
  type Action,
  type AuthzContext,
  type ConsentPurpose,
  type Resource,
  type Subject,
} from '@endo/authz';
import type { AuditWriter } from '@endo/audit';
import {
  API_SECURITY_HEADERS,
  ProblemError,
  ServiceTokenError,
  enforceRouteDeclarations,
  loggerOptions,
  registerProblemHandlers,
  requestIdFrom,
  type ServiceTokenVerifier,
} from '@endo/service-kit';
import { registerHelloRoutes } from './routes/hello.ts';
import { registerHealthRoutes } from './routes/health.ts';

/**
 * Every route declares exactly one of these in `config.policy` (spec 2.5, 10.4). A route without
 * one cannot be registered: the service refuses to start.
 */
export type RoutePolicy =
  | { readonly kind: 'public'; readonly reason: 'liveness' }
  | {
      readonly kind: 'protected';
      readonly action: Action;
      /** Audit resource type code, e.g. `treatment_episode`. */
      readonly resourceType: string;
      readonly purpose: 'treatment' | 'patient_request' | 'operations' | 'support' | 'system_check';
      /** Build the authz resource from the request (params only; never the body). */
      readonly resource: (
        request: FastifyRequest,
        subject: Subject,
      ) => Resource & { readonly id: string | null };
    };

declare module 'fastify' {
  interface FastifyContextConfig {
    policy?: RoutePolicy;
  }
  interface FastifyRequest {
    subject: Subject | null;
  }
}

export function isRoutePolicy(value: unknown): value is RoutePolicy {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Partial<RoutePolicy>;
  if (v.kind === 'public') return v.reason === 'liveness';
  return v.kind === 'protected' && isAction(v.action) && typeof v.resource === 'function';
}

export interface ApiDeps {
  readonly logLevel: string;
  readonly verifier: ServiceTokenVerifier;
  readonly audit: AuditWriter;
  readonly now: () => Date;
  /** Loads the current consent state for a patient. M1 replaces the default with the consent service. */
  readonly loadConsents: (patientId: string | null) => Promise<ReadonlySet<ConsentPurpose>>;
  readonly logStream?: { write(msg: string): void };
}

/** Core domain API (spec 8.2). Internal only: reachable from BFFs and jobs, never from browsers. */
export async function buildApi(deps: ApiDeps): Promise<FastifyInstance> {
  const app = createApiInstance(deps);
  registerHealthRoutes(app);
  registerHelloRoutes(app);
  await app.ready();
  return app;
}

/** The hardened instance with hooks but no routes. Exported so tests can prove the guards hold. */
export function createApiInstance(deps: ApiDeps): FastifyInstance {
  const app = Fastify({
    logger: loggerOptions('api', deps.logLevel, deps.logStream),
    bodyLimit: 100 * 1024, // spec 12.3
    trustProxy: false,
    // Internal service: callers are BFFs that already assigned a request id.
    genReqId: (req) => requestIdFrom(req.headers['x-request-id'], true),
    logController: new LogController({ disableRequestLogging: true }),
    return503OnClosing: true,
    routerOptions: { ignoreTrailingSlash: false, caseSensitive: true },
  });

  app.decorateRequest('subject', null);
  enforceRouteDeclarations(app, 'policy', isRoutePolicy);
  registerProblemHandlers(app);

  app.addHook('onRequest', async (request, reply) => {
    void reply.headers({ ...API_SECURITY_HEADERS, 'x-request-id': request.id });
    const policy = request.routeOptions.config.policy;
    // Unmatched routes (404) carry no policy; the not-found handler answers them.
    if (!policy || policy.kind === 'public') return;

    let subject: Subject;
    try {
      const claims = await deps.verifier.verifyHeader(request.headers.authorization);
      subject = {
        id: claims.sub,
        role: claims.role,
        orgId: claims.org_id,
        patientId: claims.patient_id,
        active: true,
      };
    } catch (error) {
      const reason = error instanceof ServiceTokenError ? error.code : 'authn.invalid';
      await deps.audit.write({
        actor: { id: null, role: 'anonymous' },
        action: policy.action,
        resource: { type: policy.resourceType, id: null },
        org_id: null,
        purpose_of_use: policy.purpose,
        outcome: 'denied',
        reason,
        request_id: request.id,
      });
      throw new ProblemError(401, reason, 'Sign in to continue.');
    }

    const resource = policy.resource(request, subject);
    const context: AuthzContext = {
      now: deps.now(),
      consents: await deps.loadConsents(resource.patientId),
    };
    const decision = can(subject, policy.action, resource, context);

    // Audit the access decision before any handler runs. If this write fails the request fails.
    await deps.audit.write({
      actor: { id: subject.id, role: subject.role },
      action: policy.action,
      resource: { type: policy.resourceType, id: resource.id },
      org_id: resource.orgId,
      purpose_of_use: policy.purpose,
      outcome: decision.allow ? 'success' : 'denied',
      reason: decision.allow ? null : decision.reason,
      request_id: request.id,
    });

    if (!decision.allow) {
      throw new ProblemError(403, decision.reason, 'You do not have access to this.');
    }
    request.subject = subject;
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

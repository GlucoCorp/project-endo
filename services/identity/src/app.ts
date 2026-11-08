import Fastify, { LogController, type FastifyInstance, type FastifyRequest } from 'fastify';
import rateLimit from '@fastify/rate-limit';
import type { AuditWriter } from '@endo/audit';
import { uuidv7 } from '@endo/domain';
import {
  API_SECURITY_HEADERS,
  ProblemError,
  ServiceTokenError,
  enforceRouteDeclarations,
  loggerOptions,
  rateLimitedError,
  registerProblemHandlers,
  requestIdFrom,
  type WorkloadCaller,
  type WorkloadTokenVerifier,
} from '@endo/service-kit';
import type { PersonStore } from './persons.ts';

/**
 * Every route declares its access (ADR-0018). Workload routes name the one scope they require;
 * the service refuses to start if a route declares nothing valid (deny by default, spec 2.5).
 */
export type IdentityAccess =
  | { readonly kind: 'public'; readonly reason: 'liveness' }
  | {
      readonly kind: 'workload';
      readonly scope: string;
      /** Audit action code, e.g. `identity.person.create`. */
      readonly action: string;
      readonly resourceId: (request: FastifyRequest) => string | null;
    };

declare module 'fastify' {
  interface FastifyContextConfig {
    access?: IdentityAccess;
  }
  interface FastifyRequest {
    caller: WorkloadCaller | null;
  }
}

export function isIdentityAccess(value: unknown): value is IdentityAccess {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Partial<IdentityAccess>;
  if (v.kind === 'public') return v.reason === 'liveness';
  return (
    v.kind === 'workload' &&
    typeof v.scope === 'string' &&
    typeof v.action === 'string' &&
    typeof v.resourceId === 'function'
  );
}

export interface IdentityDeps {
  readonly logLevel: string;
  readonly verifier: WorkloadTokenVerifier;
  readonly audit: AuditWriter;
  readonly persons: PersonStore;
  readonly logStream?: { write(msg: string): void };
  readonly rateLimitPerMinute?: number;
}

// Same shape the audit schema accepts (RFC 9562 variant), so a valid id can always be audited.
const UUID = '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$';
const UUID_RE = new RegExp(UUID);
/** Audit runs before schema validation, so only a well-formed id may reach the audit event. */
const idParam = (req: FastifyRequest): string | null => {
  const id = (req.params as { id?: unknown }).id;
  return typeof id === 'string' && UUID_RE.test(id) ? id : null;
};

/**
 * Identity vault service (spec 5.2, 8.2): the only component that touches the identity database.
 * Internal only; callers are other services with workload tokens, never browsers.
 */
export async function buildIdentity(deps: IdentityDeps): Promise<FastifyInstance> {
  const app = Fastify({
    logger: loggerOptions('identity', deps.logLevel, deps.logStream),
    bodyLimit: 16 * 1024,
    trustProxy: false,
    genReqId: (req) => requestIdFrom(req.headers['x-request-id'], true),
    logController: new LogController({ disableRequestLogging: true }),
    return503OnClosing: true,
    routerOptions: { ignoreTrailingSlash: false, caseSensitive: true },
    // Spec 12.3: reject unknown input instead of silently dropping it (Fastify strips by default).
    ajv: { customOptions: { removeAdditional: false } },
  });

  app.decorateRequest('caller', null);
  enforceRouteDeclarations(app, 'access', isIdentityAccess);
  registerProblemHandlers(app);

  app.addHook('onRequest', async (request, reply) => {
    void reply.headers({ ...API_SECURITY_HEADERS, 'x-request-id': request.id });
  });

  await app.register(rateLimit, { global: false });
  const limit = app.rateLimit({
    max: deps.rateLimitPerMinute ?? 600,
    timeWindow: 60_000,
    errorResponseBuilder: () => rateLimitedError(),
  });
  app.addHook('onRequest', async function (request, reply) {
    if (request.routeOptions.config.access?.kind === 'public') return;
    await limit.call(this, request, reply);
  });

  // Authenticate and authorise, then audit the decision before any handler runs (spec 2.6).
  app.addHook('onRequest', async (request) => {
    const access = request.routeOptions.config.access;
    if (!access || access.kind === 'public') return;
    let caller: WorkloadCaller | null = null;
    let reason: string | null = null;
    try {
      caller = await deps.verifier.verifyHeader(request.headers.authorization);
      if (!caller.scopes.includes(access.scope)) reason = 'authz.scope_missing';
    } catch (error) {
      reason = error instanceof ServiceTokenError ? error.code : 'authn.invalid';
    }
    await deps.audit.write({
      actor: { id: null, role: 'system' },
      action: access.action,
      resource: { type: 'person', id: reason === null ? access.resourceId(request) : null },
      org_id: null,
      purpose_of_use: 'operations',
      outcome: reason === null ? 'success' : 'denied',
      reason,
      request_id: request.id,
    });
    if (!caller) throw new ProblemError(401, reason ?? 'authn.invalid', 'Authentication required.');
    if (reason) throw new ProblemError(403, reason, 'Not allowed.');
    request.caller = caller;
  });

  /** The outcome of an authorised operation, with the person it concerned (spec 2.6). */
  const auditResult = (request: FastifyRequest, action: string, personId: string | null) =>
    deps.audit.write({
      actor: { id: null, role: 'system' },
      action,
      resource: { type: 'person', id: personId },
      org_id: null,
      purpose_of_use: 'operations',
      outcome: 'success',
      reason: null,
      request_id: request.id,
    });

  app.get('/healthz', { config: { access: { kind: 'public', reason: 'liveness' } } }, () => ({
    status: 'ok',
  }));

  app.post(
    '/internal/v1/persons',
    {
      config: {
        access: {
          kind: 'workload',
          scope: 'identity.person.create',
          action: 'identity.person.create',
          resourceId: () => null,
        },
      },
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          properties: {
            email: { type: ['string', 'null'], maxLength: 254, pattern: '^[^@\\s]+@[^@\\s]+$' },
            display_name: { type: ['string', 'null'], minLength: 1, maxLength: 200 },
          },
        },
        response: {
          201: {
            type: 'object',
            additionalProperties: false,
            required: ['person_id'],
            properties: { person_id: { type: 'string' } },
          },
        },
      },
    },
    async (request, reply) => {
      const body = (request.body ?? {}) as { email?: string | null; display_name?: string | null };
      const id = uuidv7();
      await deps.persons.create({
        id,
        email: body.email ?? null,
        displayName: body.display_name ?? null,
      });
      await auditResult(request, 'identity.person.created', id);
      return reply.code(201).send({ person_id: id });
    },
  );

  app.post(
    '/internal/v1/persons/:id/erasure',
    {
      config: {
        access: {
          kind: 'workload',
          scope: 'identity.person.erase',
          action: 'identity.person.erase',
          resourceId: idParam,
        },
      },
      schema: {
        params: {
          type: 'object',
          required: ['id'],
          additionalProperties: false,
          properties: { id: { type: 'string', pattern: UUID } },
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      if (!(await deps.persons.erase(id))) {
        throw new ProblemError(404, 'identity.person_not_found', 'Not found.');
      }
      await auditResult(request, 'identity.person.erased', id);
      return reply.code(204).send();
    },
  );

  // An authorised request that then failed (validation, not found, storage) is audited as an
  // error. The response is already sent, so a failure here is logged, never swallowed silently.
  app.addHook('onResponse', async (request, reply) => {
    const access = request.routeOptions.config.access;
    if (access?.kind === 'workload' && request.caller && reply.statusCode >= 400) {
      await deps.audit
        .write({
          actor: { id: null, role: 'system' },
          action: access.action,
          resource: { type: 'person', id: access.resourceId(request) },
          org_id: null,
          purpose_of_use: 'operations',
          outcome: 'error',
          reason: `http.status_${String(reply.statusCode)}`,
          request_id: request.id,
        })
        .catch(() => {
          request.log.error({ event: 'audit.write_failed' });
        });
    }
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

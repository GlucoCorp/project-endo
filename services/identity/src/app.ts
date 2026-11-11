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
import {
  registerClinicEnrolmentRoutes,
  registerPatientEnrolmentRoutes,
  type PatientRouteDeps,
} from './enrolment/routes.ts';
import { registerHandoffRoutes } from './enrolment/handoff-routes.ts';

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
      /** Audited resource type; `person` unless the route says otherwise. */
      readonly resourceType?: 'person' | 'enrolment_transaction';
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
    typeof v.resourceId === 'function' &&
    // Checked at run time: route config is untyped at registration.
    [undefined, 'person', 'enrolment_transaction'].includes(v.resourceType)
  );
}

export interface IdentityDeps {
  readonly logLevel: string;
  readonly verifier: WorkloadTokenVerifier;
  readonly audit: AuditWriter;
  readonly persons: PersonStore;
  /** The one identity-provider issuer this deployment trusts (ADR-0019, single-issuer invariant). */
  readonly idpIssuer: string;
  /**
   * Patient-side enrolment coordination (ADR-0021 section 13). Only with the identity database;
   * without it these routes do not exist (fail closed).
   */
  readonly enrolment?: PatientRouteDeps;
  /** Starts activation after her consent (ADR-0021 section 10). */
  readonly onConsented?: (transactionId: string) => void;
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
      resource: {
        type: access.resourceType ?? 'person',
        id: reason === null ? access.resourceId(request) : null,
      },
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

  // ADR-0019: which person signed in as this identity-provider subject. bff-clinic only.
  app.post(
    '/internal/v1/subjects/resolve',
    {
      config: {
        access: {
          kind: 'workload',
          scope: 'identity.subject.resolve',
          action: 'identity.subject.resolve',
          resourceId: () => null,
        },
      },
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['idp_issuer', 'idp_subject'],
          properties: {
            idp_issuer: { type: 'string', minLength: 1, maxLength: 512 },
            idp_subject: { type: 'string', minLength: 1, maxLength: 255 },
          },
        },
        response: {
          200: {
            type: 'object',
            additionalProperties: false,
            required: ['person_id'],
            properties: { person_id: { type: 'string' } },
          },
        },
      },
    },
    async (request) => {
      const { idp_issuer, idp_subject } = request.body as {
        idp_issuer: string;
        idp_subject: string;
      };
      // Single-issuer invariant (ADR-0019 section 4): subjects are only meaningful for our issuer.
      if (idp_issuer !== deps.idpIssuer) {
        throw new ProblemError(404, 'identity.subject_unknown', 'Not found.');
      }
      const personId = await deps.persons.resolveSubject(idp_subject);
      if (!personId) throw new ProblemError(404, 'identity.subject_unknown', 'Not found.');
      await auditResult(request, 'identity.subject.resolved', personId);
      return { person_id: personId };
    },
  );

  // A returning patient's sign-in (REQ-001): her person and patient record for this subject.
  // bff-patient only. Exactly one patient record signs in; more is not supported yet (spec
  // Section 24), and none means she is not a patient (yet): both are refused.
  app.post(
    '/internal/v1/patients/resolve',
    {
      config: {
        access: {
          kind: 'workload',
          scope: 'identity.patient.resolve',
          action: 'identity.patient.resolve',
          resourceId: () => null,
        },
      },
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['idp_issuer', 'idp_subject'],
          properties: {
            idp_issuer: { type: 'string', minLength: 1, maxLength: 512 },
            idp_subject: { type: 'string', minLength: 1, maxLength: 255 },
          },
        },
        response: {
          200: {
            type: 'object',
            additionalProperties: false,
            required: ['person_id', 'patient_id', 'org_id'],
            properties: {
              person_id: { type: 'string' },
              patient_id: { type: 'string' },
              org_id: { type: 'string' },
            },
          },
        },
      },
    },
    async (request) => {
      const { idp_issuer, idp_subject } = request.body as {
        idp_issuer: string;
        idp_subject: string;
      };
      const unknown = () => new ProblemError(404, 'identity.subject_unknown', 'Not found.');
      if (idp_issuer !== deps.idpIssuer) throw unknown();
      const found = await deps.persons.resolvePatient(idp_subject);
      const only = found?.patients.length === 1 ? found.patients[0] : undefined;
      if (!found || !only) throw unknown();
      await auditResult(request, 'identity.patient.resolved', found.personId);
      return { person_id: found.personId, patient_id: only.patientId, org_id: only.orgId };
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
          resource: { type: access.resourceType ?? 'person', id: access.resourceId(request) },
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

  if (deps.enrolment) {
    registerPatientEnrolmentRoutes(app, deps.enrolment);
    registerClinicEnrolmentRoutes(app, deps.enrolment);
    registerHandoffRoutes(app, {
      ...deps.enrolment,
      issuer: deps.idpIssuer,
      ...(deps.onConsented ? { onConsented: deps.onConsented } : {}),
    });
  }

  await app.ready();
  return app;
}

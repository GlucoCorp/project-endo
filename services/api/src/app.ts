import Fastify, { LogController, type FastifyInstance, type FastifyRequest } from 'fastify';
import rateLimit from '@fastify/rate-limit';
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
import type {
  ConsentStore,
  IdempotentInvitationStore,
  MembershipStore,
} from '@endo/clinical-store';
import type { EnvelopeSealer } from '@endo/crypto';
import {
  API_SECURITY_HEADERS,
  ProblemError,
  ServiceTokenError,
  enforceRouteDeclarations,
  loggerOptions,
  rateLimitedError,
  registerProblemHandlers,
  requestIdFrom,
  type ServiceTokenVerifier,
  type WorkloadCaller,
  type WorkloadTokenVerifier,
} from '@endo/service-kit';
import { registerConsentRoutes } from './routes/consents.ts';
import { registerEpisodeRoutes, type EpisodeRouteDeps } from './routes/episodes.ts';
import { registerVerdictRoutes } from './routes/verdicts.ts';
import { registerReminderRoutes } from './routes/reminders.ts';
import { registerReviewRoutes, type ReviewRouteDeps } from './routes/reviews.ts';
import { registerHistoryRoutes, type HistoryRouteDeps } from './routes/history.ts';
import type { ReminderStore } from '@endo/clinical-store';
import type { FieldCipher } from '@endo/crypto';
import type { VerdictService } from './verdicts.ts';
import { registerEnrolmentRoutes } from './routes/enrolments.ts';
import { registerHelloRoutes } from './routes/hello.ts';
import { registerMembershipRoutes } from './routes/memberships.ts';
import { registerCoordinatorRoutes, type EnrolmentCoordination } from './routes/coordinator.ts';
import type { IdentityEnrolment } from './identity-client.ts';
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
    }
  /**
   * Service-to-service routes with no end user (ADR-0018, ADR-0019). The caller must present a
   * workload token holding exactly this scope; the route never sees user authorisation.
   */
  | {
      readonly kind: 'workload';
      readonly scope: string;
      /** Audit action code, e.g. `api.membership.resolve`. */
      readonly action: string;
      readonly resourceType: string;
    };

declare module 'fastify' {
  interface FastifyContextConfig {
    policy?: RoutePolicy;
  }
  interface FastifyRequest {
    subject: Subject | null;
    /** For clinicians and org admins: their clinical-store id, resolved from current membership. */
    clinicianId: string | null;
    /** For workload routes: the verified calling service. */
    workload: WorkloadCaller | null;
  }
}

export function isRoutePolicy(value: unknown): value is RoutePolicy {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Partial<RoutePolicy>;
  if (v.kind === 'public') return v.reason === 'liveness';
  if (v.kind === 'workload') {
    return (
      typeof v.scope === 'string' &&
      typeof v.action === 'string' &&
      typeof v.resourceType === 'string'
    );
  }
  return v.kind === 'protected' && isAction(v.action) && typeof v.resource === 'function';
}

export interface ApiDeps {
  readonly logLevel: string;
  readonly verifier: ServiceTokenVerifier;
  /** Workload callers (ADR-0018). Without it, every workload route answers 401 (fail closed). */
  readonly workloadVerifier?: WorkloadTokenVerifier;
  readonly audit: AuditWriter;
  /** Enrolment invitations in the clinical store, created at most once per Idempotency-Key. */
  readonly invitations: IdempotentInvitationStore;
  /** Seals responses kept for idempotent replay. */
  readonly sealer: EnvelopeSealer;
  /** Relays queued audit events to the audit store; called after commits (spec 2.6). */
  readonly relayOutbox?: () => Promise<void>;
  /** Current clinician membership; staff whose membership is missing, inactive or changed are denied. */
  readonly memberships: MembershipStore;
  readonly now: () => Date;
  /** Her consent decisions (spec 13.1). Authorisation reads the current state on every request. */
  readonly consents: ConsentStore;
  /**
   * Clinical-store reads for the enrolment coordinator (ADR-0021 section 13). Only with a
   * clinical database; without it the coordinator routes do not exist (fail closed).
   */
  readonly coordination?: EnrolmentCoordination;
  /** The identity service's clinic-side enrolment route (ADR-0021). Without it, no confirm. */
  readonly identity?: IdentityEnrolment;
  /**
   * Episodes, check-ins and red flags (M2). Only with a clinical database and loaded clinical
   * content; without them these routes do not exist (fail closed).
   */
  readonly episodes?: Omit<EpisodeRouteDeps, 'onCommitted' | 'now'>;
  /** Verdicts in shadow mode (M3). Only with a clinical database (fail closed). */
  readonly verdicts?: VerdictService;
  /** Her history, sharing and access log (M4). Only with a clinical database (fail closed). */
  readonly history?: Omit<HistoryRouteDeps, 'onCommitted' | 'writer'>;
  /** The clinician desk (M4). Only with a clinical database (fail closed). */
  readonly reviews?: Omit<ReviewRouteDeps, 'onCommitted' | 'now' | 'audit'>;
  /** Weekly reminders (spec 15): her subscriptions. Only with a clinical database. */
  readonly reminders?: {
    readonly store: ReminderStore;
    readonly cipherFor: (orgId: string) => FieldCipher;
  };
  readonly logStream?: { write(msg: string): void };
  /**
   * Requests per minute per caller (spec 12.3; RISK-D01). Callers are BFFs and jobs, so this is a
   * backstop; per-IP and per-account limits are enforced in the BFFs.
   */
  readonly rateLimitPerMinute?: number;
}

/** Purposes she has currently granted; none when the resource names no patient. */
async function grantedPurposes(
  consents: ConsentStore,
  orgId: string | null,
  patientId: string | null,
): Promise<ReadonlySet<ConsentPurpose>> {
  if (!orgId || !patientId) return new Set();
  const current = await consents.current(orgId, patientId);
  return new Set(current.filter((c) => c.status === 'granted').map((c) => c.purpose));
}

/** Core domain API (spec 8.2). Internal only: reachable from BFFs and jobs, never from browsers. */
export async function buildApi(deps: ApiDeps): Promise<FastifyInstance> {
  const app = await createApiInstance(deps);
  registerHealthRoutes(app);
  registerHelloRoutes(app);
  registerMembershipRoutes(app, { memberships: deps.memberships, audit: deps.audit });
  // Best effort: the periodic relay in main.ts picks up anything this misses.
  const onCommitted = () => {
    deps.relayOutbox?.().catch(() => {
      app.log.warn({ event: 'audit.outbox_relay_failed' });
    });
  };
  if (deps.coordination)
    registerCoordinatorRoutes(app, {
      coordination: deps.coordination,
      audit: deps.audit,
      onCommitted,
      consents: deps.consents,
    });
  registerConsentRoutes(app, { consents: deps.consents });
  if (deps.episodes) registerEpisodeRoutes(app, { ...deps.episodes, onCommitted, now: deps.now });
  if (deps.verdicts) registerVerdictRoutes(app, { verdicts: deps.verdicts, onCommitted });
  if (deps.reviews)
    registerReviewRoutes(app, {
      ...deps.reviews,
      onCommitted,
      now: deps.now,
      audit: deps.audit,
    });
  if (deps.history)
    registerHistoryRoutes(app, { ...deps.history, onCommitted, writer: deps.audit });
  if (deps.reminders)
    registerReminderRoutes(app, {
      reminders: deps.reminders.store,
      cipherFor: deps.reminders.cipherFor,
    });
  registerEnrolmentRoutes(app, {
    invitations: deps.invitations,
    sealer: deps.sealer,
    onCommitted,
    ...(deps.identity ? { identity: deps.identity } : {}),
  });
  await app.ready();
  return app;
}

/** The hardened instance with hooks but no routes. Exported so tests can prove the guards hold. */
export async function createApiInstance(deps: ApiDeps): Promise<FastifyInstance> {
  const app = Fastify({
    logger: loggerOptions('api', deps.logLevel, deps.logStream),
    bodyLimit: 100 * 1024, // spec 12.3
    trustProxy: false,
    // Internal service: callers are BFFs that already assigned a request id.
    genReqId: (req) => requestIdFrom(req.headers['x-request-id'], true),
    logController: new LogController({ disableRequestLogging: true }),
    return503OnClosing: true,
    routerOptions: { ignoreTrailingSlash: false, caseSensitive: true },
    // Spec 12.3: reject unknown input instead of silently dropping it (Fastify strips by default).
    ajv: { customOptions: { removeAdditional: false } },
  });

  app.decorateRequest('subject', null);
  app.decorateRequest('clinicianId', null);
  app.decorateRequest('workload', null);
  enforceRouteDeclarations(app, 'policy', isRoutePolicy);
  registerProblemHandlers(app);

  // Security headers and request id first, so every response (including 429s) carries them.
  app.addHook('onRequest', async (request, reply) => {
    void reply.headers({ ...API_SECURITY_HEADERS, 'x-request-id': request.id });
  });

  // Registered (and awaited) before the auth hook so floods are rejected before any token work.
  // In-memory per instance; a shared store arrives with the infrastructure slice (ADR-0012).
  // App-level hook (not the plugin's per-route hooks, which Fastify runs after app-level ones), so
  // it runs after the headers hook and before authentication. Liveness routes are exempt.
  await app.register(rateLimit, { global: false });
  const limit = app.rateLimit({
    max: deps.rateLimitPerMinute ?? 1200,
    timeWindow: 60_000,
    errorResponseBuilder: () => rateLimitedError(),
  });
  app.addHook('onRequest', async function (request, reply) {
    if (request.routeOptions.config.policy?.kind === 'public') return;
    await limit.call(this, request, reply);
  });

  app.addHook('onRequest', async (request) => {
    const policy = request.routeOptions.config.policy;
    // Unmatched routes (404) carry no policy; the not-found handler answers them.
    if (!policy || policy.kind === 'public') return;

    if (policy.kind === 'workload') {
      let caller: WorkloadCaller | null = null;
      let reason: string | null = null;
      try {
        if (!deps.workloadVerifier) throw new ServiceTokenError('authn.invalid');
        caller = await deps.workloadVerifier.verifyHeader(request.headers.authorization);
        if (!caller.scopes.includes(policy.scope)) reason = 'authz.scope_missing';
      } catch (error) {
        reason = error instanceof ServiceTokenError ? error.code : 'authn.invalid';
      }
      await deps.audit.write({
        actor: { id: null, role: 'system' },
        action: policy.action,
        resource: { type: policy.resourceType, id: null },
        org_id: null,
        purpose_of_use: 'operations',
        outcome: reason === null ? 'success' : 'denied',
        reason,
        request_id: request.id,
      });
      if (!caller) throw new ProblemError(401, reason ?? 'authn.invalid', 'Sign in to continue.');
      if (reason) throw new ProblemError(403, reason, 'You do not have access to this.');
      request.workload = caller;
      return;
    }

    let subject: Subject;
    let clinicianId: string | null = null;
    try {
      const claims = await deps.verifier.verifyHeader(request.headers.authorization);
      // Organisation staff: the token says who they are; the clinical store says whether they
      // are still an active member with that role. Anything else makes them inactive (denied).
      let active = true;
      if (claims.role === 'clinician' || claims.role === 'org_admin') {
        const m = claims.org_id ? await deps.memberships.find(claims.org_id, claims.sub) : null;
        active = m !== null && m.active && m.role === claims.role;
        clinicianId = active && m ? m.clinicianId : null;
      }
      subject = {
        id: claims.sub,
        role: claims.role,
        orgId: claims.org_id,
        patientId: claims.patient_id,
        active,
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
      // Current decisions, read on every request, so a withdrawal takes effect immediately.
      consents: await grantedPurposes(deps.consents, resource.orgId, resource.patientId),
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
    request.clinicianId = clinicianId;
  });

  // A workload request that was allowed and then failed is audited as an error (safe code only).
  // The response is already sent, so a failure here is logged, never swallowed silently.
  app.addHook('onResponse', async (request, reply) => {
    const policy = request.routeOptions.config.policy;
    if (policy?.kind === 'workload' && request.workload && reply.statusCode >= 400) {
      await deps.audit
        .write({
          actor: { id: null, role: 'system' },
          action: policy.action,
          resource: { type: policy.resourceType, id: null },
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

  return app;
}

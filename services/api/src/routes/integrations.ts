import { randomBytes } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { AuditEventInput, type AuditEventInputType } from '@endo/audit';
import type { IntegrationClient, IntegrationStore } from '@endo/clinical-store';
import { uuidv7 } from '@endo/domain';
import { ProblemError } from '@endo/service-kit';
import { patientBundle, type DataRightsRouteDeps } from './data-rights.ts';

/**
 * Record-system integrations (M7; spec 9.3, 16.3, 16.4; RISK-E02).
 *
 * - The organisation admin registers a SMART Backend Services client (public keys and scopes
 *   only) and can switch it off at once (the kill switch).
 * - The integration service, with its own workload key, resolves a client by client_id and reads
 *   one patient's resources. Only patients of the client's organisation who currently share with
 *   the care team; never the clinicians' notes or her access log. Each read is audited against
 *   her record, so it shows in her access log.
 */
export interface IntegrationRouteDeps extends Omit<
  DataRightsRouteDeps,
  'deletions' | 'onCommitted'
> {
  readonly integrations: IntegrationStore;
  readonly writer: { write(e: AuditEventInputType): Promise<unknown> };
  readonly onCommitted: () => void;
}

/** What a client may be granted (spec 9.3: read and search only). */
export const INTEGRATION_SCOPES = [
  'system/Patient.rs',
  'system/CarePlan.rs',
  'system/Goal.rs',
  'system/QuestionnaireResponse.rs',
  'system/Observation.rs',
  'system/Consent.rs',
] as const;

const UUID = '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
const PRIVATE_MEMBERS = ['d', 'p', 'q', 'dp', 'dq', 'qi', 'k', 'oth'];

/** Public signing keys only, of the kinds SMART Backend Services allows (RS384, ES384). */
export function validJwks(v: unknown): v is { keys: Record<string, unknown>[] } {
  const keys = (v as { keys?: unknown } | null)?.keys;
  if (!Array.isArray(keys) || keys.length === 0 || keys.length > 5) return false;
  return keys.every((k: unknown) => {
    if (typeof k !== 'object' || k === null) return false;
    const m = new Map<string, unknown>(Object.entries(k as Record<string, unknown>));
    if (PRIVATE_MEMBERS.some((p) => m.has(p))) return false;
    if (typeof m.get('kid') !== 'string') return false;
    const kty = m.get('kty');
    const alg = m.get('alg');
    if (kty === 'EC')
      return (
        alg === 'ES384' &&
        m.get('crv') === 'P-384' &&
        typeof m.get('x') === 'string' &&
        typeof m.get('y') === 'string'
      );
    if (kty === 'RSA')
      return alg === 'RS384' && typeof m.get('n') === 'string' && typeof m.get('e') === 'string';
    return false;
  });
}

const clientBody = (c: IntegrationClient) => ({
  id: c.id,
  client_id: c.clientId,
  name: c.name,
  scopes: c.scopes,
  active: c.active,
  created_at: c.createdAt.toISOString(),
});

export function registerIntegrationRoutes(app: FastifyInstance, deps: IntegrationRouteDeps): void {
  const policy = {
    kind: 'protected' as const,
    action: 'org.settings.manage' as const,
    resourceType: 'integration_client',
    purpose: 'operations' as const,
    resource: (_r: FastifyRequest, s: { orgId: string | null }) => ({
      type: 'integration_client',
      id: null,
      orgId: s.orgId,
      patientId: null,
    }),
  };
  const org = (r: FastifyRequest) => {
    const orgId = r.subject?.orgId;
    const clinicianId = r.clinicianId;
    if (!orgId || !clinicianId) throw new ProblemError(403, 'authz.org_mismatch', 'Not allowed.');
    return { orgId, clinicianId };
  };
  const audit = (r: FastifyRequest, action: string, id: string, orgId: string) => ({
    id: uuidv7(),
    ...AuditEventInput.parse({
      actor: { id: r.subject?.id ?? null, role: r.subject?.role ?? 'org_admin' },
      action,
      resource: { type: 'integration_client', id },
      org_id: orgId,
      purpose_of_use: 'operations',
      outcome: 'success',
      reason: null,
      request_id: r.id,
    }),
  });

  app.get('/v1/org/integrations', { config: { policy } }, async (request) => ({
    integrations: (await deps.integrations.list(org(request).orgId)).map(clientBody),
  }));

  app.post(
    '/v1/org/integrations',
    {
      config: { policy },
      bodyLimit: 32_768,
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['name', 'jwks', 'scopes'],
          properties: {
            name: { type: 'string', minLength: 1, maxLength: 100 },
            jwks: { type: 'object' },
            scopes: {
              type: 'array',
              minItems: 1,
              uniqueItems: true,
              items: { type: 'string', enum: [...INTEGRATION_SCOPES] },
            },
          },
        },
      },
    },
    async (request, reply) => {
      const { orgId, clinicianId } = org(request);
      const b = request.body as { name: string; jwks: unknown; scopes: string[] };
      if (!validJwks(b.jwks))
        throw new ProblemError(
          422,
          'integration.invalid_jwks',
          'Give public ES384 or RS384 keys with a kid.',
        );
      const id = uuidv7();
      const made = await deps.integrations.create({
        id,
        orgId,
        clientId: randomBytes(18).toString('base64url'),
        name: b.name,
        jwks: b.jwks,
        scopes: b.scopes,
        createdBy: clinicianId,
        auditEvent: audit(request, 'integration.created', id, orgId),
      });
      if (made === 'not_admin')
        throw new ProblemError(403, 'authz.role_not_permitted', 'Not allowed.');
      deps.onCommitted();
      return reply.code(201).send(clientBody(made));
    },
  );

  /** The kill switch (spec 16.3): off takes effect on the integration's next request. */
  app.post(
    '/v1/org/integrations/:id/active',
    {
      config: { policy },
      schema: {
        params: {
          type: 'object',
          additionalProperties: false,
          required: ['id'],
          properties: { id: { type: 'string', pattern: UUID } },
        },
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['active'],
          properties: { active: { type: 'boolean' } },
        },
      },
    },
    async (request) => {
      const { orgId, clinicianId } = org(request);
      const { id } = request.params as { id: string };
      const { active } = request.body as { active: boolean };
      const ok = await deps.integrations.setActive({
        orgId,
        id,
        active,
        actorId: clinicianId,
        auditEvent: audit(
          request,
          active ? 'integration.enabled' : 'integration.disabled',
          id,
          orgId,
        ),
      });
      if (!ok) throw new ProblemError(404, 'integration.not_found', 'Not found.');
      deps.onCommitted();
      return { id, active };
    },
  );

  // The integration service's routes (workload key, one scope each).
  app.post(
    '/internal/v1/integration/clients/resolve',
    {
      config: {
        policy: {
          kind: 'workload',
          scope: 'api.integration.resolve',
          action: 'integration.client.resolve',
          resourceType: 'integration_client',
        },
      },
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['client_id'],
          properties: { client_id: { type: 'string', pattern: '^[A-Za-z0-9_-]{22,64}$' } },
        },
      },
    },
    async (request) => {
      const { client_id } = request.body as { client_id: string };
      const c = await deps.integrations.resolve(client_id);
      if (!c) throw new ProblemError(404, 'integration.unknown_client', 'Not found.');
      return { id: c.id, org_id: c.orgId, jwks: c.jwks, scopes: c.scopes, active: c.active };
    },
  );

  /** Replay protection for client assertions, shared by every integration-service instance. */
  app.post(
    '/internal/v1/integration/assertions/reserve',
    {
      config: {
        policy: {
          kind: 'workload',
          scope: 'api.integration.resolve',
          action: 'integration.assertion.reserve',
          resourceType: 'integration_client',
        },
      },
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['client_id', 'jti', 'expires_at'],
          properties: {
            client_id: { type: 'string', pattern: '^[A-Za-z0-9_-]{22,64}$' },
            jti: { type: 'string', minLength: 1, maxLength: 255 },
            expires_at: { type: 'string', format: 'date-time' },
          },
        },
      },
    },
    async (request) => {
      const b = request.body as { client_id: string; jti: string; expires_at: string };
      return {
        first_use: await deps.integrations.reserveAssertion(
          b.client_id,
          b.jti,
          new Date(b.expires_at),
        ),
      };
    },
  );

  app.post(
    '/internal/v1/fhir/patient',
    {
      config: {
        policy: {
          kind: 'workload',
          scope: 'api.fhir.read',
          action: 'fhir.patient.read',
          resourceType: 'patient_record',
        },
      },
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['org_id', 'patient_id', 'client_id'],
          properties: {
            org_id: { type: 'string', pattern: UUID },
            patient_id: { type: 'string', pattern: UUID },
            client_id: { type: 'string', pattern: '^[A-Za-z0-9_-]{22,64}$' },
          },
        },
      },
    },
    async (request) => {
      const b = request.body as { org_id: string; patient_id: string; client_id: string };
      // The client must still be on, and of that organisation (re-checked here, not trusted).
      const client = await deps.integrations.resolve(b.client_id);
      if (!client?.active || client.orgId !== b.org_id)
        throw new ProblemError(403, 'integration.disabled', 'Not allowed.');
      // Spec 16.4: only with her current share_with_care_team consent, in that organisation.
      const shares = (await deps.consents.current(b.org_id, b.patient_id)).some(
        (c) => c.purpose === 'share_with_care_team' && c.status === 'granted',
      );
      if (!shares) throw new ProblemError(404, 'fhir.not_found', 'Not found.');
      const bundle = await patientBundle(deps, b.org_id, b.patient_id, {
        notes: false,
        accessLog: false,
      });
      await deps.writer.write({
        actor: { id: null, role: 'system' },
        action: 'fhir.patient.read',
        resource: { type: 'patient_record', id: b.patient_id },
        org_id: b.org_id,
        purpose_of_use: 'treatment',
        outcome: 'success',
        reason: null,
        request_id: request.id,
      });
      return bundle;
    },
  );
}

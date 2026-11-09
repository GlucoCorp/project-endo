import type { FastifyInstance } from 'fastify';
import { AuditEventInput } from '@endo/audit';
import { CONSENT_PURPOSES, type ConsentPurpose, type ConsentStore } from '@endo/clinical-store';
import { uuidv7 } from '@endo/domain';
import { ProblemError } from '@endo/service-kit';

/**
 * Version of each purpose's plain-language explanation (spec 13.1). The wording itself is legal
 * content awaiting sign-off (TODO_LEGAL); a new wording gets a new version, and a decision made on
 * an older version is refused so she always decides on what she was actually shown.
 */
export const CONSENT_VERSIONS: Readonly<Record<ConsentPurpose, number>> = Object.freeze({
  self_tracking: 1,
  share_with_care_team: 1,
  research_deidentified: 1,
  org_aggregate_reporting: 1,
});

const VERSION = new Map<ConsentPurpose, number>(
  Object.entries(CONSENT_VERSIONS) as [ConsentPurpose, number][],
);

export interface ConsentRouteDeps {
  readonly consents: ConsentStore;
}

/** Her own patient record and organisation, from the verified token (never from the request). */
function own(request: { subject: { patientId: string | null; orgId: string | null } | null }) {
  const patientId = request.subject?.patientId;
  const orgId = request.subject?.orgId;
  if (!patientId || !orgId) throw new ProblemError(403, 'authz.not_own_resource', 'Not allowed.');
  return { patientId, orgId };
}

/**
 * GET /v1/me/consents and PUT /v1/me/consents/{purpose} (spec 9.2, 13.1). Only she can read or
 * change her decisions. A withdrawal takes effect immediately: authorisation reads the current
 * decision on every request.
 */
export function registerConsentRoutes(app: FastifyInstance, deps: ConsentRouteDeps): void {
  const resource = (
    _req: unknown,
    subject: { patientId: string | null; orgId: string | null },
  ) => ({
    type: 'consent',
    id: null,
    orgId: subject.orgId,
    patientId: subject.patientId,
  });

  app.get(
    '/v1/me/consents',
    {
      config: {
        policy: {
          kind: 'protected',
          action: 'consent.read_own',
          resourceType: 'consent',
          purpose: 'patient_request',
          resource,
        },
      },
    },
    async (request) => {
      const { patientId, orgId } = own(request);
      const current = await deps.consents.current(orgId, patientId);
      return {
        consents: CONSENT_PURPOSES.map((purpose) => {
          const c = current.find((x) => x.purpose === purpose);
          return {
            purpose,
            current_version: VERSION.get(purpose) ?? null,
            status: c?.status ?? null,
            version: c?.version ?? null,
            decided_at: c?.decidedAt.toISOString() ?? null,
          };
        }),
      };
    },
  );

  app.put(
    '/v1/me/consents/:purpose',
    {
      config: {
        policy: {
          kind: 'protected',
          action: 'consent.update_own',
          resourceType: 'consent',
          purpose: 'patient_request',
          resource,
        },
      },
      schema: {
        params: {
          type: 'object',
          required: ['purpose'],
          additionalProperties: false,
          properties: { purpose: { type: 'string', enum: [...CONSENT_PURPOSES] } },
        },
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['status', 'version'],
          properties: {
            status: { type: 'string', enum: ['granted', 'revoked'] },
            version: { type: 'integer', minimum: 1 },
          },
        },
      },
    },
    async (request) => {
      const { patientId, orgId } = own(request);
      const { purpose } = request.params as { purpose: ConsentPurpose };
      const { status, version } = request.body as {
        status: 'granted' | 'revoked';
        version: number;
      };
      if (version !== VERSION.get(purpose)) {
        throw new ProblemError(
          409,
          'consent.version_stale',
          'Please review the latest explanation.',
        );
      }
      if (purpose === 'self_tracking' && status === 'revoked') {
        // Spec 13.1: without self_tracking there is no account. That is deletion (REQ-009).
        throw new ProblemError(409, 'consent.requires_deletion', 'Delete your account instead.');
      }
      const subject = request.subject;
      const result = await deps.consents.record({
        id: uuidv7(),
        orgId,
        patientId,
        purpose,
        status,
        version,
        auditEvent: {
          id: uuidv7(),
          ...AuditEventInput.parse({
            actor: { id: subject?.id ?? null, role: subject?.role ?? 'patient' },
            action: `consent.${status}`,
            resource: { type: 'consent', id: patientId },
            org_id: orgId,
            purpose_of_use: 'patient_request',
            outcome: 'success',
            reason: null,
            request_id: request.id,
          }),
        },
      });
      return {
        purpose,
        status: result.state.status,
        version: result.state.version,
        decided_at: result.state.decidedAt.toISOString(),
        changed: result.changed,
      };
    },
  );
}

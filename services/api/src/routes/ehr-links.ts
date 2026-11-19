import type { FastifyInstance, FastifyRequest } from 'fastify';
import { AuditEventInput, type AuditEventInputType } from '@endo/audit';
import type { ConsentStore, EhrLinkStore } from '@endo/clinical-store';
import { uuidv7 } from '@endo/domain';
import { ProblemError } from '@endo/service-kit';

/**
 * SMART App Launch patient links (M7, spec 16.2). The clinic BFF computes
 * SHA-256(issuer | record-system patient id) from a launch; the API never sees the identifier.
 * Resolving needs a clinician of the organisation; linking needs her care-team consent (the
 * patient policy checks it before the handler).
 */
export interface EhrLinkRouteDeps {
  readonly ehrLinks: EhrLinkStore;
  readonly consents: ConsentStore;
  readonly writer: { write(e: AuditEventInputType): Promise<unknown> };
  readonly onCommitted: () => void;
}

const UUID = '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
const HASH = { type: 'string', pattern: '^[0-9a-f]{64}$' } as const;

export function registerEhrLinkRoutes(app: FastifyInstance, deps: EhrLinkRouteDeps): void {
  const org = (r: FastifyRequest) => {
    const orgId = r.subject?.orgId;
    const clinicianId = r.clinicianId;
    if (!orgId || !clinicianId) throw new ProblemError(403, 'authz.org_mismatch', 'Not allowed.');
    return { orgId, clinicianId };
  };

  app.post(
    '/v1/ehr-links/resolve',
    {
      config: {
        policy: {
          kind: 'protected',
          action: 'patient.list',
          resourceType: 'patient_record',
          purpose: 'treatment',
          resource: (_r, s) => ({
            type: 'patient_record',
            id: null,
            orgId: s.orgId,
            patientId: null,
          }),
        },
      },
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['link_hash'],
          properties: { link_hash: HASH },
        },
      },
    },
    async (request) => {
      const { orgId } = org(request);
      const { link_hash } = request.body as { link_hash: string };
      const patientId = await deps.ehrLinks.resolve(orgId, link_hash);
      // Only while she shares with the care team (Codex r8): after a withdrawal the link reveals
      // nothing, the same answer as no link.
      const shares =
        patientId !== null &&
        (await deps.consents.current(orgId, patientId)).some(
          (c) => c.purpose === 'share_with_care_team' && c.status === 'granted',
        );
      if (!patientId || !shares)
        throw new ProblemError(404, 'ehr_link.not_found', 'Not linked yet.');
      // Audited against her record before it is disclosed (her access log shows it).
      await deps.writer.write({
        actor: { id: request.subject?.id ?? null, role: request.subject?.role ?? 'clinician' },
        action: 'ehr_link.resolved',
        resource: { type: 'patient_record', id: patientId },
        org_id: orgId,
        purpose_of_use: 'treatment',
        outcome: 'success',
        reason: null,
        request_id: request.id,
      });
      return { patient_id: patientId };
    },
  );

  app.post(
    '/v1/patients/:patientId/ehr-links',
    {
      config: {
        policy: {
          kind: 'protected',
          action: 'patient_data.read',
          resourceType: 'patient_record',
          purpose: 'treatment',
          resource: (r, s) => {
            const id = (r.params as { patientId?: string }).patientId ?? '';
            return { type: 'patient_record', id, orgId: s.orgId, patientId: id };
          },
        },
      },
      schema: {
        params: {
          type: 'object',
          additionalProperties: false,
          required: ['patientId'],
          properties: { patientId: { type: 'string', pattern: UUID } },
        },
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['link_hash'],
          properties: { link_hash: HASH },
        },
      },
    },
    async (request, reply) => {
      const { orgId, clinicianId } = org(request);
      const { patientId } = request.params as { patientId: string };
      const { link_hash } = request.body as { link_hash: string };
      const id = uuidv7();
      const r = await deps.ehrLinks.link({
        id,
        orgId,
        linkHash: link_hash,
        patientId,
        clinicianId,
        auditEvent: {
          id: uuidv7(),
          ...AuditEventInput.parse({
            actor: { id: request.subject?.id ?? null, role: request.subject?.role ?? 'clinician' },
            action: 'ehr_link.created',
            resource: { type: 'patient_record', id: patientId },
            org_id: orgId,
            purpose_of_use: 'treatment',
            outcome: 'success',
            reason: null,
            request_id: request.id,
          }),
        },
      });
      if (r === 'exists')
        throw new ProblemError(409, 'ehr_link.exists', 'This record is already linked.');
      deps.onCommitted();
      return reply.code(201).send({ patient_id: patientId });
    },
  );
}

import type { FastifyInstance, FastifyRequest } from 'fastify';
import { ProblemError } from '@endo/service-kit';
import type { VerdictService } from '../verdicts.ts';

const UUID = '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';

/**
 * On-demand verdict generation from the clinician view (REQ-004; spec 9.2). Shadow mode (M3): the
 * attempt is stored and audited, and the response says only whether a verdict was generated,
 * never what it is, so it cannot influence care before verdicts are cleared for use.
 */
export function registerVerdictRoutes(
  app: FastifyInstance,
  deps: { readonly verdicts: VerdictService; readonly onCommitted: () => void },
): void {
  const params = (r: FastifyRequest) => r.params as { patientId: string; id: string };
  app.post(
    '/v1/patients/:patientId/episodes/:id/verdicts',
    {
      config: {
        policy: {
          kind: 'protected',
          action: 'verdict.generate',
          resourceType: 'treatment_episode',
          purpose: 'treatment',
          resource: (request, subject) => ({
            type: 'treatment_episode',
            id: params(request).id,
            orgId: subject.orgId,
            patientId: params(request).patientId,
          }),
        },
      },
      schema: {
        params: {
          type: 'object',
          additionalProperties: false,
          required: ['patientId', 'id'],
          properties: {
            patientId: { type: 'string', pattern: UUID },
            id: { type: 'string', pattern: UUID },
          },
        },
      },
    },
    async (request, reply) => {
      const orgId = request.subject?.orgId;
      const clinicianId = request.clinicianId;
      if (!orgId || !clinicianId) throw new ProblemError(403, 'authz.org_mismatch', 'Not allowed.');
      const r = await deps.verdicts.generate({
        orgId,
        episodeId: params(request).id,
        patientId: params(request).patientId,
        by: 'on_demand',
        requestedBy: clinicianId,
        actor: { id: request.subject?.id ?? null, role: request.subject?.role ?? 'clinician' },
        requestId: request.id,
      });
      if (r.kind !== 'recorded') throw new ProblemError(404, 'episode.not_found', 'Not found.');
      deps.onCommitted();
      return reply.code(201).send({ id: r.id, outcome: r.outcome, shadow: true });
    },
  );
}

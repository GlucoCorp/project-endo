import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { AuditEventInput } from '@endo/audit';
import type { ConsentStore, DeletionStatus, DeletionStore } from '@endo/clinical-store';
import { uuidv7 } from '@endo/domain';
import { ProblemError } from '@endo/service-kit';
import { fhirExport } from '../export.ts';
import { accessLog, type HistoryRouteDeps } from './history.ts';

/**
 * Her data rights (M5: REQ-009; spec 11.4, 13.4).
 *
 * - Export: her complete record as a FHIR R4 Bundle, made on request and never stored (spec 11.4
 *   allows 24 hours; we keep none). The page prints it as the human-readable copy.
 * - Deletion: she asks; for 14 days she can change her mind; then the jobs process erases her
 *   clinical data (her key first) and her identity record. The request row stays, without PHI.
 */
export interface DataRightsRouteDeps extends Pick<
  HistoryRouteDeps,
  'episodes' | 'reviews' | 'links' | 'audit' | 'content' | 'cipherFor' | 'onCommitted'
> {
  readonly deletions: DeletionStore;
  readonly consents: ConsentStore;
  readonly now: () => Date;
}

const statusOf = (d: DeletionStatus | null) =>
  !d
    ? { status: 'none' as const }
    : {
        status: d.erasedAt
          ? ('erased' as const)
          : d.cancelledAt
            ? ('cancelled' as const)
            : ('scheduled' as const),
        requested_at: d.requestedAt.toISOString(),
        due_at: d.dueAt.toISOString(),
      };

export function registerDataRightsRoutes(app: FastifyInstance, deps: DataRightsRouteDeps): void {
  const own = (r: FastifyRequest) => {
    const patientId = r.subject?.patientId;
    const orgId = r.subject?.orgId;
    if (!patientId || !orgId) throw new ProblemError(403, 'authz.not_own_resource', 'Not allowed.');
    return { patientId, orgId };
  };
  const policy = (action: 'own_data.export' | 'own_data.delete') => ({
    kind: 'protected' as const,
    action,
    resourceType: 'patient_record',
    purpose: 'patient_request' as const,
    resource: (_r: FastifyRequest, s: { orgId: string | null; patientId: string | null }) => ({
      type: 'patient_record',
      id: s.patientId,
      orgId: s.orgId,
      patientId: s.patientId,
    }),
  });
  const audit = (r: FastifyRequest, action: string, patientId: string, orgId: string) => ({
    id: uuidv7(),
    ...AuditEventInput.parse({
      actor: { id: r.subject?.id ?? null, role: r.subject?.role ?? 'patient' },
      action,
      resource: { type: 'patient_record', id: patientId },
      org_id: orgId,
      purpose_of_use: 'patient_request',
      outcome: 'success',
      reason: null,
      request_id: r.id,
    }),
  });

  app.get('/v1/me/deletion', { config: { policy: policy('own_data.delete') } }, async (request) => {
    const { orgId, patientId } = own(request);
    return statusOf(await deps.deletions.status(orgId, patientId));
  });

  /** Asking again while one is open returns it (one open request per patient). */
  app.post(
    '/v1/me/deletion',
    { config: { policy: policy('own_data.delete') } },
    async (request, reply) => {
      const { orgId, patientId } = own(request);
      const identityRef = await deps.deletions.identityRefOf(orgId, patientId);
      if (!identityRef) throw new ProblemError(404, 'patient.not_found', 'Not found.');
      const d = await deps.deletions.request({
        id: uuidv7(),
        orgId,
        patientId,
        identityRef,
        auditEvent: audit(request, 'deletion.requested', patientId, orgId),
      });
      deps.onCommitted();
      return reply.code(202).send(statusOf(d));
    },
  );

  app.post(
    '/v1/me/deletion/cancel',
    { config: { policy: policy('own_data.delete') } },
    async (request) => {
      const { orgId, patientId } = own(request);
      const ok = await deps.deletions.cancel(
        orgId,
        patientId,
        audit(request, 'deletion.cancelled', patientId, orgId),
      );
      if (!ok)
        throw new ProblemError(409, 'deletion.not_scheduled', 'There is no deletion to cancel.');
      deps.onCommitted();
      return statusOf(await deps.deletions.status(orgId, patientId));
    },
  );

  /** POST: an export is an action on her record (audited by the policy), not a cacheable read. */
  app.post(
    '/v1/me/export',
    { config: { policy: policy('own_data.export') } },
    async (request, reply: FastifyReply) => {
      const { orgId, patientId } = own(request);
      const cipher = deps.cipherFor(orgId);
      const [episodes, decisions, surgeryChecks, consents, log] = await Promise.all([
        // Everything, never a first page (REQ-009: a complete export).
        deps.episodes.listForPatient(orgId, patientId, null),
        deps.reviews.decisions(orgId, patientId),
        deps.reviews.surgeryChecks(orgId, patientId),
        deps.consents.current(orgId, patientId),
        accessLog(deps, orgId, patientId, 'all'),
      ]);
      const bundle = fhirExport({
        patientId,
        generatedAt: deps.now(),
        episodes: await Promise.all(
          episodes.map(async (e) => ({
            episode: e,
            treatmentDisplay:
              deps.content.treatments.find(
                (t) => t.system === e.treatmentSystem && t.code === e.treatmentCode,
              )?.display ?? null,
            goalText: e.goal?.textEncrypted
              ? await cipher.decrypt(e.goal.textEncrypted, {
                  patientId,
                  field: 'goal.text',
                  recordId: e.goal.id,
                })
              : (deps.content.goals.find((g) => g.code === e.goal?.templateCode)?.text ?? null),
            checkIns: await deps.episodes.listCheckIns(orgId, e.id),
            redFlags: await deps.episodes.listRedFlags(orgId, e.id),
          })),
        ),
        decisions: await Promise.all(
          decisions.map(async (d) => ({
            ...d,
            note: d.noteEncrypted
              ? await cipher.decrypt(d.noteEncrypted, {
                  patientId,
                  field: 'review_decision.note',
                  recordId: d.id,
                })
              : null,
          })),
        ),
        surgeryChecks,
        consents,
        accessLog: log,
      });
      return reply
        .header('content-type', 'application/fhir+json; charset=utf-8')
        .header('content-disposition', 'attachment; filename="my-endo-record.json"')
        .header('cache-control', 'no-store')
        .send(JSON.stringify(bundle));
    },
  );
}

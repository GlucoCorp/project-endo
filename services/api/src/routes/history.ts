import { createHash, randomBytes } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { AuditEventInput, type AuditEventInputType, type AuditReader } from '@endo/audit';
import type { EpisodeStore, ReviewStore, ShareLinkStore } from '@endo/clinical-store';
import type { ClinicalContent } from '@endo/config';
import type { FieldCipher } from '@endo/crypto';
import { uuidv7 } from '@endo/domain';
import { ProblemError } from '@endo/service-kit';

/**
 * Her treatment history, sharing and access log (M4: REQ-008; spec 13.3, 21.7 screens 7 and 8).
 *
 * - History: every confirmed treatment as a Trial Card (weeks for the strip, her goal, the
 *   decision code). Clinicians' notes are not part of it.
 * - Share links: a read-only summary for 1 to 30 days (default 7), revocable. The token is
 *   returned once and stored only as a hash. The receiver's view is a workload route for the
 *   patient BFF, which passes the token's hash; each view is audited against the link.
 * - Access log: who (by role) read or changed her record, and when, from the audit store.
 */
export interface HistoryRouteDeps {
  readonly episodes: EpisodeStore;
  readonly reviews: ReviewStore;
  readonly links: ShareLinkStore;
  readonly audit: AuditReader;
  /** Writes the audit event for a receiver's view (against the link). */
  readonly writer: { write(e: AuditEventInputType): Promise<unknown> };
  readonly content: ClinicalContent;
  readonly cipherFor: (orgId: string) => FieldCipher;
  readonly onCommitted: () => void;
}

const UUID = '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
/**
 * Authorisation events for changes. Each change writes its own event when it commits
 * (`review.decided`, `surgery_check.recorded`, `episode.drafted`), so the log shows that instead;
 * a refused attempt is still shown.
 */
const CHANGE_GATES = new Set(['review_decision.record', 'episode.create']);
/** What a week shows on the strip; red-flag answers and anything else stay out of a summary. */
const STRIP_KEYS = ['Q1', 'Q3', 'Q5', 'Q6', 'Q7', 'Q8'] as const;

export function registerHistoryRoutes(app: FastifyInstance, deps: HistoryRouteDeps): void {
  const own = (r: FastifyRequest) => {
    const patientId = r.subject?.patientId;
    const orgId = r.subject?.orgId;
    if (!patientId || !orgId) throw new ProblemError(403, 'authz.not_own_resource', 'Not allowed.');
    return { patientId, orgId };
  };
  const policy = (
    action: 'episode.read_own' | 'share_link.manage_own' | 'access_log.read_own',
    type: string,
  ) => ({
    kind: 'protected' as const,
    action,
    resourceType: type,
    purpose: 'patient_request' as const,
    resource: (_r: FastifyRequest, s: { orgId: string | null; patientId: string | null }) => ({
      type,
      id: null,
      orgId: s.orgId,
      patientId: s.patientId,
    }),
  });
  const audit = (r: FastifyRequest, action: string, type: string, id: string, orgId: string) => ({
    id: uuidv7(),
    ...AuditEventInput.parse({
      actor: { id: r.subject?.id ?? null, role: r.subject?.role ?? 'patient' },
      action,
      resource: { type, id },
      org_id: orgId,
      purpose_of_use: 'patient_request',
      outcome: 'success',
      reason: null,
      request_id: r.id,
    }),
  });

  /** The summary both she and a receiver see (REQ-008). */
  const summary = async (orgId: string, patientId: string) => {
    const [episodes, decisions] = await Promise.all([
      deps.episodes.listForPatient(orgId, patientId),
      deps.reviews.decisions(orgId, patientId),
    ]);
    const decided = new Map(decisions.map((d) => [d.episodeId, d.decision]));
    const cards = [];
    for (const e of episodes.filter((x) => x.status !== 'draft')) {
      const weeks = await deps.episodes.listCheckIns(orgId, e.id);
      const goal = e.goal?.textEncrypted
        ? await deps
            .cipherFor(orgId)
            .decrypt(e.goal.textEncrypted, { patientId, field: 'goal.text', recordId: e.goal.id })
            .catch(() => null)
        : (deps.content.goals.find((g) => g.code === e.goal?.templateCode)?.text ?? null);
      cards.push({
        id: e.id,
        status: e.status,
        treatment: {
          code: e.treatmentCode,
          display:
            deps.content.treatments.find(
              (t) => t.system === e.treatmentSystem && t.code === e.treatmentCode,
            )?.display ?? null,
        },
        dose_text: e.doseText,
        start_date: e.startDate,
        review_date: e.reviewDate,
        review_interval_weeks: e.reviewIntervalWeeks,
        goal,
        decision: decided.get(e.id) ?? null,
        weeks: weeks.map((w) => {
          const a = new Map(Object.entries((w.answers ?? {}) as Record<string, unknown>));
          return {
            week_index: w.weekIndex,
            is_late: w.isLate,
            answers: Object.fromEntries(
              STRIP_KEYS.filter((k) => a.has(k)).map((k) => [k, a.get(k)]),
            ),
          };
        }),
      });
    }
    return { treatments: cards };
  };

  app.get(
    '/v1/me/history',
    { config: { policy: policy('episode.read_own', 'treatment_episode') } },
    async (request) => {
      const { orgId, patientId } = own(request);
      return summary(orgId, patientId);
    },
  );

  app.post(
    '/v1/me/share-links',
    {
      config: { policy: policy('share_link.manage_own', 'share_link') },
      schema: {
        headers: {
          type: 'object',
          required: ['idempotency-key'],
          properties: { 'idempotency-key': { type: 'string', pattern: UUID } },
        },
        body: {
          type: 'object',
          additionalProperties: false,
          properties: { days: { type: 'integer', minimum: 1, maximum: 30 } },
        },
      },
    },
    async (request, reply) => {
      const { orgId, patientId } = own(request);
      const days = (request.body as { days?: number } | undefined)?.days ?? 7;
      const token = randomBytes(32).toString('base64url');
      const id = uuidv7();
      const link = await deps.links.create({
        id,
        orgId,
        patientId,
        tokenHash: createHash('sha256').update(token).digest('hex'),
        days,
        creationKey: request.headers['idempotency-key'] as string,
        auditEvent: audit(request, 'share_link.created', 'share_link', id, orgId),
      });
      if (link.replay)
        // The token was shown once; a retry cannot show it again (as for enrolment codes).
        throw new ProblemError(
          409,
          'share_link.already_created',
          'This link was already made. Make a new one if you need it.',
        );
      deps.onCommitted();
      return reply.code(201).send({ id: link.id, token, expires_at: link.expiresAt.toISOString() });
    },
  );

  app.get(
    '/v1/me/share-links',
    { config: { policy: policy('share_link.manage_own', 'share_link') } },
    async (request) => {
      const { orgId, patientId } = own(request);
      const now = Date.now();
      return {
        links: (await deps.links.list(orgId, patientId)).map((l) => ({
          id: l.id,
          created_at: l.createdAt.toISOString(),
          expires_at: l.expiresAt.toISOString(),
          active: l.revokedAt === null && l.expiresAt.getTime() > now,
        })),
      };
    },
  );

  app.delete(
    '/v1/me/share-links/:id',
    {
      config: { policy: policy('share_link.manage_own', 'share_link') },
      schema: {
        params: {
          type: 'object',
          additionalProperties: false,
          required: ['id'],
          properties: { id: { type: 'string', pattern: UUID } },
        },
      },
    },
    async (request, reply) => {
      const { orgId, patientId } = own(request);
      const { id } = request.params as { id: string };
      const stopped = await deps.links.revoke(
        orgId,
        patientId,
        id,
        audit(request, 'share_link.revoked', 'share_link', id, orgId),
      );
      if (stopped) deps.onCommitted();
      // Stopping twice, or a link that is not hers: the same answer, nothing revealed.
      return reply.code(204).send();
    },
  );

  /** The receiver's view, for the patient BFF only (it never sees her identity). */
  app.post(
    '/internal/v1/shared/view',
    {
      config: {
        policy: {
          kind: 'workload',
          scope: 'api.share.view',
          action: 'share_link.viewed',
          resourceType: 'share_link',
        },
      },
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['token_hash'],
          properties: { token_hash: { type: 'string', pattern: '^[0-9a-f]{64}$' } },
        },
      },
    },
    async (request) => {
      const { token_hash } = request.body as { token_hash: string };
      const link = await deps.links.findLive(token_hash);
      if (!link) throw new ProblemError(404, 'share_link.not_found', 'This link cannot be used.');
      const body = await summary(link.orgId, link.patientId);
      // Audited against the link (and so in her access log), as an anonymous viewer. If the
      // audit write fails, the view fails (spec 2.6).
      await deps.writer.write({
        actor: { id: null, role: 'anonymous' },
        action: 'share_link.viewed',
        resource: { type: 'share_link', id: link.id },
        org_id: link.orgId,
        purpose_of_use: 'patient_request',
        outcome: 'success',
        reason: null,
        request_id: request.id,
      });
      return { expires_at: link.expiresAt.toISOString(), ...body };
    },
  );

  /** Spec 13.3: who accessed her record, and when; by role, never by name. */
  app.get(
    '/v1/me/access-log',
    { config: { policy: policy('access_log.read_own', 'audit_event') } },
    async (request) => {
      const { orgId, patientId } = own(request);
      // Everything of hers an event can name: her record, treatments, decisions, checks, links.
      const [episodes, decisions, checks, links] = await Promise.all([
        deps.episodes.listForPatient(orgId, patientId),
        deps.reviews.decisions(orgId, patientId),
        deps.reviews.surgeryChecks(orgId, patientId),
        deps.links.ids(orgId, patientId),
      ]);
      const events = await deps.audit.forResources(
        [
          { type: 'patient_record', id: patientId },
          ...episodes.map((e) => ({ type: 'treatment_episode', id: e.id })),
          ...decisions.map((d) => ({ type: 'review_decision', id: d.id })),
          ...checks.map((c) => ({ type: 'surgery_check', id: c.id })),
          ...links.map((id) => ({ type: 'share_link', id })),
        ],
        200,
      );
      return {
        events: events
          // A change is shown once it is made (its own event), not when it was allowed to start.
          .filter((e) => !(e.outcome === 'success' && CHANGE_GATES.has(e.action)))
          .map((e) => ({
            at: e.occurred_at,
            role: e.actor.role,
            action: e.action,
            purpose: e.purpose_of_use,
            outcome: e.outcome,
          })),
      };
    },
  );
}

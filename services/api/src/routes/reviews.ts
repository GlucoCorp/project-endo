import { createHash } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { AuditEventInput } from '@endo/audit';
import type {
  EpisodeStore,
  NextTreatment,
  ReviewStore,
  TreatmentFacts,
} from '@endo/clinical-store';
import { SYNTHETIC_TREATMENT_SYSTEM, canonicalJson, type ClinicalContent } from '@endo/config';
import type { FieldCipher } from '@endo/crypto';
import { uuidv7 } from '@endo/domain';
import { ProblemError } from '@endo/service-kit';

/**
 * The clinician desk (M4: REQ-005, REQ-006; spec 21.8). Every route needs the patient's current
 * share_with_care_team consent and same organisation (spec 3.2), checked by the policy from the
 * path before any handler, except the queue, which the store filters by that same consent.
 *
 * Verdicts are in shadow mode (M3, ADR-0028): no route here shows one. The review shows the
 * evidence (every week's answers for the Trial Strip, red flags, history) and records a decision.
 */
export interface ReviewRouteDeps {
  readonly reviews: ReviewStore;
  readonly episodes: EpisodeStore;
  readonly content: ClinicalContent;
  readonly cipherFor: (orgId: string) => FieldCipher;
  readonly onCommitted: () => void;
  readonly now: () => Date;
  readonly deployed: boolean;
}

const UUID = '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
const DATE = '^[0-9]{4}-[0-9]{2}-[0-9]{2}$';
export const PROCEDURES = [
  'hysterectomy',
  'myomectomy',
  'ovarian_cystectomy',
  'adenomyomectomy',
  'ablation',
] as const;

const treatmentBody = {
  type: 'object',
  additionalProperties: false,
  required: ['treatment', 'dose_text', 'start_date'],
  properties: {
    treatment: {
      type: 'object',
      additionalProperties: false,
      required: ['system', 'code'],
      properties: {
        system: { type: 'string', maxLength: 100 },
        code: { type: 'string', pattern: '^[A-Za-z0-9.-]{1,32}$' },
      },
    },
    dose_text: { type: 'string', minLength: 1, maxLength: 120 },
    start_date: { type: 'string', pattern: DATE },
    review_interval_weeks: { type: 'integer', minimum: 4, maximum: 26 },
  },
} as const;

interface TreatmentInput {
  readonly treatment: { readonly system: string; readonly code: string };
  readonly dose_text: string;
  readonly start_date: string;
  readonly review_interval_weeks?: number;
}

export function registerReviewRoutes(app: FastifyInstance, deps: ReviewRouteDeps): void {
  const display = (system: string, code: string) =>
    deps.content.treatments.find((t) => t.system === system && t.code === code)?.display ?? null;
  const params = (r: FastifyRequest) => r.params as { patientId: string; id?: string };
  const patientPolicy = (
    action: 'patient_data.read' | 'review_decision.record' | 'surgery_check.read',
  ) => ({
    kind: 'protected' as const,
    action,
    resourceType: 'patient_record',
    purpose: 'treatment' as const,
    resource: (r: FastifyRequest, s: { orgId: string | null }) => ({
      type: 'patient_record',
      id: params(r).patientId,
      orgId: s.orgId,
      patientId: params(r).patientId,
    }),
  });
  const idParams = (...names: string[]) => ({
    type: 'object',
    additionalProperties: false,
    required: names,
    properties: Object.fromEntries(names.map((n) => [n, { type: 'string', pattern: UUID }])),
  });
  const org = (r: FastifyRequest) => {
    const orgId = r.subject?.orgId;
    const clinicianId = r.clinicianId;
    if (!orgId || !clinicianId) throw new ProblemError(403, 'authz.org_mismatch', 'Not allowed.');
    return { orgId, clinicianId };
  };
  const audit = (r: FastifyRequest, action: string, type: string, id: string, orgId: string) => ({
    id: uuidv7(),
    ...AuditEventInput.parse({
      actor: { id: r.subject?.id ?? null, role: r.subject?.role ?? 'clinician' },
      action,
      resource: { type, id },
      org_id: orgId,
      purpose_of_use: 'treatment',
      outcome: 'success',
      reason: null,
      request_id: r.id,
    }),
  });

  /** REQ-005: due within 14 days or overdue, red flags pinned on top, then by due date. */
  app.get(
    '/v1/reviews/queue',
    {
      config: {
        policy: {
          kind: 'protected',
          action: 'review.queue',
          resourceType: 'treatment_episode',
          purpose: 'treatment',
          resource: (_r, s) => ({
            type: 'treatment_episode',
            id: null,
            orgId: s.orgId,
            patientId: null,
          }),
        },
      },
    },
    async (request) => {
      const { orgId } = org(request);
      const today = deps.now().toISOString().slice(0, 10);
      const items = await deps.reviews.queue(orgId, today, 14);
      return {
        verdicts: 'shadow',
        items: items.map((i) => ({
          episode_id: i.episodeId,
          patient_id: i.patientId,
          treatment: {
            code: i.treatmentCode,
            display: display(i.treatmentSystem, i.treatmentCode),
          },
          dose_text: i.doseText,
          review_date: i.reviewDate,
          overdue: i.reviewDate < today,
          week: Math.min(
            i.reviewIntervalWeeks,
            Math.max(
              1,
              Math.floor((Date.parse(today) - Date.parse(i.startDate)) / 604_800_000) + 1,
            ),
          ),
          check_ins: i.checkIns,
          red_flags: i.redFlags,
        })),
      };
    },
  );

  const decrypt = async (
    orgId: string,
    patientId: string,
    field: string,
    recordId: string,
    v: string | null,
  ) =>
    v === null
      ? null
      : deps
          .cipherFor(orgId)
          .decrypt(v, { patientId, field, recordId })
          .catch(() => null);

  /** REQ-005: everything the review screen shows, for one episode of one consented patient. */
  app.get(
    '/v1/patients/:patientId/episodes/:id/review',
    {
      config: { policy: patientPolicy('patient_data.read') },
      schema: { params: idParams('patientId', 'id') },
    },
    async (request) => {
      const { orgId } = org(request);
      const { patientId, id } = params(request) as { patientId: string; id: string };
      const episode = await deps.episodes.get(orgId, id, patientId);
      if (!episode || episode.status === 'draft')
        throw new ProblemError(404, 'episode.not_found', 'Not found.');
      const [checkIns, redFlags, history, decisions] = await Promise.all([
        deps.episodes.listCheckIns(orgId, id),
        deps.episodes.listRedFlags(orgId, id),
        deps.episodes.listForPatient(orgId, patientId),
        deps.reviews.decisions(orgId, patientId),
      ]);
      const goal = episode.goal?.textEncrypted
        ? await decrypt(orgId, patientId, 'goal.text', episode.goal.id, episode.goal.textEncrypted)
        : (deps.content.goals.find((g) => g.code === episode.goal?.templateCode)?.text ?? null);
      return {
        verdicts: 'shadow',
        episode: {
          id: episode.id,
          status: episode.status,
          treatment: {
            code: episode.treatmentCode,
            display: display(episode.treatmentSystem, episode.treatmentCode),
          },
          dose_text: episode.doseText,
          adherence_mode: episode.adherenceMode,
          start_date: episode.startDate,
          review_date: episode.reviewDate,
          review_interval_weeks: episode.reviewIntervalWeeks,
          goal,
        },
        // Every week for the Trial Strip: missing weeks are absent, never filled in.
        weeks: checkIns.map((c) => ({
          week_index: c.weekIndex,
          is_late: c.isLate,
          answers: c.answers,
        })),
        red_flags: redFlags.map((f) => ({
          flags: f.flags,
          recorded_at: f.recordedAt.toISOString(),
        })),
        history: history
          .filter((h) => h.id !== id && h.status !== 'draft')
          .map((h) => ({
            id: h.id,
            status: h.status,
            treatment: {
              code: h.treatmentCode,
              display: display(h.treatmentSystem, h.treatmentCode),
            },
            dose_text: h.doseText,
            start_date: h.startDate,
            review_date: h.reviewDate,
          })),
        decisions: await Promise.all(
          decisions.map(async (d) => ({
            episode_id: d.episodeId,
            decision: d.decision,
            note: await decrypt(orgId, patientId, 'review_decision.note', d.id, d.noteEncrypted),
            decided_at: d.decidedAt.toISOString(),
          })),
        ),
        // Spec 7.3: guideline options are clinical content, unfinished until signed off.
        guideline_options: [],
        decision_options: ['continue', 'switch', 'add', 'refer', 'stop'],
      };
    },
  );

  const toNext = (t: TreatmentInput): NextTreatment => {
    const found = deps.content.treatments.find(
      (x) => x.system === t.treatment.system && x.code === t.treatment.code,
    );
    if (!found || (deps.deployed && found.system === SYNTHETIC_TREATMENT_SYSTEM))
      throw new ProblemError(422, 'episode.unknown_treatment', 'Choose a treatment from the list.');
    return {
      id: uuidv7(),
      treatmentSystem: found.system,
      treatmentCode: found.code,
      adherenceMode: found.adherenceMode,
      doseText: t.dose_text,
      startDate: t.start_date,
      reviewIntervalWeeks: t.review_interval_weeks ?? 12,
    };
  };

  /** REQ-005: a decision is required to close the review; switch opens a pre-filled draft. */
  app.post(
    '/v1/patients/:patientId/episodes/:id/decision',
    {
      config: { policy: patientPolicy('review_decision.record') },
      schema: {
        params: idParams('patientId', 'id'),
        headers: {
          type: 'object',
          required: ['idempotency-key'],
          properties: { 'idempotency-key': { type: 'string', pattern: UUID } },
        },
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['decision'],
          properties: {
            decision: { type: 'string', enum: ['continue', 'switch', 'add', 'refer', 'stop'] },
            note: { type: 'string', minLength: 1, maxLength: 2000 },
            next: treatmentBody,
            added: treatmentBody,
          },
        },
      },
    },
    async (request, reply) => {
      const { orgId, clinicianId } = org(request);
      const { patientId, id } = params(request) as { patientId: string; id: string };
      const b = request.body as {
        decision: 'continue' | 'switch' | 'add' | 'refer' | 'stop';
        note?: string;
        next?: TreatmentInput;
        added?: TreatmentInput;
      };
      const episode = await deps.episodes.get(orgId, id, patientId);
      if (!episode) throw new ProblemError(404, 'episode.not_found', 'Not found.');
      const same: TreatmentInput = {
        treatment: { system: episode.treatmentSystem, code: episode.treatmentCode },
        dose_text: episode.doseText,
        start_date: episode.reviewDate,
        review_interval_weeks: episode.reviewIntervalWeeks,
      };
      if (b.decision === 'switch' && !b.next)
        throw new ProblemError(422, 'review.next_required', 'Choose the treatment to switch to.');
      if (b.decision === 'add' && !b.added)
        throw new ProblemError(422, 'review.added_required', 'Choose the treatment to add.');
      if ((b.decision === 'refer' || b.decision === 'stop') && (b.next || b.added))
        throw new ProblemError(422, 'review.no_next', 'Refer and stop open no new treatment.');
      const nextInput =
        b.decision === 'switch'
          ? (b.next ?? same)
          : b.decision === 'continue' || b.decision === 'add'
            ? (b.next ?? same)
            : null;
      const next = nextInput ? toNext(nextInput) : null;
      const added = b.decision === 'add' && b.added ? toNext(b.added) : null;
      const decisionId = uuidv7();
      const requestHash = createHash('sha256')
        .update(
          canonicalJson({
            episode: id,
            decision: b.decision,
            note: b.note ?? null,
            next: b.next ?? null,
            added: b.added ?? null,
          }),
        )
        .digest('hex');
      const r = await deps.reviews.decide({
        id: decisionId,
        orgId,
        patientId,
        episodeId: id,
        clinicianId,
        decision: b.decision,
        verdictId: null,
        noteEncrypted: b.note
          ? await deps
              .cipherFor(orgId)
              .encrypt(b.note, { patientId, field: 'review_decision.note', recordId: decisionId })
          : null,
        next,
        added,
        idempotencyKey: request.headers['idempotency-key'] as string,
        requestHash,
        instrumentVersion: deps.content.instrument.version,
        auditEvent: audit(request, 'review.decided', 'review_decision', decisionId, orgId),
      });
      if (r.outcome === 'conflict')
        throw new ProblemError(
          422,
          'idempotency.key_reused',
          'This Idempotency-Key was already used for a different request.',
        );
      if (r.outcome === 'not_open')
        throw new ProblemError(409, 'review.not_open', 'This treatment is not open for review.');
      if (r.outcome === 'recorded') deps.onCommitted();
      return reply.code(r.outcome === 'recorded' ? 201 : 200).send({
        id: r.id,
        decision: b.decision,
        next_episode_id: r.nextEpisodeId,
        added_episode_id: r.addedEpisodeId,
      });
    },
  );

  /**
   * REQ-006 snapshot: the facts from her record. "Properly tried" and the guideline's option list
   * are clinical definitions not yet signed off (Section 24 items 30, 31): each treatment shows
   * its facts and `classification: "pending_clinical_definition"`; nothing is classified by code.
   * Fertility intentions are not collected yet (item 32).
   */
  const snapshotOf = (facts: readonly TreatmentFacts[], procedure: string) => ({
    procedure,
    treatments: facts.map((f) => ({
      treatment: { code: f.treatmentCode, display: display(f.treatmentSystem, f.treatmentCode) },
      dose_text: f.doseText,
      start_date: f.startDate,
      review_date: f.reviewDate,
      status: f.status,
      weeks_planned: f.reviewIntervalWeeks,
      check_ins: f.checkIns,
      adherence: f.adherence,
      decision: f.decision,
      classification: 'pending_clinical_definition',
    })),
    never_tried: { status: 'pending_clinical_definition', options: [] },
    fertility_intentions: { status: 'not_collected' },
  });

  const procedureBody = {
    type: 'object',
    additionalProperties: false,
    required: ['procedure'],
    properties: {
      procedure: { type: 'string', enum: [...PROCEDURES] },
      discussed_with_patient: { const: true },
    },
  } as const;

  app.post(
    '/v1/patients/:patientId/surgery-checks/preview',
    {
      config: { policy: patientPolicy('patient_data.read') },
      schema: { params: idParams('patientId'), body: procedureBody },
    },
    async (request) => {
      const { orgId } = org(request);
      const { patientId } = params(request);
      const { procedure } = request.body as { procedure: string };
      return snapshotOf(await deps.reviews.treatmentFacts(orgId, patientId), procedure);
    },
  );

  /** REQ-006: saved only with "I have discussed these with the patient". */
  app.post(
    '/v1/patients/:patientId/surgery-checks',
    {
      config: { policy: patientPolicy('review_decision.record') },
      schema: {
        params: idParams('patientId'),
        headers: {
          type: 'object',
          required: ['idempotency-key'],
          properties: { 'idempotency-key': { type: 'string', pattern: UUID } },
        },
        body: { ...procedureBody, required: ['procedure', 'discussed_with_patient'] },
      },
    },
    async (request, reply) => {
      const { orgId, clinicianId } = org(request);
      const { patientId } = params(request);
      const { procedure } = request.body as { procedure: string };
      const snapshot = snapshotOf(await deps.reviews.treatmentFacts(orgId, patientId), procedure);
      const id = uuidv7();
      const r = await deps.reviews.recordSurgeryCheck({
        id,
        orgId,
        patientId,
        clinicianId,
        procedure,
        snapshot,
        idempotencyKey: request.headers['idempotency-key'] as string,
        auditEvent: audit(request, 'surgery_check.recorded', 'surgery_check', id, orgId),
      });
      if (!r.replay) deps.onCommitted();
      return reply.code(r.replay ? 200 : 201).send({ id: r.id, snapshot });
    },
  );

  const listChecks = async (orgId: string, patientId: string) => ({
    checks: (await deps.reviews.surgeryChecks(orgId, patientId)).map((c) => ({
      id: c.id,
      procedure: c.procedure,
      snapshot: c.snapshot,
      acknowledged_at: c.acknowledgedAt.toISOString(),
    })),
  });

  app.get(
    '/v1/patients/:patientId/surgery-checks',
    {
      config: { policy: patientPolicy('surgery_check.read') },
      schema: { params: idParams('patientId') },
    },
    async (request) => listChecks(org(request).orgId, params(request).patientId),
  );

  /** REQ-006: the check is visible to her. */
  app.get(
    '/v1/me/surgery-checks',
    {
      config: {
        policy: {
          kind: 'protected',
          action: 'surgery_check.read',
          resourceType: 'surgery_check',
          purpose: 'patient_request',
          resource: (_r, s) => ({
            type: 'surgery_check',
            id: null,
            orgId: s.orgId,
            patientId: s.patientId,
          }),
        },
      },
    },
    async (request) => {
      const orgId = request.subject?.orgId;
      const patientId = request.subject?.patientId;
      if (!orgId || !patientId)
        throw new ProblemError(403, 'authz.not_own_resource', 'Not allowed.');
      return listChecks(orgId, patientId);
    },
  );
}

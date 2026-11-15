import { createHash } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { AuditEventInput } from '@endo/audit';
import type { Episode, EpisodeStore } from '@endo/clinical-store';
import {
  SYNTHETIC_TREATMENT_SYSTEM,
  canonicalJson,
  validateAnswers,
  type ClinicalContent,
} from '@endo/config';
import type { FieldCipher } from '@endo/crypto';
import { redFlagKeyFor, uuidv7 } from '@endo/domain';
import { ProblemError } from '@endo/service-kit';

export interface EpisodeRouteDeps {
  readonly episodes: EpisodeStore;
  readonly content: ClinicalContent;
  /** Field encryption under each patient's own key, for her organisation (spec 11.2). */
  readonly cipherFor: (orgId: string) => FieldCipher;
  readonly onCommitted: () => void;
  readonly now: () => Date;
  /** Synthetic placeholder treatments are refused in staging and production. */
  readonly deployed: boolean;
}

const UUID = '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
const DATE = '^[0-9]{4}-[0-9]{2}-[0-9]{2}$';
const idParams = (...names: string[]) => ({
  type: 'object',
  additionalProperties: false,
  required: names,
  properties: Object.fromEntries(names.map((n) => [n, { type: 'string', pattern: UUID }])),
});
const keyHeader = {
  type: 'object',
  required: ['idempotency-key'],
  properties: { 'idempotency-key': { type: 'string', pattern: UUID } },
};

/** Her calendar date in a time zone, `YYYY-MM-DD`. */
export function localDate(now: Date, timeZone: string): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
}

const addDays = (date: string, days: number) =>
  new Date(Date.parse(`${date}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);

/**
 * The weeks she can complete now (REQ-003; Section 24 item 24): week k opens on its last day and
 * closes 7 days after it ends. Mirrors the database's own check, which decides.
 */
export function openWeeks(e: Episode, done: ReadonlySet<number>, now: Date): number[] {
  if (!e.timeZone || (e.status !== 'active' && e.status !== 'in_review')) return [];
  const today = localDate(now, e.timeZone);
  const open: number[] = [];
  for (let k = 1; k <= e.reviewIntervalWeeks; k++) {
    const weekEnd = addDays(e.startDate, k * 7);
    if (today >= addDays(weekEnd, -1) && today < addDays(weekEnd, 7) && !done.has(k)) open.push(k);
  }
  return open;
}

/** Her own patient record and organisation, from the verified token (never from the request). */
function own(request: FastifyRequest) {
  const patientId = request.subject?.patientId;
  const orgId = request.subject?.orgId;
  if (!patientId || !orgId) throw new ProblemError(403, 'authz.not_own_resource', 'Not allowed.');
  return { patientId, orgId };
}

const notFound = () => new ProblemError(404, 'episode.not_found', 'Not found.');

/**
 * Treatment episodes, goals, weekly check-ins and red flags (M2: REQ-002, REQ-003, REQ-007).
 *
 * - The clinician drafts for a patient of their organisation who shares with the care team
 *   (`/v1/patients/{id}/...`: the policy reads the patient from the path, never the body).
 * - She confirms with her goal (her own words are encrypted under her own key), then checks in
 *   weekly. Answers are validated against the instrument; error bodies never echo them.
 * - Red flags are recorded first, on their own, and also from inside the check-in, under one
 *   derived key, so they are recorded once and never lost when the rest is refused.
 */
export function registerEpisodeRoutes(app: FastifyInstance, deps: EpisodeRouteDeps): void {
  const { instrument } = deps.content;
  const audit = (
    request: FastifyRequest,
    action: string,
    type: string,
    id: string,
    orgId: string,
    purpose: 'treatment' | 'patient_request',
  ) => ({
    id: uuidv7(),
    ...AuditEventInput.parse({
      actor: { id: request.subject?.id ?? null, role: request.subject?.role ?? 'anonymous' },
      action,
      resource: { type, id },
      org_id: orgId,
      purpose_of_use: purpose,
      outcome: 'success',
      reason: null,
      request_id: request.id,
    }),
  });
  const treatmentOf = (e: Episode) =>
    deps.content.treatments.find(
      (t) => t.system === e.treatmentSystem && t.code === e.treatmentCode,
    ) ?? null;

  /** What she (or her clinician) sees of an episode; her goal text decrypted only for display. */
  const view = async (e: Episode, done: { weekIndex: number; isLate: boolean }[]) => {
    let goalText: string | null = null;
    if (e.goal?.textEncrypted) {
      goalText = await deps
        .cipherFor(e.orgId)
        .decrypt(e.goal.textEncrypted, {
          patientId: e.patientId,
          field: 'goal.text',
          recordId: e.goal.id,
        })
        .catch(() => null); // shredded or unreadable: never shown, never an error with data
    } else if (e.goal?.templateCode) {
      goalText = deps.content.goals.find((g) => g.code === e.goal?.templateCode)?.text ?? null;
    }
    const t = treatmentOf(e);
    return {
      id: e.id,
      status: e.status,
      treatment: { system: e.treatmentSystem, code: e.treatmentCode, display: t?.display ?? null },
      dose_text: e.doseText,
      adherence_mode: e.adherenceMode,
      start_date: e.startDate,
      review_date: e.reviewDate,
      review_interval_weeks: e.reviewIntervalWeeks,
      time_zone: e.timeZone,
      instrument_version: e.instrumentVersion,
      previous_episode_id: e.previousEpisodeId,
      goal: e.goal ? { template_code: e.goal.templateCode, text: goalText } : null,
      check_ins: done.map((c) => ({ week_index: c.weekIndex, is_late: c.isLate })),
      open_weeks: openWeeks(e, new Set(done.map((c) => c.weekIndex)), deps.now()),
    };
  };

  // ---- Clinician (REQ-002) -------------------------------------------------------------------

  const patientResource = (request: FastifyRequest, subject: { orgId: string | null }) => ({
    type: 'patient_record',
    id: (request.params as { patientId: string }).patientId,
    orgId: subject.orgId,
    patientId: (request.params as { patientId: string }).patientId,
  });

  /** What a clinician needs to draft: the treatment catalogue (no patient data). */
  app.get(
    '/v1/catalogue',
    {
      config: {
        policy: {
          kind: 'protected',
          action: 'catalogue.read',
          resourceType: 'treatment_catalogue',
          purpose: 'treatment',
          resource: (_r, subject) => ({
            type: 'treatment_catalogue',
            id: null,
            orgId: subject.orgId,
            patientId: null,
          }),
        },
      },
    },
    () => ({
      draft: deps.content.draft,
      treatments: deps.content.treatments.map((t) => ({
        system: t.system,
        code: t.code,
        display: t.display,
        adherence_mode: t.adherenceMode,
      })),
      review_interval_weeks: { default: 12, min: 4, max: 26 },
    }),
  );

  /** Patients of the organisation who currently share with the care team (pseudonymous ids). */
  app.get(
    '/v1/patients',
    {
      config: {
        policy: {
          kind: 'protected',
          action: 'patient.list',
          resourceType: 'patient_record',
          purpose: 'treatment',
          resource: (_r, subject) => ({
            type: 'patient_record',
            id: null,
            orgId: subject.orgId,
            patientId: null,
          }),
        },
      },
    },
    async (request) => {
      const orgId = request.subject?.orgId;
      if (!orgId) throw new ProblemError(403, 'authz.org_mismatch', 'Not allowed.');
      const patients = await deps.episodes.listSharingPatients(orgId);
      return {
        patients: patients.map((p) => ({ id: p.id, enrolled_at: p.enrolledAt.toISOString() })),
      };
    },
  );

  app.post(
    '/v1/patients/:patientId/episodes',
    {
      config: {
        policy: {
          kind: 'protected',
          action: 'episode.create',
          resourceType: 'patient_record',
          purpose: 'treatment',
          resource: patientResource,
        },
      },
      schema: {
        params: idParams('patientId'),
        headers: keyHeader,
        body: {
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
            previous_episode_id: { type: 'string', pattern: UUID },
          },
        },
      },
    },
    async (request, reply) => {
      const { patientId } = request.params as { patientId: string };
      const orgId = request.subject?.orgId;
      const prescriberId = request.clinicianId;
      if (!orgId || !prescriberId)
        throw new ProblemError(403, 'authz.org_mismatch', 'Not allowed.');
      const b = request.body as {
        treatment: { system: string; code: string };
        dose_text: string;
        start_date: string;
        review_interval_weeks?: number;
        previous_episode_id?: string;
      };
      const t = deps.content.treatments.find(
        (x) => x.system === b.treatment.system && x.code === b.treatment.code,
      );
      if (!t || (deps.deployed && t.system === SYNTHETIC_TREATMENT_SYSTEM))
        throw new ProblemError(
          422,
          'episode.unknown_treatment',
          'Choose a treatment from the list.',
        );
      if (Number.isNaN(Date.parse(`${b.start_date}T00:00:00Z`)))
        throw new ProblemError(422, 'episode.invalid_date', 'Check the start date.');
      const id = uuidv7();
      const r = await deps.episodes.createDraft({
        id,
        creationKey: request.headers['idempotency-key'] as string,
        orgId,
        patientId,
        prescriberId,
        previousEpisodeId: b.previous_episode_id ?? null,
        treatmentSystem: t.system,
        treatmentCode: t.code,
        adherenceMode: t.adherenceMode,
        doseText: b.dose_text,
        startDate: b.start_date,
        reviewIntervalWeeks: b.review_interval_weeks ?? 12,
        instrumentVersion: instrument.version,
        auditEvent: audit(request, 'episode.drafted', 'treatment_episode', id, orgId, 'treatment'),
      });
      if (r.outcome === 'conflict')
        throw new ProblemError(
          422,
          'idempotency.key_reused',
          'This Idempotency-Key was already used for a different request.',
        );
      if (r.outcome === 'not_found') throw notFound();
      if (r.outcome === 'created') deps.onCommitted();
      return reply.code(r.outcome === 'created' ? 201 : 200).send(await view(r.episode, []));
    },
  );

  /** A patient's episodes, for her clinician (consented). */
  app.get(
    '/v1/patients/:patientId/episodes',
    {
      config: {
        policy: {
          kind: 'protected',
          action: 'patient_data.read',
          resourceType: 'patient_record',
          purpose: 'treatment',
          resource: patientResource,
        },
      },
      schema: { params: idParams('patientId') },
    },
    async (request) => {
      const { patientId } = request.params as { patientId: string };
      const orgId = request.subject?.orgId as string;
      const list = await deps.episodes.listForPatient(orgId, patientId);
      return {
        episodes: await Promise.all(
          list.map(async (e) => ({
            ...(await view(e, await deps.episodes.listCheckIns(orgId, e.id))),
            red_flags: (await deps.episodes.listRedFlags(orgId, e.id)).map((f) => ({
              flags: f.flags,
              recorded_at: f.recordedAt.toISOString(),
            })),
          })),
        ),
      };
    },
  );

  // ---- Patient (REQ-002, REQ-003, REQ-007) ---------------------------------------------------

  const ownResource = (
    request: FastifyRequest,
    subject: { orgId: string | null; patientId: string | null },
  ) => ({
    type: 'treatment_episode',
    id: (request.params as { id?: string }).id ?? null,
    orgId: subject.orgId,
    patientId: subject.patientId,
  });

  /** What her app needs to show the check-in: draft wording only in development (spec 6). */
  app.get(
    '/v1/me/checkin-content',
    {
      config: {
        policy: {
          kind: 'protected',
          action: 'episode.read_own',
          resourceType: 'instrument',
          purpose: 'patient_request',
          resource: ownResource,
        },
      },
    },
    () => ({
      draft: instrument.draft,
      instrument_version: instrument.version,
      text: instrument.text,
      options: instrument.options,
      review_weeks: instrument.reviewWeeks,
      red_flags: instrument.redFlags.map((f) => ({
        id: f.id,
        text: f.text,
        routes_to: f.routesTo,
      })),
      goals: deps.content.goals,
    }),
  );

  app.get(
    '/v1/me/episodes',
    {
      config: {
        policy: {
          kind: 'protected',
          action: 'episode.read_own',
          resourceType: 'treatment_episode',
          purpose: 'patient_request',
          resource: ownResource,
        },
      },
    },
    async (request) => {
      const { patientId, orgId } = own(request);
      const list = await deps.episodes.listForPatient(orgId, patientId);
      return {
        episodes: await Promise.all(
          list.map(async (e) => view(e, await deps.episodes.listCheckIns(orgId, e.id))),
        ),
      };
    },
  );

  app.post(
    '/v1/episodes/:id/confirm',
    {
      config: {
        policy: {
          kind: 'protected',
          action: 'episode.confirm_own',
          resourceType: 'treatment_episode',
          purpose: 'patient_request',
          resource: ownResource,
        },
      },
      schema: {
        params: idParams('id'),
        headers: keyHeader,
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['goal', 'time_zone'],
          properties: {
            goal: {
              type: 'object',
              additionalProperties: false,
              minProperties: 1,
              maxProperties: 1,
              properties: {
                template_code: { type: 'string', pattern: '^[a-z][a-z0-9_]{0,63}$' },
                text: { type: 'string', minLength: 1, maxLength: 140 },
              },
            },
            time_zone: { type: 'string', maxLength: 64 },
          },
        },
      },
    },
    async (request) => {
      const { patientId, orgId } = own(request);
      const { id } = request.params as { id: string };
      const b = request.body as {
        goal: { template_code?: string; text?: string };
        time_zone: string;
      };
      try {
        localDate(new Date(), b.time_zone); // throws for an unknown time zone
      } catch {
        throw new ProblemError(422, 'episode.invalid_time_zone', 'Check your time zone.');
      }
      const goalId = uuidv7();
      let goal: { templateCode: string } | { textEncrypted: string };
      if (b.goal.template_code !== undefined) {
        if (!deps.content.goals.some((g) => g.code === b.goal.template_code))
          throw new ProblemError(422, 'goal.unknown_template', 'Choose a goal from the list.');
        goal = { templateCode: b.goal.template_code };
      } else {
        const text = (b.goal.text ?? '').trim();
        if (text.length === 0 || Array.from(new Intl.Segmenter().segment(text)).length > 140)
          throw new ProblemError(
            422,
            'goal.invalid_text',
            'Write your goal in up to 140 characters.',
          );
        goal = {
          textEncrypted: await deps
            .cipherFor(orgId)
            .encrypt(text, { patientId, field: 'goal.text', recordId: goalId }),
        };
      }
      const r = await deps.episodes.confirm({
        orgId,
        patientId,
        episodeId: id,
        goalId,
        goal,
        timeZone: b.time_zone,
        auditEvent: audit(
          request,
          'episode.confirmed',
          'treatment_episode',
          id,
          orgId,
          'patient_request',
        ),
      });
      if (r.outcome === 'line_busy')
        throw new ProblemError(
          409,
          'episode.line_busy',
          'Another treatment in this line is still running.',
        );
      if (r.outcome === 'not_found') {
        // Confirming again (a retry) answers with the episode as it is now.
        const existing = await deps.episodes.get(orgId, id, patientId);
        if (existing && existing.status !== 'draft' && existing.goal)
          return view(existing, await deps.episodes.listCheckIns(orgId, id));
        throw notFound();
      }
      deps.onCommitted();
      return view(r.episode, []);
    },
  );

  const redFlagBody = {
    type: 'array',
    minItems: 1,
    maxItems: 16,
    uniqueItems: true,
    items: { type: 'string', pattern: '^RF[0-9]{1,2}$' },
  } as const;
  const knownFlags = new Set(instrument.redFlags.map((f) => f.id));

  const recordRedFlags = async (
    request: FastifyRequest,
    episodeId: string,
    key: string,
    flags: readonly string[],
    shownAt: Date,
    acknowledgedAt: Date | null,
  ) => {
    const { patientId, orgId } = own(request);
    const id = uuidv7();
    const r = await deps.episodes.recordRedFlag({
      id,
      orgId,
      patientId,
      episodeId,
      idempotencyKey: key,
      flags,
      instrumentVersion: instrument.version,
      shownAt,
      acknowledgedAt,
      auditEvent: audit(
        request,
        'red_flag.recorded',
        'red_flag_event',
        id,
        orgId,
        'patient_request',
      ),
    });
    if (r.outcome === 'recorded') {
      deps.onCommitted();
      // Counts and codes only: never her answers (spec 2.3).
      request.log.warn({ event: 'red_flag.recorded', flags: flags.length });
    }
    return r;
  };

  /** Spec 6.3, REQ-007: as soon as she answers them, before the rest of the check-in. */
  app.post(
    '/v1/episodes/:id/red-flags',
    {
      config: {
        policy: {
          kind: 'protected',
          action: 'checkin.submit',
          resourceType: 'red_flag_event',
          purpose: 'patient_request',
          resource: ownResource,
        },
      },
      schema: {
        params: idParams('id'),
        headers: keyHeader,
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['flags', 'shown_at'],
          properties: {
            flags: redFlagBody,
            shown_at: { type: 'string', format: 'date-time' },
            acknowledged_at: { type: 'string', format: 'date-time' },
          },
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const b = request.body as { flags: string[]; shown_at: string; acknowledged_at?: string };
      if (!b.flags.every((f) => knownFlags.has(f)))
        throw new ProblemError(422, 'red_flag.unknown', 'Something went wrong. Please try again.');
      const shownAt = new Date(b.shown_at);
      const ackAt = b.acknowledged_at ? new Date(b.acknowledged_at) : null;
      if (ackAt && ackAt < shownAt)
        throw new ProblemError(
          422,
          'red_flag.ack_before_shown',
          'Something went wrong. Please try again.',
        );
      const r = await recordRedFlags(
        request,
        id,
        request.headers['idempotency-key'] as string,
        b.flags,
        shownAt,
        ackAt,
      );
      if (r.outcome === 'conflict')
        throw new ProblemError(
          422,
          'idempotency.key_reused',
          'This Idempotency-Key was already used for a different request.',
        );
      if (r.outcome === 'not_found') throw notFound();
      return reply
        .code(r.outcome === 'recorded' ? 201 : 200)
        .send({ id: r.id, recorded_at: r.recordedAt.toISOString() });
    },
  );

  app.post(
    '/v1/episodes/:id/checkins',
    {
      config: {
        policy: {
          kind: 'protected',
          action: 'checkin.submit',
          resourceType: 'check_in',
          purpose: 'patient_request',
          resource: ownResource,
        },
      },
      bodyLimit: 8192,
      schema: {
        params: idParams('id'),
        headers: keyHeader,
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['week_index', 'answers', 'client_created_at'],
          properties: {
            week_index: { type: 'integer', minimum: 1, maximum: 26 },
            answers: { type: 'object' },
            client_created_at: { type: 'string', format: 'date-time' },
            red_flags_shown_at: { type: 'string', format: 'date-time' },
          },
        },
      },
    },
    async (request, reply) => {
      const { patientId, orgId } = own(request);
      const { id } = request.params as { id: string };
      const key = request.headers['idempotency-key'] as string;
      const b = request.body as {
        week_index: number;
        answers: unknown;
        client_created_at: string;
        red_flags_shown_at?: string;
      };
      const episode = await deps.episodes.get(orgId, id, patientId);
      if (!episode) throw notFound();
      if (episode.instrumentVersion !== instrument.version)
        throw new ProblemError(409, 'checkin.instrument_changed', 'Please reload the app.');
      const checked = validateAnswers(instrument, episode.adherenceMode, b.week_index, b.answers);
      // Red flags first and whatever else happens: they are recorded even if the rest is refused.
      const flags = Array.isArray((b.answers as { red_flags?: unknown } | null)?.red_flags)
        ? (b.answers as { red_flags: unknown[] }).red_flags.filter(
            (f): f is string => typeof f === 'string' && knownFlags.has(f),
          )
        : [];
      if (flags.length > 0) {
        const shownAt = b.red_flags_shown_at
          ? new Date(b.red_flags_shown_at)
          : new Date(b.client_created_at);
        await recordRedFlags(
          request,
          id,
          await redFlagKeyFor(key),
          [...new Set(flags)].sort(),
          shownAt,
          null,
        );
      }
      if (!checked.ok)
        // Never echoes her answers, nor which one failed (spec 9.1).
        throw new ProblemError(422, 'checkin.invalid_answers', 'Some answers could not be saved.');
      const requestHash = createHash('sha256')
        .update(canonicalJson({ episode: id, week: b.week_index, answers: checked.answers }))
        .digest('hex');
      const checkInId = uuidv7();
      const r = await deps.episodes.submitCheckIn({
        id: checkInId,
        orgId,
        patientId,
        episodeId: id,
        weekIndex: b.week_index,
        idempotencyKey: key,
        requestHash,
        answers: checked.answers,
        instrumentVersion: instrument.version,
        clientCreatedAt: new Date(b.client_created_at),
        auditEvent: audit(
          request,
          'checkin.submitted',
          'check_in',
          checkInId,
          orgId,
          'patient_request',
        ),
      });
      switch (r.outcome) {
        case 'saved':
        case 'replay': {
          if (r.outcome === 'saved') deps.onCommitted();
          const done = await deps.episodes.listCheckIns(orgId, id);
          const open = openWeeks(episode, new Set(done.map((c) => c.weekIndex)), deps.now());
          return reply.code(r.outcome === 'saved' ? 201 : 200).send({
            id: r.checkIn.id,
            week_index: r.checkIn.weekIndex,
            is_late: r.checkIn.isLate,
            red_flags: checked.redFlags.length > 0,
            open_weeks: open,
          });
        }
        case 'conflict':
          throw new ProblemError(
            422,
            'idempotency.key_reused',
            'This Idempotency-Key was already used for a different request.',
          );
        case 'week_done':
          throw new ProblemError(409, 'checkin.week_done', 'This week is already saved.');
        case 'not_open':
          throw new ProblemError(409, 'checkin.not_open', 'This week’s check-in is not open yet.');
        case 'too_late':
          throw new ProblemError(409, 'checkin.too_late', 'This week can no longer be completed.');
        case 'not_found':
          throw notFound();
      }
    },
  );
}

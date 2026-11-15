import { sql, type Kysely, type Transaction } from 'kysely';
import { withOrg } from './org-scope.ts';
import type { AdherenceMode, ClinicalDatabase } from './schema.ts';

type Audit = Readonly<Record<string, unknown>> & { readonly id: string };

const addDays = (date: string, days: number) =>
  new Date(Date.parse(`${date}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);

/** One row of the review queue (spec 21.8 screen 1; REQ-005). */
export interface QueueItem {
  readonly episodeId: string;
  readonly patientId: string;
  readonly treatmentSystem: string;
  readonly treatmentCode: string;
  readonly doseText: string;
  readonly startDate: string;
  readonly reviewDate: string;
  readonly reviewIntervalWeeks: number;
  readonly checkIns: number;
  readonly redFlags: number;
  /** The latest verdict attempt, if any (shown only when verdicts are cleared for care). */
  readonly verdict: {
    readonly id: string;
    readonly code: string | null;
    readonly shadow: boolean;
  } | null;
}

/** A treatment the decision opens (switch, add), as drafted by the clinician. */
export interface NextTreatment {
  readonly id: string;
  readonly treatmentSystem: string;
  readonly treatmentCode: string;
  readonly adherenceMode: AdherenceMode;
  readonly doseText: string;
  readonly startDate: string;
  readonly reviewIntervalWeeks: number;
}

export type DecisionCode = 'continue' | 'switch' | 'add' | 'refer' | 'stop';

export interface DecisionRequest {
  readonly id: string;
  readonly orgId: string;
  readonly patientId: string;
  readonly episodeId: string;
  readonly clinicianId: string;
  readonly decision: DecisionCode;
  readonly verdictId: string | null;
  readonly noteEncrypted: string | null;
  /** Continue: the same treatment again; switch: the new one. Both in the same line. */
  readonly next: NextTreatment | null;
  /** Add: a treatment beside it, in a new line. */
  readonly added: NextTreatment | null;
  readonly idempotencyKey: string;
  readonly requestHash: string;
  readonly instrumentVersion: string;
  readonly auditEvent: Audit;
}

export type DecisionOutcome =
  | {
      readonly outcome: 'recorded' | 'replay';
      readonly id: string;
      readonly nextEpisodeId: string | null;
      readonly addedEpisodeId: string | null;
    }
  | { readonly outcome: 'conflict' }
  /** Not this patient's, not open for review, or already decided. */
  | { readonly outcome: 'not_open' };

export interface StoredDecision {
  readonly id: string;
  readonly episodeId: string;
  readonly decision: DecisionCode;
  readonly noteEncrypted: string | null;
  readonly nextEpisodeId: string | null;
  readonly addedEpisodeId: string | null;
  readonly decidedAt: Date;
}

/** Facts for a pre-surgery check (REQ-006), read from her record. */
export interface TreatmentFacts {
  readonly episodeId: string;
  readonly treatmentSystem: string;
  readonly treatmentCode: string;
  readonly doseText: string;
  readonly startDate: string;
  readonly reviewDate: string;
  readonly status: string;
  readonly reviewIntervalWeeks: number;
  readonly checkIns: number;
  /** Adherence over the weeks answered (daily: days/7; device: share of "yes"); null if none. */
  readonly adherence: number | null;
  readonly decision: DecisionCode | null;
}

export interface StoredSurgeryCheck {
  readonly id: string;
  readonly procedure: string;
  readonly snapshot: unknown;
  readonly acknowledgedAt: Date;
}

export interface ReviewStore {
  queue(orgId: string, today: string, horizonDays: number): Promise<QueueItem[]>;
  decide(r: DecisionRequest): Promise<DecisionOutcome>;
  decisions(orgId: string, patientId: string): Promise<StoredDecision[]>;
  treatmentFacts(orgId: string, patientId: string): Promise<TreatmentFacts[]>;
  recordSurgeryCheck(c: {
    readonly id: string;
    readonly orgId: string;
    readonly patientId: string;
    readonly clinicianId: string;
    readonly procedure: string;
    readonly snapshot: Readonly<Record<string, unknown>>;
    readonly idempotencyKey: string;
    readonly auditEvent: Audit;
  }): Promise<{ readonly id: string; readonly replay: boolean }>;
  surgeryChecks(orgId: string, patientId: string): Promise<StoredSurgeryCheck[]>;
}

async function lock(trx: Transaction<ClinicalDatabase>, scope: string, who: string, key: string) {
  await trx
    .selectNoFrom((eb) =>
      eb
        .fn('pg_advisory_xact_lock', [
          eb.fn('hashtextextended', [eb.val([scope, who, key].join(':')), eb.lit(0)]),
        ])
        .as('locked'),
    )
    .execute();
}

export class PostgresReviewStore implements ReviewStore {
  readonly #db: Kysely<ClinicalDatabase>;

  constructor(db: Kysely<ClinicalDatabase>) {
    this.#db = db;
  }

  queue(orgId: string, today: string, horizonDays: number): Promise<QueueItem[]> {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(today))
      return Promise.reject(new TypeError('today must be YYYY-MM-DD'));
    return withOrg(this.#db, orgId, async (trx) => {
      const rows = await trx
        .selectFrom('treatment_episode as e')
        // Only patients whose current share_with_care_team is granted (spec 3.2).
        .innerJoin('consent_current as c', (j) =>
          j
            .onRef('c.patient_id', '=', 'e.patient_id')
            .on('c.purpose', '=', 'share_with_care_team')
            .on('c.status', '=', 'granted'),
        )
        .select([
          'e.id',
          'e.patient_id',
          'e.treatment_system',
          'e.treatment_code',
          'e.dose_text',
          'e.review_interval_weeks',
        ])
        .select(sql<string>`e.start_date::text`.as('start_date'))
        .select(sql<string>`e.review_date::text`.as('review_date'))
        .select((eb) =>
          eb
            .selectFrom('check_in')
            .select(eb.fn.countAll<string>().as('n'))
            .whereRef('check_in.episode_id', '=', 'e.id')
            .as('check_ins'),
        )
        .select((eb) =>
          eb
            .selectFrom('red_flag_event')
            .select(eb.fn.countAll<string>().as('n'))
            .whereRef('red_flag_event.episode_id', '=', 'e.id')
            .as('red_flags'),
        )
        .where('e.org_id', '=', orgId)
        .where('e.status', 'in', ['active', 'in_review'])
        .where('e.review_date', '<=', addDays(today, horizonDays))
        .orderBy('e.review_date')
        .limit(500)
        .execute();
      const verdicts = new Map<string, QueueItem['verdict']>();
      if (rows.length > 0) {
        const v = await trx
          .selectFrom('verdict')
          .select(['id', 'episode_id', 'verdict_code', 'shadow', 'generated_at'])
          .where(
            'episode_id',
            'in',
            rows.map((r) => r.id),
          )
          .orderBy('generated_at', 'desc')
          .execute();
        for (const x of v)
          if (!verdicts.has(x.episode_id))
            verdicts.set(x.episode_id, { id: x.id, code: x.verdict_code, shadow: x.shadow });
      }
      const items = rows.map((r) => ({
        episodeId: r.id,
        patientId: r.patient_id,
        treatmentSystem: r.treatment_system,
        treatmentCode: r.treatment_code,
        doseText: r.dose_text,
        startDate: r.start_date,
        reviewDate: r.review_date,
        reviewIntervalWeeks: r.review_interval_weeks,
        checkIns: Number(r.check_ins ?? 0),
        redFlags: Number(r.red_flags ?? 0),
        verdict: verdicts.get(r.id) ?? null,
      }));
      // REQ-005: red flags pinned on top, then by due date.
      return items.sort(
        (a, b) =>
          Number(b.redFlags > 0) - Number(a.redFlags > 0) ||
          (a.reviewDate < b.reviewDate ? -1 : a.reviewDate > b.reviewDate ? 1 : 0),
      );
    });
  }

  decide(r: DecisionRequest): Promise<DecisionOutcome> {
    return withOrg(this.#db, r.orgId, async (trx) => {
      await lock(trx, 'review_decision', r.clinicianId, r.idempotencyKey);
      const existing = await trx
        .selectFrom('review_decision')
        .select(['id', 'request_hash', 'next_episode_id', 'added_episode_id'])
        .where('clinician_id', '=', r.clinicianId)
        .where('idempotency_key', '=', r.idempotencyKey)
        .executeTakeFirst();
      if (existing)
        return existing.request_hash === r.requestHash
          ? {
              outcome: 'replay' as const,
              id: existing.id,
              nextEpisodeId: existing.next_episode_id,
              addedEpisodeId: existing.added_episode_id,
            }
          : { outcome: 'conflict' as const };
      const episode = await trx
        .selectFrom('treatment_episode')
        .select(['id', 'line_id', 'status'])
        .where('id', '=', r.episodeId)
        .where('patient_id', '=', r.patientId)
        .forUpdate()
        .executeTakeFirst();
      if (!episode || (episode.status !== 'active' && episode.status !== 'in_review'))
        return { outcome: 'not_open' as const };
      const draft = async (t: NextTreatment, previous: string | null) => {
        await trx
          .insertInto('treatment_episode')
          .values({
            id: t.id,
            org_id: r.orgId,
            patient_id: r.patientId,
            prescriber_id: r.clinicianId,
            line_id: previous ? episode.line_id : t.id,
            previous_episode_id: previous,
            treatment_system: t.treatmentSystem,
            treatment_code: t.treatmentCode,
            adherence_mode: t.adherenceMode,
            dose_text: t.doseText,
            start_date: t.startDate,
            review_interval_weeks: t.reviewIntervalWeeks,
            instrument_version: r.instrumentVersion,
            creation_key: t.id,
          })
          .execute();
      };
      // Close first: the line's next episode is a draft, and only one episode may be open.
      await trx
        .updateTable('treatment_episode')
        .set({ status: 'closed' })
        .where('id', '=', r.episodeId)
        .execute();
      if (r.next) await draft(r.next, r.episodeId);
      if (r.added) await draft(r.added, null);
      await trx
        .insertInto('review_decision')
        .values({
          id: r.id,
          org_id: r.orgId,
          patient_id: r.patientId,
          episode_id: r.episodeId,
          verdict_id: r.verdictId,
          clinician_id: r.clinicianId,
          decision_code: r.decision,
          note_encrypted: r.noteEncrypted,
          next_episode_id: r.next?.id ?? null,
          added_episode_id: r.added?.id ?? null,
          idempotency_key: r.idempotencyKey,
          request_hash: r.requestHash,
        })
        .execute();
      await trx
        .insertInto('audit_outbox')
        .values({ id: r.auditEvent.id, event: JSON.stringify(r.auditEvent) })
        .execute();
      return {
        outcome: 'recorded' as const,
        id: r.id,
        nextEpisodeId: r.next?.id ?? null,
        addedEpisodeId: r.added?.id ?? null,
      };
    });
  }

  decisions(orgId: string, patientId: string): Promise<StoredDecision[]> {
    return withOrg(this.#db, orgId, async (trx) => {
      const rows = await trx
        .selectFrom('review_decision')
        .select([
          'id',
          'episode_id',
          'decision_code',
          'note_encrypted',
          'next_episode_id',
          'added_episode_id',
          'decided_at',
        ])
        .where('patient_id', '=', patientId)
        .orderBy('decided_at', 'desc')
        .execute();
      return rows.map((d) => ({
        id: d.id,
        episodeId: d.episode_id,
        decision: d.decision_code,
        noteEncrypted: d.note_encrypted,
        nextEpisodeId: d.next_episode_id,
        addedEpisodeId: d.added_episode_id,
        decidedAt: d.decided_at,
      }));
    });
  }

  treatmentFacts(orgId: string, patientId: string): Promise<TreatmentFacts[]> {
    return withOrg(this.#db, orgId, async (trx) => {
      const eps = await trx
        .selectFrom('treatment_episode as e')
        .leftJoin('review_decision as d', 'd.episode_id', 'e.id')
        .select([
          'e.id',
          'e.treatment_system',
          'e.treatment_code',
          'e.dose_text',
          'e.status',
          'e.review_interval_weeks',
          'e.adherence_mode',
          'd.decision_code',
        ])
        .select(sql<string>`e.start_date::text`.as('start_date'))
        .select(sql<string>`e.review_date::text`.as('review_date'))
        .where('e.patient_id', '=', patientId)
        .where('e.status', '<>', 'draft')
        .orderBy('e.start_date')
        .execute();
      const out: TreatmentFacts[] = [];
      for (const e of eps) {
        const answers = await trx
          .selectFrom('check_in')
          .select('answers')
          .where('episode_id', '=', e.id)
          .execute();
        const q7 = answers.map((a) => (a.answers as { Q7?: unknown } | null)?.Q7);
        let adherence: number | null = null;
        if (e.adherence_mode === 'daily') {
          const days = q7.filter((v): v is number => typeof v === 'number');
          adherence = days.length ? days.reduce((s, d) => s + d, 0) / (7 * days.length) : null;
        } else {
          const yn = q7.filter((v) => v === 'yes' || v === 'no');
          adherence = yn.length ? yn.filter((v) => v === 'yes').length / yn.length : null;
        }
        out.push({
          episodeId: e.id,
          treatmentSystem: e.treatment_system,
          treatmentCode: e.treatment_code,
          doseText: e.dose_text,
          startDate: e.start_date,
          reviewDate: e.review_date,
          status: e.status,
          reviewIntervalWeeks: e.review_interval_weeks,
          checkIns: answers.length,
          adherence: adherence === null ? null : Math.round(adherence * 1000) / 1000,
          decision: e.decision_code,
        });
      }
      return out;
    });
  }

  recordSurgeryCheck(c: Parameters<ReviewStore['recordSurgeryCheck']>[0]) {
    return withOrg(this.#db, c.orgId, async (trx) => {
      await lock(trx, 'surgery_check', c.clinicianId, c.idempotencyKey);
      const existing = await trx
        .selectFrom('surgery_check')
        .select('id')
        .where('clinician_id', '=', c.clinicianId)
        .where('idempotency_key', '=', c.idempotencyKey)
        .executeTakeFirst();
      if (existing) return { id: existing.id, replay: true };
      await trx
        .insertInto('surgery_check')
        .values({
          id: c.id,
          org_id: c.orgId,
          patient_id: c.patientId,
          clinician_id: c.clinicianId,
          procedure_code: c.procedure,
          snapshot: JSON.stringify(c.snapshot),
          idempotency_key: c.idempotencyKey,
        })
        .execute();
      await trx
        .insertInto('audit_outbox')
        .values({ id: c.auditEvent.id, event: JSON.stringify(c.auditEvent) })
        .execute();
      return { id: c.id, replay: false };
    });
  }

  surgeryChecks(orgId: string, patientId: string): Promise<StoredSurgeryCheck[]> {
    return withOrg(this.#db, orgId, async (trx) => {
      const rows = await trx
        .selectFrom('surgery_check')
        .select(['id', 'procedure_code', 'snapshot', 'acknowledged_at'])
        .where('patient_id', '=', patientId)
        .orderBy('acknowledged_at', 'desc')
        .execute();
      return rows.map((r) => ({
        id: r.id,
        procedure: r.procedure_code,
        snapshot: r.snapshot,
        acknowledgedAt: r.acknowledged_at,
      }));
    });
  }
}

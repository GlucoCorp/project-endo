import { sql, type Kysely, type Transaction } from 'kysely';
import type { PatientKeyStore } from '@endo/crypto';
import { withOrg } from './org-scope.ts';
import type { AdherenceMode, ClinicalDatabase, EpisodeStatus } from './schema.ts';

type Audit = Readonly<Record<string, unknown>> & { readonly id: string };

/** A treatment episode as stored (spec 5.1, REQ-002). Dates are her calendar dates, `YYYY-MM-DD`. */
export interface Episode {
  readonly id: string;
  readonly orgId: string;
  readonly patientId: string;
  readonly prescriberId: string;
  readonly lineId: string;
  readonly previousEpisodeId: string | null;
  readonly treatmentSystem: string;
  readonly treatmentCode: string;
  readonly adherenceMode: AdherenceMode;
  readonly doseText: string;
  readonly startDate: string;
  readonly reviewIntervalWeeks: number;
  readonly reviewDate: string;
  readonly timeZone: string | null;
  readonly instrumentVersion: string;
  readonly status: EpisodeStatus;
  readonly createdAt: Date;
  readonly confirmedAt: Date | null;
  readonly closedAt: Date | null;
  /** Her Idempotency-Key for the confirmation (migration 0009). */
  readonly confirmKey: string | null;
  /** Her goal, if set: a template code, or her own words still encrypted. */
  readonly goal: {
    readonly id: string;
    readonly templateCode: string | null;
    readonly textEncrypted: string | null;
  } | null;
}

export interface NewEpisode {
  readonly id: string;
  /** The clinician's Idempotency-Key: a retry with it returns the same draft (spec 9.1). */
  readonly creationKey: string;
  readonly orgId: string;
  readonly patientId: string;
  readonly prescriberId: string;
  /** A switch continues this episode's line; null starts a new line. */
  readonly previousEpisodeId: string | null;
  readonly treatmentSystem: string;
  readonly treatmentCode: string;
  readonly adherenceMode: AdherenceMode;
  readonly doseText: string;
  readonly startDate: string;
  readonly reviewIntervalWeeks: number;
  readonly instrumentVersion: string;
  readonly auditEvent: Audit;
}

export interface EpisodeConfirmation {
  readonly orgId: string;
  readonly patientId: string;
  readonly episodeId: string;
  /** Her Idempotency-Key: kept with the confirmation (spec 9.1). */
  readonly confirmKey: string;
  readonly goalId: string;
  readonly goal: { readonly templateCode: string } | { readonly textEncrypted: string };
  readonly timeZone: string;
  readonly auditEvent: Audit;
}

export type DraftOutcome =
  | { readonly outcome: 'created' | 'replay'; readonly episode: Episode }
  /** The same key was used for a different draft. */
  | { readonly outcome: 'conflict' }
  /** The previous episode is not this patient's. */
  | { readonly outcome: 'not_found' };

/** A patient a clinician may draft for: her current share_with_care_team is granted. */
export interface SharingPatient {
  readonly id: string;
  readonly enrolledAt: Date;
}

export type ConfirmOutcome =
  | { readonly outcome: 'confirmed'; readonly episode: Episode }
  /** Not hers, not a draft any more, or gone. One answer for all, so nothing is revealed. */
  | { readonly outcome: 'not_found' }
  /** Another episode of this line is already active (REQ-002). */
  | { readonly outcome: 'line_busy' };

export interface CheckInSubmission {
  readonly id: string;
  readonly orgId: string;
  readonly patientId: string;
  readonly episodeId: string;
  readonly weekIndex: number;
  readonly idempotencyKey: string;
  /** SHA-256 hex of the canonical request: the same key with another request is a conflict. */
  readonly requestHash: string;
  readonly answers: Readonly<Record<string, unknown>>;
  readonly instrumentVersion: string;
  readonly clientCreatedAt: Date;
  readonly auditEvent: Audit;
}

export interface SavedCheckIn {
  readonly id: string;
  readonly weekIndex: number;
  readonly submittedAt: Date;
  readonly isLate: boolean;
}

export type CheckInOutcome =
  | { readonly outcome: 'saved'; readonly checkIn: SavedCheckIn }
  /** The same request again: the original result. */
  | { readonly outcome: 'replay'; readonly checkIn: SavedCheckIn }
  | { readonly outcome: 'conflict' }
  /** That week already has a check-in (from another request). */
  | { readonly outcome: 'week_done' }
  | { readonly outcome: 'not_open' }
  /** More than 7 days after the week: it stays missing (REQ-003). */
  | { readonly outcome: 'too_late' }
  | { readonly outcome: 'not_found' };

export interface RedFlagReport {
  readonly id: string;
  readonly orgId: string;
  readonly patientId: string;
  readonly episodeId: string;
  readonly idempotencyKey: string;
  readonly flags: readonly string[];
  readonly instrumentVersion: string;
  readonly shownAt: Date;
  readonly acknowledgedAt: Date | null;
  readonly auditEvent: Audit;
}

export type RedFlagOutcome =
  | { readonly outcome: 'recorded' | 'replay'; readonly id: string; readonly recordedAt: Date }
  | { readonly outcome: 'conflict' }
  | { readonly outcome: 'not_found' };

export interface StoredCheckIn extends SavedCheckIn {
  readonly answers: unknown;
  readonly instrumentVersion: string;
}

export interface StoredRedFlag {
  readonly id: string;
  readonly flags: readonly string[];
  readonly shownAt: Date;
  readonly acknowledgedAt: Date | null;
  readonly recordedAt: Date;
}

/** Treatment episodes, goals, check-ins and red flags (M2), always inside one organisation's scope. */
export interface EpisodeStore {
  createDraft(e: NewEpisode): Promise<DraftOutcome>;
  /** Patients of the organisation who currently share with the care team, newest first. */
  listSharingPatients(orgId: string): Promise<SharingPatient[]>;
  /** One episode, only if it belongs to this patient (or, with `patientId` null, the org). */
  get(orgId: string, episodeId: string, patientId: string | null): Promise<Episode | null>;
  /** Newest first; at most `limit` (100), or every one with `null` (her export, REQ-009). */
  listForPatient(orgId: string, patientId: string, limit?: number | null): Promise<Episode[]>;
  /** Her goal and confirmation together: the episode becomes active (REQ-002). */
  confirm(c: EpisodeConfirmation): Promise<ConfirmOutcome>;
  submitCheckIn(c: CheckInSubmission): Promise<CheckInOutcome>;
  recordRedFlag(r: RedFlagReport): Promise<RedFlagOutcome>;
  listCheckIns(orgId: string, episodeId: string): Promise<StoredCheckIn[]>;
  listRedFlags(orgId: string, episodeId: string): Promise<StoredRedFlag[]>;
}

const EPISODE_COLUMNS = [
  'e.id',
  'e.org_id',
  'e.patient_id',
  'e.prescriber_id',
  'e.line_id',
  'e.previous_episode_id',
  'e.treatment_system',
  'e.treatment_code',
  'e.adherence_mode',
  'e.dose_text',
  'e.review_interval_weeks',
  'e.time_zone',
  'e.instrument_version',
  'e.status',
  'e.created_at',
  'e.confirmed_at',
  'e.closed_at',
  'e.confirm_key',
  'g.id as goal_id',
  'g.goal_template_code',
  'g.text_encrypted',
] as const;

function episodeQuery(trx: Transaction<ClinicalDatabase>) {
  return (
    trx
      .selectFrom('treatment_episode as e')
      .leftJoin('goal as g', 'g.episode_id', 'e.id')
      .select(EPISODE_COLUMNS)
      // Dates as text: the driver would turn a DATE into a local-time Date and shift it.
      .select(sql<string>`e.start_date::text`.as('start_date'))
      .select(sql<string>`e.review_date::text`.as('review_date'))
  );
}

type EpisodeRow = Awaited<ReturnType<ReturnType<typeof episodeQuery>['executeTakeFirstOrThrow']>>;

function toEpisode(r: EpisodeRow): Episode {
  return {
    id: r.id,
    orgId: r.org_id,
    patientId: r.patient_id,
    prescriberId: r.prescriber_id,
    lineId: r.line_id,
    previousEpisodeId: r.previous_episode_id,
    treatmentSystem: r.treatment_system,
    treatmentCode: r.treatment_code,
    adherenceMode: r.adherence_mode,
    doseText: r.dose_text,
    startDate: r.start_date,
    reviewIntervalWeeks: r.review_interval_weeks,
    reviewDate: r.review_date,
    timeZone: r.time_zone,
    instrumentVersion: r.instrument_version,
    status: r.status,
    createdAt: r.created_at,
    confirmedAt: r.confirmed_at,
    closedAt: r.closed_at,
    confirmKey: r.confirm_key,
    goal: r.goal_id
      ? { id: r.goal_id, templateCode: r.goal_template_code, textEncrypted: r.text_encrypted }
      : null,
  };
}

/** The database's reason for refusing a check-in, mapped to an outcome; anything else rethrows. */
function checkInRefusal(error: unknown): CheckInOutcome | null {
  const e = error as { code?: string; message?: string; constraint?: string };
  if (e.code === '23505' && e.constraint === 'check_in_episode_id_week_index_key')
    return { outcome: 'week_done' };
  if (e.code !== '23514') return null;
  const m = e.message ?? '';
  if (m.includes('not open yet')) return { outcome: 'not_open' };
  if (m.includes('no longer be completed')) return { outcome: 'too_late' };
  if (m.includes('active episode') || m.includes('past the review') || m.includes('version'))
    return { outcome: 'not_found' };
  return null;
}

async function queueAudit(trx: Transaction<ClinicalDatabase>, event: Audit): Promise<void> {
  await trx
    .insertInto('audit_outbox')
    .values({ id: event.id, event: JSON.stringify(event) })
    .execute();
}

/** Serialises retries of one idempotency key, so the loser sees the winner's row. */
async function lockKey(
  trx: Transaction<ClinicalDatabase>,
  scope: string,
  patientId: string,
  key: string,
) {
  await trx
    .selectNoFrom((eb) =>
      eb
        .fn('pg_advisory_xact_lock', [
          eb.fn('hashtextextended', [eb.val([scope, patientId, key].join(':')), eb.lit(0)]),
        ])
        .as('locked'),
    )
    .execute();
}

export class PostgresEpisodeStore implements EpisodeStore {
  readonly #db: Kysely<ClinicalDatabase>;

  constructor(db: Kysely<ClinicalDatabase>) {
    this.#db = db;
  }

  createDraft(e: NewEpisode): Promise<DraftOutcome> {
    return withOrg(this.#db, e.orgId, async (trx) => {
      await lockKey(trx, 'episode', e.prescriberId, e.creationKey);
      const existing = await episodeQuery(trx)
        .select('e.creation_key')
        .where('e.prescriber_id', '=', e.prescriberId)
        .where('e.creation_key', '=', e.creationKey)
        .executeTakeFirst();
      if (existing) {
        const ep = toEpisode(existing);
        const same =
          ep.patientId === e.patientId &&
          ep.previousEpisodeId === e.previousEpisodeId &&
          ep.treatmentSystem === e.treatmentSystem &&
          ep.treatmentCode === e.treatmentCode &&
          ep.doseText === e.doseText &&
          ep.startDate === e.startDate &&
          ep.reviewIntervalWeeks === e.reviewIntervalWeeks;
        return same
          ? { outcome: 'replay' as const, episode: ep }
          : { outcome: 'conflict' as const };
      }
      let lineId = e.id;
      if (e.previousEpisodeId) {
        const prev = await trx
          .selectFrom('treatment_episode')
          .select('line_id')
          .where('id', '=', e.previousEpisodeId)
          .where('patient_id', '=', e.patientId)
          .executeTakeFirst();
        if (!prev) return { outcome: 'not_found' as const };
        lineId = prev.line_id;
      }
      await trx
        .insertInto('treatment_episode')
        .values({
          id: e.id,
          org_id: e.orgId,
          patient_id: e.patientId,
          prescriber_id: e.prescriberId,
          line_id: lineId,
          previous_episode_id: e.previousEpisodeId,
          treatment_system: e.treatmentSystem,
          treatment_code: e.treatmentCode,
          adherence_mode: e.adherenceMode,
          dose_text: e.doseText,
          start_date: e.startDate,
          review_interval_weeks: e.reviewIntervalWeeks,
          instrument_version: e.instrumentVersion,
          creation_key: e.creationKey,
        })
        .execute();
      await queueAudit(trx, e.auditEvent);
      const episode = toEpisode(
        await episodeQuery(trx).where('e.id', '=', e.id).executeTakeFirstOrThrow(),
      );
      return { outcome: 'created' as const, episode };
    });
  }

  listSharingPatients(orgId: string): Promise<SharingPatient[]> {
    return withOrg(this.#db, orgId, async (trx) => {
      const rows = await trx
        .selectFrom('patient_record as p')
        .innerJoin('consent_current as c', (j) =>
          j
            .onRef('c.patient_id', '=', 'p.id')
            .on('c.purpose', '=', 'share_with_care_team')
            .on('c.status', '=', 'granted'),
        )
        .select(['p.id', 'p.created_at'])
        .where('p.org_id', '=', orgId)
        .orderBy('p.created_at', 'desc')
        .limit(100)
        .execute();
      return rows.map((r) => ({ id: r.id, enrolledAt: r.created_at }));
    });
  }

  get(orgId: string, episodeId: string, patientId: string | null): Promise<Episode | null> {
    return withOrg(this.#db, orgId, async (trx) => {
      let q = episodeQuery(trx).where('e.id', '=', episodeId);
      if (patientId !== null) q = q.where('e.patient_id', '=', patientId);
      const row = await q.executeTakeFirst();
      return row ? toEpisode(row) : null;
    });
  }

  listForPatient(orgId: string, patientId: string, limit: number | null = 100): Promise<Episode[]> {
    return withOrg(this.#db, orgId, async (trx) => {
      const q = episodeQuery(trx)
        .where('e.patient_id', '=', patientId)
        .orderBy('e.created_at', 'desc');
      const rows = await (limit === null ? q : q.limit(limit)).execute();
      return rows.map(toEpisode);
    });
  }

  async confirm(c: EpisodeConfirmation): Promise<ConfirmOutcome> {
    try {
      return await withOrg(this.#db, c.orgId, async (trx) => {
        const row = await trx
          .selectFrom('treatment_episode')
          .select('id')
          .where('id', '=', c.episodeId)
          .where('patient_id', '=', c.patientId)
          .where('status', '=', 'draft')
          .forUpdate()
          .executeTakeFirst();
        if (!row) return { outcome: 'not_found' as const };
        await trx
          .insertInto('goal')
          .values({
            id: c.goalId,
            org_id: c.orgId,
            patient_id: c.patientId,
            episode_id: c.episodeId,
            goal_template_code: 'templateCode' in c.goal ? c.goal.templateCode : null,
            text_encrypted: 'textEncrypted' in c.goal ? c.goal.textEncrypted : null,
          })
          .execute();
        await trx
          .updateTable('treatment_episode')
          .set({ status: 'active', time_zone: c.timeZone, confirm_key: c.confirmKey })
          .where('id', '=', c.episodeId)
          .execute();
        await queueAudit(trx, c.auditEvent);
        const episode = toEpisode(
          await episodeQuery(trx).where('e.id', '=', c.episodeId).executeTakeFirstOrThrow(),
        );
        return { outcome: 'confirmed' as const, episode };
      });
    } catch (error) {
      const e = error as { code?: string; constraint?: string };
      if (e.code === '23505' && e.constraint === 'treatment_episode_one_active_per_line')
        return { outcome: 'line_busy' };
      throw error;
    }
  }

  async submitCheckIn(c: CheckInSubmission): Promise<CheckInOutcome> {
    try {
      return await withOrg(this.#db, c.orgId, async (trx) => {
        await lockKey(trx, 'check_in', c.patientId, c.idempotencyKey);
        const existing = await trx
          .selectFrom('check_in')
          .select(['id', 'week_index', 'request_hash', 'submitted_at', 'is_late'])
          .where('patient_id', '=', c.patientId)
          .where('idempotency_key', '=', c.idempotencyKey)
          .executeTakeFirst();
        if (existing) {
          if (existing.request_hash !== c.requestHash) return { outcome: 'conflict' as const };
          return {
            outcome: 'replay' as const,
            checkIn: {
              id: existing.id,
              weekIndex: existing.week_index,
              submittedAt: existing.submitted_at,
              isLate: existing.is_late,
            },
          };
        }
        const mine = await trx
          .selectFrom('treatment_episode')
          .select('id')
          .where('id', '=', c.episodeId)
          .where('patient_id', '=', c.patientId)
          .executeTakeFirst();
        if (!mine) return { outcome: 'not_found' as const };
        const saved = await trx
          .insertInto('check_in')
          .values({
            id: c.id,
            org_id: c.orgId,
            patient_id: c.patientId,
            episode_id: c.episodeId,
            week_index: c.weekIndex,
            idempotency_key: c.idempotencyKey,
            request_hash: c.requestHash,
            answers: JSON.stringify(c.answers),
            instrument_version: c.instrumentVersion,
            client_created_at: c.clientCreatedAt,
          })
          .returning(['id', 'week_index', 'submitted_at', 'is_late'])
          .executeTakeFirstOrThrow();
        await queueAudit(trx, c.auditEvent);
        return {
          outcome: 'saved' as const,
          checkIn: {
            id: saved.id,
            weekIndex: saved.week_index,
            submittedAt: saved.submitted_at,
            isLate: saved.is_late,
          },
        };
      });
    } catch (error) {
      const refusal = checkInRefusal(error);
      if (refusal) return refusal;
      throw error;
    }
  }

  async recordRedFlag(r: RedFlagReport): Promise<RedFlagOutcome> {
    try {
      return await withOrg(this.#db, r.orgId, async (trx) => {
        await lockKey(trx, 'red_flag', r.patientId, r.idempotencyKey);
        const existing = await trx
          .selectFrom('red_flag_event')
          .select(['id', 'episode_id', 'flags', 'recorded_at', 'acknowledged_at', 'shown_at'])
          .where('patient_id', '=', r.patientId)
          .where('idempotency_key', '=', r.idempotencyKey)
          .executeTakeFirst();
        if (existing) {
          const same =
            existing.episode_id === r.episodeId &&
            JSON.stringify([...existing.flags].sort()) === JSON.stringify([...r.flags].sort());
          if (!same) return { outcome: 'conflict' as const };
          // The urgent screen's own report may arrive after the check-in's copy: keep her
          // acknowledgement (set once; the database refuses any other change).
          if (
            existing.acknowledged_at === null &&
            r.acknowledgedAt !== null &&
            r.acknowledgedAt >= existing.shown_at
          )
            await trx
              .updateTable('red_flag_event')
              .set({ acknowledged_at: r.acknowledgedAt })
              .where('id', '=', existing.id)
              .execute();
          return { outcome: 'replay' as const, id: existing.id, recordedAt: existing.recorded_at };
        }
        const mine = await trx
          .selectFrom('treatment_episode')
          .select('id')
          .where('id', '=', r.episodeId)
          .where('patient_id', '=', r.patientId)
          .executeTakeFirst();
        if (!mine) return { outcome: 'not_found' as const };
        const saved = await trx
          .insertInto('red_flag_event')
          .values({
            id: r.id,
            org_id: r.orgId,
            patient_id: r.patientId,
            episode_id: r.episodeId,
            idempotency_key: r.idempotencyKey,
            flags: [...r.flags],
            instrument_version: r.instrumentVersion,
            shown_at: r.shownAt,
            acknowledged_at: r.acknowledgedAt,
          })
          .returning(['id', 'recorded_at'])
          .executeTakeFirstOrThrow();
        await queueAudit(trx, r.auditEvent);
        return { outcome: 'recorded' as const, id: saved.id, recordedAt: saved.recorded_at };
      });
    } catch (error) {
      const e = error as { code?: string; message?: string };
      if (e.code === '23514' && (e.message ?? '').includes('confirmed episode'))
        return { outcome: 'not_found' };
      throw error;
    }
  }

  listCheckIns(orgId: string, episodeId: string): Promise<StoredCheckIn[]> {
    return withOrg(this.#db, orgId, async (trx) => {
      const rows = await trx
        .selectFrom('check_in')
        .select(['id', 'week_index', 'answers', 'instrument_version', 'submitted_at', 'is_late'])
        .where('episode_id', '=', episodeId)
        .orderBy('week_index')
        .execute();
      return rows.map((r) => ({
        id: r.id,
        weekIndex: r.week_index,
        answers: r.answers,
        instrumentVersion: r.instrument_version,
        submittedAt: r.submitted_at,
        isLate: r.is_late,
      }));
    });
  }

  listRedFlags(orgId: string, episodeId: string): Promise<StoredRedFlag[]> {
    return withOrg(this.#db, orgId, async (trx) => {
      const rows = await trx
        .selectFrom('red_flag_event')
        .select(['id', 'flags', 'shown_at', 'acknowledged_at', 'recorded_at'])
        .where('episode_id', '=', episodeId)
        .orderBy('recorded_at', 'desc')
        .execute();
      return rows.map((r) => ({
        id: r.id,
        flags: r.flags,
        shownAt: r.shown_at,
        acknowledgedAt: r.acknowledged_at,
        recordedAt: r.recorded_at,
      }));
    });
  }
}

/**
 * Durable per-patient data keys in the clinical database (spec 11.2; REQ-009), for one
 * organisation: `new FieldCipher(kms, new PostgresPatientKeyStore(db, orgId))` encrypts each
 * patient's free text under her own key. `destroy` writes a tombstone; the database deletes the
 * key in the same transaction and refuses a new one (migration 0008).
 */
export class PostgresPatientKeyStore implements PatientKeyStore {
  readonly #db: Kysely<ClinicalDatabase>;
  readonly #orgId: string;

  constructor(db: Kysely<ClinicalDatabase>, orgId: string) {
    this.#db = db;
    this.#orgId = orgId;
  }

  get(patientId: string): Promise<Uint8Array | null | 'destroyed'> {
    return withOrg(this.#db, this.#orgId, async (trx) => {
      const shredded = await trx
        .selectFrom('patient_key_shredded')
        .select('patient_id')
        .where('patient_id', '=', patientId)
        .executeTakeFirst();
      if (shredded) return 'destroyed' as const;
      const row = await trx
        .selectFrom('patient_key')
        .select('wrapped')
        .where('patient_id', '=', patientId)
        .executeTakeFirst();
      return row ? new Uint8Array(row.wrapped) : null;
    });
  }

  putIfAbsent(patientId: string, wrapped: Uint8Array): Promise<Uint8Array> {
    return withOrg(this.#db, this.#orgId, async (trx) => {
      await trx
        .insertInto('patient_key')
        .values({ patient_id: patientId, org_id: this.#orgId, wrapped: Buffer.from(wrapped) })
        .onConflict((oc) => oc.column('patient_id').doNothing())
        .execute();
      const row = await trx
        .selectFrom('patient_key')
        .select('wrapped')
        .where('patient_id', '=', patientId)
        .executeTakeFirstOrThrow();
      return new Uint8Array(row.wrapped);
    });
  }

  destroy(patientId: string): Promise<void> {
    return withOrg(this.#db, this.#orgId, async (trx) => {
      await trx
        .insertInto('patient_key_shredded')
        .values({ patient_id: patientId, org_id: this.#orgId })
        .onConflict((oc) => oc.column('patient_id').doNothing())
        .execute();
    });
  }
}

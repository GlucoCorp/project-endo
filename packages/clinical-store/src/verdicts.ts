import { sql, type Kysely } from 'kysely';
import { withOrg } from './org-scope.ts';
import type { ClinicalDatabase } from './schema.ts';

type Audit = Readonly<Record<string, unknown>> & { readonly id: string };

/** What the engine judges, read in one transaction (REQ-004). */
export interface EpisodeEvidence {
  readonly episodeId: string;
  readonly orgId: string;
  readonly patientId: string;
  readonly status: string;
  readonly startDate: string;
  readonly reviewDate: string;
  readonly reviewIntervalWeeks: number;
  readonly adherenceMode: 'daily' | 'device_or_injection';
  readonly instrumentVersion: string;
  readonly timeZone: string | null;
  readonly checkIns: readonly { readonly weekIndex: number; readonly answers: unknown }[];
  readonly redFlagEvents: number;
}

export interface NewVerdict {
  readonly id: string;
  readonly orgId: string;
  readonly patientId: string;
  readonly episodeId: string;
  readonly result:
    | {
        readonly outcome: 'generated';
        readonly code: string;
        readonly secondary: string | null;
        readonly modifiers: readonly string[];
        readonly inputHash: string;
        readonly explanation: Readonly<Record<string, unknown>>;
      }
    | { readonly outcome: 'not_generated'; readonly reason: string };
  readonly rulesetVersion: string;
  readonly rulesetDigest: string;
  readonly instrumentVersion: string;
  readonly generatedBy: 'system' | 'on_demand';
  readonly requestedBy: string | null;
  readonly auditEvent: Audit;
}

export interface StoredVerdict {
  readonly id: string;
  readonly outcome: 'generated' | 'not_generated';
  readonly reason: string | null;
  readonly code: string | null;
  readonly secondary: string | null;
  readonly modifiers: readonly string[];
  readonly rulesetVersion: string;
  readonly inputHash: string | null;
  readonly explanation: unknown;
  readonly generatedBy: 'system' | 'on_demand';
  readonly generatedAt: Date;
  readonly shadow: boolean;
}

export interface VerdictStore {
  /** Episodes due a scheduled verdict for this rule set version (cross-organisation, ids only). */
  due(today: string, rulesetVersion: string): Promise<{ episodeId: string; orgId: string }[]>;
  evidence(orgId: string, episodeId: string): Promise<EpisodeEvidence | null>;
  /** Records a generation attempt with its audit event. False if the schedule already did it. */
  record(v: NewVerdict): Promise<boolean>;
  list(orgId: string, episodeId: string): Promise<StoredVerdict[]>;
}

export class PostgresVerdictStore implements VerdictStore {
  readonly #db: Kysely<ClinicalDatabase>;

  constructor(db: Kysely<ClinicalDatabase>) {
    this.#db = db;
  }

  async due(today: string, rulesetVersion: string) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(today)) throw new TypeError('today must be YYYY-MM-DD');
    // The set-returning lookup function (migration 0010), through the typed builder: ids only.
    const rows = await this.#db
      .selectFrom((eb) =>
        eb
          .fn<{ episode_id: string; org_id: string }>('verdict_due_episodes', [
            eb.cast(eb.val(today), 'date'),
            eb.val(rulesetVersion),
          ])
          .as('d'),
      )
      .select(['d.episode_id', 'd.org_id'])
      .execute();
    return rows.map((r) => ({ episodeId: r.episode_id, orgId: r.org_id }));
  }

  evidence(orgId: string, episodeId: string): Promise<EpisodeEvidence | null> {
    return withOrg(this.#db, orgId, async (trx) => {
      const e = await trx
        .selectFrom('treatment_episode')
        .select([
          'id',
          'org_id',
          'patient_id',
          'status',
          'review_interval_weeks',
          'adherence_mode',
          'instrument_version',
          'time_zone',
        ])
        .select(sql<string>`start_date::text`.as('start_date'))
        .select(sql<string>`review_date::text`.as('review_date'))
        .where('id', '=', episodeId)
        .executeTakeFirst();
      if (!e) return null;
      const checkIns = await trx
        .selectFrom('check_in')
        .select(['week_index', 'answers'])
        .where('episode_id', '=', episodeId)
        .orderBy('week_index')
        .execute();
      const flags = await trx
        .selectFrom('red_flag_event')
        .select((eb) => eb.fn.countAll<string>().as('n'))
        .where('episode_id', '=', episodeId)
        .executeTakeFirstOrThrow();
      return {
        episodeId: e.id,
        orgId: e.org_id,
        patientId: e.patient_id,
        status: e.status,
        startDate: e.start_date,
        reviewDate: e.review_date,
        reviewIntervalWeeks: e.review_interval_weeks,
        adherenceMode: e.adherence_mode,
        instrumentVersion: e.instrument_version,
        timeZone: e.time_zone,
        checkIns: checkIns.map((c) => ({ weekIndex: c.week_index, answers: c.answers })),
        redFlagEvents: Number(flags.n),
      };
    });
  }

  async record(v: NewVerdict): Promise<boolean> {
    try {
      await withOrg(this.#db, v.orgId, async (trx) => {
        const r = v.result;
        await trx
          .insertInto('verdict')
          .values({
            id: v.id,
            org_id: v.orgId,
            patient_id: v.patientId,
            episode_id: v.episodeId,
            outcome: r.outcome,
            reason: r.outcome === 'not_generated' ? r.reason : null,
            verdict_code: r.outcome === 'generated' ? r.code : null,
            secondary_code: r.outcome === 'generated' ? r.secondary : null,
            modifiers: r.outcome === 'generated' ? [...r.modifiers] : [],
            ruleset_version: v.rulesetVersion,
            ruleset_digest: v.rulesetDigest,
            instrument_version: v.instrumentVersion,
            input_hash: r.outcome === 'generated' ? r.inputHash : null,
            explanation: r.outcome === 'generated' ? JSON.stringify(r.explanation) : null,
            generated_by: v.generatedBy,
            requested_by: v.requestedBy,
          })
          .execute();
        await trx
          .insertInto('audit_outbox')
          .values({ id: v.auditEvent.id, event: JSON.stringify(v.auditEvent) })
          .execute();
      });
      return true;
    } catch (error) {
      const e = error as { code?: string; constraint?: string };
      if (e.code === '23505' && e.constraint === 'verdict_scheduled_once') return false;
      throw error;
    }
  }

  list(orgId: string, episodeId: string): Promise<StoredVerdict[]> {
    return withOrg(this.#db, orgId, async (trx) => {
      const rows = await trx
        .selectFrom('verdict')
        .select([
          'id',
          'outcome',
          'reason',
          'verdict_code',
          'secondary_code',
          'modifiers',
          'ruleset_version',
          'input_hash',
          'explanation',
          'generated_by',
          'generated_at',
          'shadow',
        ])
        .where('episode_id', '=', episodeId)
        .orderBy('generated_at', 'desc')
        .limit(50)
        .execute();
      return rows.map((r) => ({
        id: r.id,
        outcome: r.outcome,
        reason: r.reason,
        code: r.verdict_code,
        secondary: r.secondary_code,
        modifiers: r.modifiers,
        rulesetVersion: r.ruleset_version,
        inputHash: r.input_hash,
        explanation: r.explanation,
        generatedBy: r.generated_by,
        generatedAt: r.generated_at,
        shadow: r.shadow,
      }));
    });
  }
}

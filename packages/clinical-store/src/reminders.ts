import { sql, type Kysely } from 'kysely';
import { withOrg } from './org-scope.ts';
import type { ClinicalDatabase } from './schema.ts';

/** Her push subscription, endpoint still encrypted (spec 15). */
export interface Subscription {
  readonly id: string;
  readonly patientId: string;
  readonly endpointEncrypted: string;
  readonly remindHour: number;
  readonly timeZone: string;
}

/** An episode a reminder may be for: her open weeks are worked out from these. */
export interface ReminderEpisode {
  readonly episodeId: string;
  readonly patientId: string;
  readonly startDate: string;
  readonly reviewIntervalWeeks: number;
  readonly timeZone: string | null;
  readonly doneWeeks: readonly number[];
  readonly remindedWeeks: readonly number[];
}

export interface ReminderStore {
  /** Adds or updates this device (same endpoint hash) for her. */
  subscribe(s: {
    readonly id: string;
    readonly orgId: string;
    readonly patientId: string;
    readonly endpointEncrypted: string;
    readonly endpointHash: string;
    readonly remindHour: number;
    readonly timeZone: string;
  }): Promise<void>;
  /** Removes her subscriptions: one device by its endpoint hash, or all of them. */
  unsubscribe(orgId: string, patientId: string, endpointHash: string | null): Promise<number>;
  /** Removes one subscription the push service said is gone (404 or 410). */
  remove(orgId: string, id: string): Promise<void>;
  /** Organisations with any subscription (cross-organisation lookup, ids only). */
  orgs(): Promise<string[]>;
  subscriptions(orgId: string): Promise<Subscription[]>;
  /** Her active episodes, with the weeks done and the weeks already reminded. */
  episodes(orgId: string, patientId: string): Promise<ReminderEpisode[]>;
  /** Claims the reminder for this week before sending: false if already claimed. */
  claim(orgId: string, patientId: string, episodeId: string, week: number): Promise<boolean>;
}

export class PostgresReminderStore implements ReminderStore {
  readonly #db: Kysely<ClinicalDatabase>;

  constructor(db: Kysely<ClinicalDatabase>) {
    this.#db = db;
  }

  subscribe(s: Parameters<ReminderStore['subscribe']>[0]): Promise<void> {
    return withOrg(this.#db, s.orgId, async (trx) => {
      await trx
        .insertInto('push_subscription')
        .values({
          id: s.id,
          org_id: s.orgId,
          patient_id: s.patientId,
          endpoint_encrypted: s.endpointEncrypted,
          endpoint_hash: s.endpointHash,
          remind_hour: s.remindHour,
          time_zone: s.timeZone,
        })
        .onConflict((oc) =>
          oc
            .columns(['patient_id', 'endpoint_hash'])
            .doUpdateSet({ remind_hour: s.remindHour, time_zone: s.timeZone }),
        )
        .execute();
    });
  }

  unsubscribe(orgId: string, patientId: string, endpointHash: string | null): Promise<number> {
    return withOrg(this.#db, orgId, async (trx) => {
      let q = trx.deleteFrom('push_subscription').where('patient_id', '=', patientId);
      if (endpointHash !== null) q = q.where('endpoint_hash', '=', endpointHash);
      const r = await q.executeTakeFirst();
      return Number(r.numDeletedRows);
    });
  }

  remove(orgId: string, id: string): Promise<void> {
    return withOrg(this.#db, orgId, async (trx) => {
      await trx.deleteFrom('push_subscription').where('id', '=', id).execute();
    });
  }

  async orgs(): Promise<string[]> {
    const rows = await this.#db
      .selectFrom((eb) => eb.fn<{ org_id: string }>('reminder_orgs', []).as('o'))
      .select('o.org_id')
      .execute();
    return rows.map((r) => r.org_id);
  }

  subscriptions(orgId: string): Promise<Subscription[]> {
    return withOrg(this.#db, orgId, async (trx) => {
      const rows = await trx
        .selectFrom('push_subscription')
        .select(['id', 'patient_id', 'endpoint_encrypted', 'remind_hour', 'time_zone'])
        .orderBy('created_at')
        .limit(10_000)
        .execute();
      return rows.map((r) => ({
        id: r.id,
        patientId: r.patient_id,
        endpointEncrypted: r.endpoint_encrypted,
        remindHour: r.remind_hour,
        timeZone: r.time_zone,
      }));
    });
  }

  episodes(orgId: string, patientId: string): Promise<ReminderEpisode[]> {
    return withOrg(this.#db, orgId, async (trx) => {
      const eps = await trx
        .selectFrom('treatment_episode')
        .select(['id', 'patient_id', 'review_interval_weeks', 'time_zone'])
        .select(sql<string>`start_date::text`.as('start_date'))
        .where('patient_id', '=', patientId)
        .where('status', 'in', ['active', 'in_review'])
        .execute();
      const out: ReminderEpisode[] = [];
      for (const e of eps) {
        const done = await trx
          .selectFrom('check_in')
          .select('week_index')
          .where('episode_id', '=', e.id)
          .execute();
        const reminded = await trx
          .selectFrom('reminder_sent')
          .select('week_index')
          .where('episode_id', '=', e.id)
          .execute();
        out.push({
          episodeId: e.id,
          patientId: e.patient_id,
          startDate: e.start_date,
          reviewIntervalWeeks: e.review_interval_weeks,
          timeZone: e.time_zone,
          doneWeeks: done.map((d) => d.week_index),
          remindedWeeks: reminded.map((d) => d.week_index),
        });
      }
      return out;
    });
  }

  claim(orgId: string, patientId: string, episodeId: string, week: number): Promise<boolean> {
    return withOrg(this.#db, orgId, async (trx) => {
      const r = await trx
        .insertInto('reminder_sent')
        .values({ episode_id: episodeId, week_index: week, org_id: orgId, patient_id: patientId })
        .onConflict((oc) => oc.columns(['episode_id', 'week_index']).doNothing())
        .executeTakeFirst();
      return Number(r.numInsertedOrUpdatedRows ?? 0) > 0;
    });
  }
}

import { sql, type Kysely } from 'kysely';
import { withOrg } from './org-scope.ts';
import type { ClinicalDatabase } from './schema.ts';

/** Raw monthly counts for the aggregate dashboard; the API suppresses small cells (REQ-011). */
export interface MonthlyCounts {
  /** First day of the month, YYYY-MM-01 (UTC). */
  readonly month: string;
  readonly episodesStarted: number;
  readonly reviewsDue: number;
  /** Decided within the grace days after the review date (Section 24 item 40). */
  readonly reviewsOnTime: number;
}

export interface ReportingStore {
  /**
   * The last `months` completed calendar months before the month of `today`, counting each event
   * only if her `org_aggregate_reporting` decision was granted at that time (spec 13.1). Counts
   * only; no ids leave.
   */
  monthly(
    orgId: string,
    today: string,
    months: number,
    graceDays: number,
  ): Promise<MonthlyCounts[]>;
}

const monthOf = (d: string) => `${d.slice(0, 7)}-01`;

/** Groups raw rows into the last `months` calendar months (pure; REQ-011). */
export function bucketCounts(
  started: readonly (Date | null)[],
  due: readonly { review_date: string; decided_at: Date | null }[],
  today: string,
  months: number,
  graceDays: number,
): MonthlyCounts[] {
  const buckets = new Map<string, { started: number; due: number; onTime: number }>();
  // The `months` completed months before the month of `today`.
  for (let n = months; n >= 1; n -= 1)
    buckets.set(monthsBack(today, n), { started: 0, due: 0, onTime: 0 });
  for (const at of started) {
    const b = at ? buckets.get(monthOf(at.toISOString())) : undefined;
    if (b) b.started += 1;
  }
  for (const r of due) {
    const review = r.review_date.slice(0, 10);
    const b = buckets.get(monthOf(review));
    if (!b) continue;
    b.due += 1;
    const limit = Date.parse(`${review}T00:00:00Z`) + (graceDays + 1) * 86_400_000;
    if (r.decided_at && r.decided_at.getTime() < limit) b.onTime += 1;
  }
  return [...buckets].map(([month, b]) => ({
    month,
    episodesStarted: b.started,
    reviewsDue: b.due,
    reviewsOnTime: b.onTime,
  }));
}

/** YYYY-MM-01 for the `n`th month before the month of `today`. */
export function monthsBack(today: string, n: number): string {
  const [y, m] = [Number(today.slice(0, 4)), Number(today.slice(5, 7))];
  const total = y * 12 + (m - 1) - n;
  return `${String(Math.floor(total / 12))}-${String((total % 12) + 1).padStart(2, '0')}-01`;
}

export class PostgresReportingStore implements ReportingStore {
  readonly #db: Kysely<ClinicalDatabase>;

  constructor(db: Kysely<ClinicalDatabase>) {
    this.#db = db;
  }

  monthly(orgId: string, today: string, months: number, graceDays: number) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(today))
      return Promise.reject(new TypeError('today must be YYYY-MM-DD'));
    // Completed months only: the current month would move with every new treatment (REQ-011).
    const from = monthsBack(today, months);
    const until = monthsBack(today, 0);
    return withOrg(this.#db, orgId, async (trx) => {
      const started = await trx
        .selectFrom('treatment_episode as e')
        .select('e.confirmed_at')
        .where('e.confirmed_at', 'is not', null)
        .where('e.confirmed_at', '>=', new Date(`${from}T00:00:00Z`))
        .where('e.confirmed_at', '<', new Date(`${until}T00:00:00Z`))
        // Her org_aggregate_reporting decision as it stood when the treatment started: a later
        // withdrawal or grant never changes a published month (spec 13.1).
        .where(
          (eb) =>
            eb
              .selectFrom('consent as c')
              .select('c.status')
              .whereRef('c.patient_id', '=', 'e.patient_id')
              .where('c.purpose', '=', 'org_aggregate_reporting')
              .whereRef('c.decided_at', '<=', 'e.confirmed_at')
              .orderBy('c.seq', 'desc')
              .limit(1),
          '=',
          'granted',
        )
        .execute();
      const due = await trx
        .selectFrom('treatment_episode as e')
        .leftJoin('review_decision as d', 'd.episode_id', 'e.id')
        .select(['d.decided_at'])
        .select(sql<string>`e.review_date::text`.as('review_date'))
        .where('e.confirmed_at', 'is not', null)
        .where('e.review_date', '>=', from)
        .where('e.review_date', '<', until)
        // Her decision as it stood at the start of the review day.
        .where(
          (eb) =>
            eb
              .selectFrom('consent as c')
              .select('c.status')
              .whereRef('c.patient_id', '=', 'e.patient_id')
              .where('c.purpose', '=', 'org_aggregate_reporting')
              .whereRef('c.decided_at', '<=', 'e.review_date')
              .orderBy('c.seq', 'desc')
              .limit(1),
          '=',
          'granted',
        )
        .execute();
      return bucketCounts(
        started.map((r) => r.confirmed_at),
        due,
        today,
        months,
        graceDays,
      );
    });
  }
}

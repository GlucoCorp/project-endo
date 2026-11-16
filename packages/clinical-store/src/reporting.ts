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
   * The last `months` calendar months up to `today`, for patients whose current
   * `org_aggregate_reporting` consent is granted (spec 13.1). Counts only; no ids leave.
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
  for (let n = months - 1; n >= 0; n -= 1)
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
    const from = monthsBack(today, months - 1);
    return withOrg(this.#db, orgId, async (trx) => {
      const consented = trx
        .selectFrom('consent_current')
        .select('patient_id')
        .where('purpose', '=', 'org_aggregate_reporting')
        .where('status', '=', 'granted');
      const started = await trx
        .selectFrom('treatment_episode')
        .select('confirmed_at')
        .where('confirmed_at', 'is not', null)
        .where('confirmed_at', '>=', new Date(`${from}T00:00:00Z`))
        .where('patient_id', 'in', consented)
        .execute();
      const due = await trx
        .selectFrom('treatment_episode as e')
        .leftJoin('review_decision as d', 'd.episode_id', 'e.id')
        .select(['d.decided_at'])
        .select(sql<string>`e.review_date::text`.as('review_date'))
        .where('e.confirmed_at', 'is not', null)
        .where('e.review_date', '>=', from)
        .where('e.review_date', '<=', today)
        .where('e.patient_id', 'in', consented)
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

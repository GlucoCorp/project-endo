import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { MonthlyCounts, ReportingStore } from '@endo/clinical-store';
import { ProblemError } from '@endo/service-kit';

/**
 * The aggregate organisation dashboard (M5: REQ-011; spec 9.2 `GET /v1/orgs/{id}/dashboard`).
 * De-identified counts only, from patients who granted `org_aggregate_reporting`. Any count
 * under MIN_CELL is suppressed (null), with the complementary suppression in `suppress()`.
 * Verdict figures stay unavailable while verdicts run in shadow mode (ADR-0028).
 */
export interface DashboardRouteDeps {
  readonly reporting: ReportingStore;
  readonly now: () => Date;
}

export const MIN_CELL = 10;
/** "On time": decided by the review date plus this many days (Section 24 item 40). */
export const ON_TIME_GRACE_DAYS = 7;
const MONTHS = 12;
const UUID = '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';

const cell = (n: number) => (n < MIN_CELL ? null : n);

/**
 * Suppresses small cells (REQ-011), and the cells that would reveal one by subtraction: on-time
 * reviews when the late ones (due minus on time) are a small non-zero number, and a series total
 * when any of its months is suppressed (or when its own late count would be small).
 */
export function suppress(rows: readonly MonthlyCounts[]) {
  const months = rows.map((r) => {
    const due = cell(r.reviewsDue);
    const late = r.reviewsDue - r.reviewsOnTime;
    return {
      month: r.month,
      episodes_started: cell(r.episodesStarted),
      reviews_due: due,
      reviews_on_time: due === null || (late > 0 && late < MIN_CELL) ? null : cell(r.reviewsOnTime),
    };
  });
  const total = (pick: (r: MonthlyCounts) => number, shown: (number | null)[]) => {
    const hidden = shown.filter((v) => v === null).length;
    const sum = rows.reduce((a, r) => a + pick(r), 0);
    // Any hidden month hides its total: otherwise totals minus the shown months reveal it.
    return hidden > 0 ? null : cell(sum);
  };
  return {
    months,
    totals: {
      episodes_started: total(
        (r) => r.episodesStarted,
        months.map((m) => m.episodes_started),
      ),
      reviews_due: total(
        (r) => r.reviewsDue,
        months.map((m) => m.reviews_due),
      ),
      reviews_on_time: (() => {
        const due = rows.reduce((x, r) => x + r.reviewsDue, 0);
        const late = due - rows.reduce((x, r) => x + r.reviewsOnTime, 0);
        return late > 0 && late < MIN_CELL
          ? null
          : total(
              (r) => r.reviewsOnTime,
              months.map((m) => m.reviews_on_time),
            );
      })(),
    },
  };
}

export function registerDashboardRoutes(app: FastifyInstance, deps: DashboardRouteDeps): void {
  // The policy runs before schema validation: only a well-formed id reaches the audit trail.
  const orgOf = (r: FastifyRequest) => {
    const id = (r.params as { id?: string }).id ?? '';
    return new RegExp(UUID).test(id) ? id : null;
  };
  app.get(
    '/v1/orgs/:id/dashboard',
    {
      config: {
        policy: {
          kind: 'protected',
          action: 'org.dashboard.read',
          resourceType: 'organization',
          purpose: 'operations',
          resource: (r) => ({
            type: 'organization',
            id: orgOf(r),
            orgId: orgOf(r),
            patientId: null,
          }),
        },
      },
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
      const orgId = orgOf(request);
      if (!orgId || request.subject?.orgId !== orgId)
        throw new ProblemError(403, 'authz.org_mismatch', 'Not allowed.');
      const today = deps.now().toISOString().slice(0, 10);
      const rows = await deps.reporting.monthly(orgId, today, MONTHS, ON_TIME_GRACE_DAYS);
      return reply.header('cache-control', 'no-store').send({
        basis: 'org_aggregate_reporting',
        min_cell: MIN_CELL,
        on_time_grace_days: ON_TIME_GRACE_DAYS,
        ...suppress(rows),
        verdict_distribution: { status: 'unavailable_shadow_mode' },
        median_weeks_on_ineffective_treatment: { status: 'unavailable_shadow_mode' },
      });
    },
  );
}

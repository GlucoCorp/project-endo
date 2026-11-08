import type { Kysely, Transaction } from 'kysely';
import type { ClinicalDatabase } from './schema.ts';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * Runs `fn` in a transaction scoped to one organisation (spec 10.4). Row-level security uses
 * `app.org_id`, set with `set_config(..., true)` so it ends with the transaction and can never
 * leak to the next request on a pooled connection.
 */
export async function withOrg<T>(
  db: Kysely<ClinicalDatabase>,
  orgId: string,
  fn: (trx: Transaction<ClinicalDatabase>) => Promise<T>,
): Promise<T> {
  if (!UUID.test(orgId)) throw new TypeError('orgId must be a lowercase UUID');
  return db.transaction().execute(async (trx) => {
    await trx
      .selectNoFrom((eb) =>
        eb.fn('set_config', [eb.val('app.org_id'), eb.val(orgId), eb.lit(true)]).as('set'),
      )
      .execute();
    return fn(trx);
  });
}

/**
 * Finds a live enrolment invitation (unclaimed, unexpired, not revoked) by the SHA-256 of its
 * link token, across organisations. Returns null when there is none. The caller must then claim
 * it with `withOrg` and a conditional update, so concurrent claims cannot both succeed.
 */
export async function findLiveInvitation(
  db: Kysely<ClinicalDatabase>,
  tokenHash: string,
): Promise<{ invitationId: string; orgId: string } | null> {
  if (!/^[0-9a-f]{64}$/.test(tokenHash)) throw new TypeError('tokenHash must be SHA-256 hex');
  const row = await db
    .selectNoFrom((eb) =>
      eb
        .fn<{ invitation_id: string; org_id: string } | null>('enrolment_find_live', [
          eb.val(tokenHash),
        ])
        .as('found'),
    )
    .executeTakeFirstOrThrow();
  return row.found ? { invitationId: row.found.invitation_id, orgId: row.found.org_id } : null;
}

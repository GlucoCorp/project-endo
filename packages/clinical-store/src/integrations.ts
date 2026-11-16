import type { Kysely } from 'kysely';
import { isActiveAdmin, lockOrgMembership } from './org-admin.ts';
import { withOrg } from './org-scope.ts';
import type { ClinicalDatabase } from './schema.ts';

type Audit = Readonly<Record<string, unknown>> & { readonly id: string };

export interface IntegrationClient {
  readonly id: string;
  readonly clientId: string;
  readonly name: string;
  readonly scopes: readonly string[];
  readonly active: boolean;
  readonly createdAt: Date;
}

/** What the integration service needs to authenticate a client (spec 16.3). */
export interface ResolvedClient {
  readonly id: string;
  readonly orgId: string;
  readonly jwks: { readonly keys: readonly Record<string, unknown>[] };
  readonly scopes: readonly string[];
  readonly active: boolean;
}

/** Record-system clients of an organisation (M7, RISK-E02). */
export interface IntegrationStore {
  create(c: {
    readonly id: string;
    readonly orgId: string;
    readonly clientId: string;
    readonly name: string;
    readonly jwks: { readonly keys: readonly Record<string, unknown>[] };
    readonly scopes: readonly string[];
    readonly createdBy: string;
    readonly auditEvent: Audit;
  }): Promise<IntegrationClient | 'not_admin'>;
  list(orgId: string): Promise<IntegrationClient[]>;
  /** The kill switch: false if it is not this organisation's or the actor is no longer admin. */
  setActive(c: {
    readonly orgId: string;
    readonly id: string;
    readonly active: boolean;
    readonly actorId: string;
    readonly auditEvent: Audit;
  }): Promise<boolean>;
  /** Cross-organisation, by client_id: for the integration service only. */
  resolve(clientId: string): Promise<ResolvedClient | null>;
}

const COLUMNS = ['id', 'client_id', 'name', 'scopes', 'active', 'created_at'] as const;
const toClient = (r: {
  id: string;
  client_id: string;
  name: string;
  scopes: string[];
  active: boolean;
  created_at: Date;
}): IntegrationClient => ({
  id: r.id,
  clientId: r.client_id,
  name: r.name,
  scopes: r.scopes,
  active: r.active,
  createdAt: r.created_at,
});

export class PostgresIntegrationStore implements IntegrationStore {
  readonly #db: Kysely<ClinicalDatabase>;

  constructor(db: Kysely<ClinicalDatabase>) {
    this.#db = db;
  }

  create(c: Parameters<IntegrationStore['create']>[0]) {
    return withOrg(this.#db, c.orgId, async (trx) => {
      await lockOrgMembership(trx, c.orgId);
      if (!(await isActiveAdmin(trx, c.createdBy))) return 'not_admin' as const;
      const row = await trx
        .insertInto('integration_client')
        .values({
          id: c.id,
          org_id: c.orgId,
          client_id: c.clientId,
          name: c.name,
          jwks: JSON.stringify(c.jwks),
          scopes: [...c.scopes],
          created_by: c.createdBy,
        })
        .returning(COLUMNS)
        .executeTakeFirstOrThrow();
      await trx
        .insertInto('audit_outbox')
        .values({ id: c.auditEvent.id, event: JSON.stringify(c.auditEvent) })
        .execute();
      return toClient(row);
    });
  }

  list(orgId: string) {
    return withOrg(this.#db, orgId, async (trx) =>
      (
        await trx.selectFrom('integration_client').select(COLUMNS).orderBy('created_at').execute()
      ).map(toClient),
    );
  }

  setActive(c: Parameters<IntegrationStore['setActive']>[0]) {
    return withOrg(this.#db, c.orgId, async (trx) => {
      await lockOrgMembership(trx, c.orgId);
      if (!(await isActiveAdmin(trx, c.actorId))) return false;
      const r = await trx
        .updateTable('integration_client')
        .set({ active: c.active })
        .where('id', '=', c.id)
        .executeTakeFirst();
      if (Number(r.numUpdatedRows) === 0) return false;
      await trx
        .insertInto('audit_outbox')
        .values({ id: c.auditEvent.id, event: JSON.stringify(c.auditEvent) })
        .execute();
      return true;
    });
  }

  async resolve(clientId: string): Promise<ResolvedClient | null> {
    const r = await this.#db
      .selectNoFrom((eb) =>
        eb
          .fn<{
            id: string;
            org_id: string;
            jwks: ResolvedClient['jwks'];
            scopes: string[];
            active: boolean;
          } | null>('integration_client_find', [eb.val(clientId)])
          .as('c'),
      )
      .executeTakeFirstOrThrow();
    return r.c
      ? { id: r.c.id, orgId: r.c.org_id, jwks: r.c.jwks, scopes: r.c.scopes, active: r.c.active }
      : null;
  }
}

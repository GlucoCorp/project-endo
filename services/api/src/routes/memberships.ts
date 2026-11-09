import type { FastifyInstance } from 'fastify';
import type { MembershipStore } from '@endo/clinical-store';

export interface MembershipRouteDeps {
  readonly memberships: MembershipStore;
}

const UUID = '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$';

/**
 * POST /internal/v1/memberships/resolve (ADR-0019 section 4). The clinic BFF, holding workload
 * scope `api.membership.resolve`, learns a signed-in person's ACTIVE memberships before an
 * organisation is chosen. Returns organisation and role only. Never reachable from a browser.
 */
export function registerMembershipRoutes(app: FastifyInstance, deps: MembershipRouteDeps): void {
  app.post(
    '/internal/v1/memberships/resolve',
    {
      config: {
        policy: {
          kind: 'workload',
          scope: 'api.membership.resolve',
          action: 'api.membership.resolve',
          resourceType: 'clinician_membership',
        },
      },
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['identity_ref'],
          properties: { identity_ref: { type: 'string', pattern: UUID } },
        },
        response: {
          200: {
            type: 'object',
            additionalProperties: false,
            required: ['memberships'],
            properties: {
              memberships: {
                type: 'array',
                items: {
                  type: 'object',
                  additionalProperties: false,
                  required: ['org_id', 'role'],
                  properties: {
                    org_id: { type: 'string' },
                    role: { type: 'string', enum: ['clinician', 'org_admin'] },
                  },
                },
              },
            },
          },
        },
      },
    },
    async (request) => {
      const { identity_ref } = request.body as { identity_ref: string };
      const active = await deps.memberships.listActive(identity_ref);
      return { memberships: active.map((m) => ({ org_id: m.orgId, role: m.role })) };
    },
  );
}

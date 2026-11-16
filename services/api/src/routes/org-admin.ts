import { createHash, randomBytes } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { AuditEventInput } from '@endo/audit';
import type {
  OrgAdminStore,
  OrgSettings,
  StaffInvitation,
  StaffInvitationStore,
} from '@endo/clinical-store';
import { uuidv7 } from '@endo/domain';
import { ProblemError } from '@endo/service-kit';

/**
 * Organisation admin (M5: REQ-010; spec 3.2, 21.8). The organisation's own org_admin only, in
 * its own organisation (the policy checks role, membership and organisation before any handler).
 *
 * - Settings: the review interval default (used when a treatment is drafted without one),
 *   languages offered, and the local emergency number for her urgent-care screen.
 * - Members: deactivate, reactivate, change role. Nobody changes their own membership here, and
 *   the database keeps every organisation with an active admin.
 */
export interface OrgAdminRouteDeps {
  readonly orgAdmin: OrgAdminStore;
  /** Staff invitations; the claim is a workload route for the clinic BFF (`api.staff.join`). */
  readonly staffInvitations?: StaffInvitationStore;
  readonly onCommitted: () => void;
}

const UUID = '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';

const settingsBody = (s: OrgSettings) => ({
  default_review_interval_weeks: s.defaultReviewIntervalWeeks,
  languages: s.languages,
  emergency_number: s.emergencyNumber,
  updated_at: s.updatedAt?.toISOString() ?? null,
});

export function registerOrgAdminRoutes(app: FastifyInstance, deps: OrgAdminRouteDeps): void {
  const policy = (action: 'org.settings.manage' | 'org.clinicians.manage', type: string) => ({
    kind: 'protected' as const,
    action,
    resourceType: type,
    purpose: 'operations' as const,
    resource: (_r: FastifyRequest, s: { orgId: string | null }) => ({
      type,
      id: s.orgId,
      orgId: s.orgId,
      patientId: null,
    }),
  });
  const org = (r: FastifyRequest) => {
    const orgId = r.subject?.orgId;
    const clinicianId = r.clinicianId;
    if (!orgId || !clinicianId) throw new ProblemError(403, 'authz.org_mismatch', 'Not allowed.');
    return { orgId, clinicianId };
  };
  const audit = (r: FastifyRequest, action: string, type: string, id: string, orgId: string) => ({
    id: uuidv7(),
    ...AuditEventInput.parse({
      actor: { id: r.subject?.id ?? null, role: r.subject?.role ?? 'org_admin' },
      action,
      resource: { type, id },
      org_id: orgId,
      purpose_of_use: 'operations',
      outcome: 'success',
      reason: null,
      request_id: r.id,
    }),
  });

  app.get(
    '/v1/org/settings',
    { config: { policy: policy('org.settings.manage', 'organization') } },
    async (request) => settingsBody(await deps.orgAdmin.settings(org(request).orgId)),
  );

  app.post(
    '/v1/org/settings',
    {
      config: { policy: policy('org.settings.manage', 'organization') },
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['default_review_interval_weeks', 'languages', 'emergency_number'],
          properties: {
            default_review_interval_weeks: {
              anyOf: [{ type: 'integer', minimum: 4, maximum: 26 }, { type: 'null' }],
            },
            languages: {
              type: 'array',
              minItems: 1,
              maxItems: 20,
              uniqueItems: true,
              items: { type: 'string', pattern: '^[a-z]{2}(-[A-Z]{2})?$' },
            },
            emergency_number: {
              anyOf: [{ type: 'string', pattern: '^[0-9]{2,15}$' }, { type: 'null' }],
            },
          },
        },
      },
    },
    async (request) => {
      const { orgId, clinicianId } = org(request);
      const b = request.body as {
        default_review_interval_weeks: number | null;
        languages: string[];
        emergency_number: string | null;
      };
      const saved = await deps.orgAdmin.saveSettings({
        orgId,
        clinicianId,
        defaultReviewIntervalWeeks: b.default_review_interval_weeks,
        languages: b.languages,
        emergencyNumber: b.emergency_number,
        auditEvent: audit(request, 'org.settings.updated', 'organization', orgId, orgId),
      });
      deps.onCommitted();
      return settingsBody(saved);
    },
  );

  /** What her app needs from her clinic's settings: the emergency number and languages. */
  app.get(
    '/v1/me/clinic-settings',
    {
      config: {
        policy: {
          kind: 'protected',
          action: 'episode.read_own',
          resourceType: 'organization',
          purpose: 'patient_request',
          resource: (_r, s) => ({
            type: 'organization',
            id: s.orgId,
            orgId: s.orgId,
            patientId: s.patientId,
          }),
        },
      },
    },
    async (request) => {
      const orgId = request.subject?.orgId;
      if (!orgId || !request.subject?.patientId)
        throw new ProblemError(403, 'authz.not_own_resource', 'Not allowed.');
      const s = await deps.orgAdmin.settings(orgId);
      return { emergency_number: s.emergencyNumber, languages: s.languages };
    },
  );

  app.get(
    '/v1/org/clinicians',
    { config: { policy: policy('org.clinicians.manage', 'clinician') } },
    async (request) => {
      const { orgId, clinicianId } = org(request);
      return {
        clinicians: (await deps.orgAdmin.members(orgId)).map((m) => ({
          clinician_id: m.clinicianId,
          role: m.role,
          active: m.active,
          since: m.createdAt.toISOString().slice(0, 10),
          you: m.clinicianId === clinicianId,
        })),
      };
    },
  );

  app.post(
    '/v1/org/clinicians/:id',
    {
      config: { policy: policy('org.clinicians.manage', 'clinician') },
      schema: {
        params: {
          type: 'object',
          additionalProperties: false,
          required: ['id'],
          properties: { id: { type: 'string', pattern: UUID } },
        },
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['role', 'active'],
          properties: {
            role: { type: 'string', enum: ['clinician', 'org_admin'] },
            active: { type: 'boolean' },
          },
        },
      },
    },
    async (request) => {
      const { orgId, clinicianId } = org(request);
      const { id } = request.params as { id: string };
      const b = request.body as { role: 'clinician' | 'org_admin'; active: boolean };
      if (id === clinicianId)
        throw new ProblemError(409, 'org.own_membership', 'Ask another admin to change yours.');
      const r = await deps.orgAdmin.changeMember({
        orgId,
        actorId: clinicianId,
        clinicianId: id,
        role: b.role,
        active: b.active,
        auditEvent: audit(request, 'org.clinician.changed', 'clinician', id, orgId),
      });
      if (r === 'not_found') throw new ProblemError(404, 'clinician.not_found', 'Not found.');
      if (r === 'not_admin')
        throw new ProblemError(403, 'authz.role_not_permitted', 'Not allowed.');
      if (r === 'last_admin')
        throw new ProblemError(409, 'org.last_admin', 'The organisation needs an active admin.');
      if (r === 'changed') deps.onCommitted();
      return { clinician_id: id, role: b.role, active: b.active };
    },
  );

  const invitations = deps.staffInvitations;
  if (!invitations) return;
  const invitationBody = (i: StaffInvitation) => ({
    id: i.id,
    role: i.role,
    created_at: i.createdAt.toISOString(),
    expires_at: i.expiresAt.toISOString(),
    status: i.claimedAt
      ? 'accepted'
      : i.revokedAt
        ? 'stopped'
        : i.expiresAt.getTime() <= Date.now()
          ? 'expired'
          : 'open',
  });

  /** REQ-010: invite a colleague. The token is returned once; only its SHA-256 is stored. */
  app.post(
    '/v1/org/staff-invitations',
    {
      config: { policy: policy('org.clinicians.manage', 'staff_invitation') },
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['role'],
          properties: {
            role: { type: 'string', enum: ['clinician', 'org_admin'] },
            days: { type: 'integer', minimum: 1, maximum: 7 },
          },
        },
      },
    },
    async (request, reply) => {
      const { orgId, clinicianId } = org(request);
      const b = request.body as { role: 'clinician' | 'org_admin'; days?: number };
      const token = randomBytes(32).toString('base64url');
      const id = uuidv7();
      const i = await invitations.create({
        id,
        orgId,
        role: b.role,
        tokenHash: createHash('sha256').update(token).digest('hex'),
        createdBy: clinicianId,
        days: b.days ?? 7,
        auditEvent: audit(request, 'staff_invitation.created', 'staff_invitation', id, orgId),
      });
      deps.onCommitted();
      return reply
        .code(201)
        .header('cache-control', 'no-store')
        .send({ ...invitationBody(i), token });
    },
  );

  app.get(
    '/v1/org/staff-invitations',
    { config: { policy: policy('org.clinicians.manage', 'staff_invitation') } },
    async (request) => ({
      invitations: (await invitations.list(org(request).orgId)).map(invitationBody),
    }),
  );

  app.post(
    '/v1/org/staff-invitations/:id/revoke',
    {
      config: { policy: policy('org.clinicians.manage', 'staff_invitation') },
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
      const { orgId } = org(request);
      const { id } = request.params as { id: string };
      const ok = await invitations.revoke(
        orgId,
        id,
        audit(request, 'staff_invitation.revoked', 'staff_invitation', id, orgId),
      );
      if (!ok) throw new ProblemError(404, 'staff_invitation.not_open', 'Not found.');
      deps.onCommitted();
      return reply.code(204).send();
    },
  );

  /**
   * The clinic BFF, after a staff sign-in that resolved to `person_id`, claims the invitation the
   * browser brought (as a hash). One answer for every link that cannot be used.
   */
  app.post(
    '/internal/v1/staff-invitations/claim',
    {
      config: {
        policy: {
          kind: 'workload',
          scope: 'api.staff.join',
          action: 'staff_invitation.claim',
          resourceType: 'staff_invitation',
        },
      },
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['token_hash', 'person_id'],
          properties: {
            token_hash: { type: 'string', pattern: '^[0-9a-f]{64}$' },
            person_id: { type: 'string', pattern: UUID },
          },
        },
      },
    },
    async (request) => {
      const b = request.body as { token_hash: string; person_id: string };
      const r = await invitations.claim({
        tokenHash: b.token_hash,
        identityRef: b.person_id,
        clinicianId: uuidv7(),
        auditEvent: {
          id: uuidv7(),
          ...AuditEventInput.parse({
            actor: { id: b.person_id, role: 'clinician' },
            action: 'staff_invitation.claimed',
            // The database fills in the organisation and the invitation.
            resource: { type: 'staff_invitation', id: null },
            org_id: null,
            purpose_of_use: 'operations',
            outcome: 'success',
            reason: null,
            request_id: request.id,
          }),
        },
      });
      if (r.outcome !== 'claimed')
        throw r.outcome === 'already_member'
          ? new ProblemError(409, 'staff_invitation.already_member', 'Already a member.')
          : new ProblemError(404, 'staff_invitation.unavailable', 'This link cannot be used.');
      deps.onCommitted();
      return { org_id: r.orgId, role: r.role };
    },
  );
}

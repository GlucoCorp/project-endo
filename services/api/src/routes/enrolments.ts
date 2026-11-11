import { createHash, randomBytes } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { AuditEventInput } from '@endo/audit';
import type { IdempotentInvitationStore } from '@endo/clinical-store';
import type { EnvelopeSealer } from '@endo/crypto';
import { uuidv7 } from '@endo/domain';
import { ProblemError } from '@endo/service-kit';
import { IdentityUnavailableError, type IdentityEnrolment } from '../identity-client.ts';

export interface EnrolmentRouteDeps {
  readonly invitations: IdempotentInvitationStore;
  /** Seals the response for idempotent replay (fresh data key per response, `kms/clinical`). */
  readonly sealer: EnvelopeSealer;
  /** Called after a commit so queued audit events reach the audit store promptly. */
  readonly onCommitted: () => void;
  /** The identity service's confirm route (ADR-0021). Without it, confirm does not exist. */
  readonly identity?: IdentityEnrolment;
}

const UUID = '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';

interface CreatedBody {
  readonly id: string;
  readonly token: string;
  readonly expires_at: string;
}

/**
 * POST /v1/enrolments (spec 9.2, REQ-001; ADR-0017). A clinician creates a single-use invitation
 * for their own organisation.
 *
 * - The link token has 256 random bits and no PHI. Only its SHA-256 is stored with the invitation.
 * - The database sets the expiry, 7 days after its own clock.
 * - Idempotency-Key is required (spec 9.1). A retry with the same key and request replays the
 *   original response, which was sealed with its own data key and kept for 24 hours (product
 *   owner's choice, Section 24 item 19); the same key with a different request is a conflict.
 * - The creation audit event is queued in the same transaction as the invitation (spec 2.6).
 *
 * Not yet reachable in deployment: the API trusts no clinic caller until the clinic BFF exists.
 */
export function registerEnrolmentRoutes(app: FastifyInstance, deps: EnrolmentRouteDeps): void {
  app.post(
    '/v1/enrolments',
    {
      config: {
        policy: {
          kind: 'protected',
          action: 'enrolment.create',
          resourceType: 'enrolment_invitation',
          purpose: 'treatment',
          resource: (_req, subject) => ({
            type: 'enrolment_invitation',
            id: null,
            orgId: subject.orgId,
            patientId: null,
          }),
        },
      },
      schema: {
        headers: {
          type: 'object',
          required: ['idempotency-key'],
          properties: { 'idempotency-key': { type: 'string', pattern: UUID } },
        },
        // No input: the organisation and issuer come from the verified token, never the request.
        body: { type: 'object', additionalProperties: false, maxProperties: 0, nullable: true },
        querystring: { type: 'object', additionalProperties: false, maxProperties: 0 },
        response: {
          201: {
            type: 'object',
            additionalProperties: false,
            required: ['id', 'token', 'expires_at'],
            properties: {
              id: { type: 'string' },
              token: { type: 'string' },
              expires_at: { type: 'string' },
            },
          },
        },
      },
    },
    async (request, reply) => {
      const subject = request.subject;
      const orgId = subject?.orgId;
      const createdBy = request.clinicianId;
      // Guaranteed by the authorisation hook; checked again so a wiring mistake fails closed.
      if (!subject || !orgId || !createdBy) {
        throw new ProblemError(403, 'authz.org_mismatch', 'Not allowed.');
      }
      const key = String(request.headers['idempotency-key']);
      // The request has no input, so its canonical form is the operation itself.
      const requestHash = createHash('sha256').update('POST /v1/enrolments\n{}').digest('hex');
      const sealContext = ['idempotency', orgId, createdBy, 'enrolment.create', key].join(':');

      const token = randomBytes(32).toString('base64url');
      const id = uuidv7();
      const auditEvent = AuditEventInput.parse({
        actor: { id: subject.id, role: subject.role },
        action: 'enrolment.created',
        resource: { type: 'enrolment_invitation', id },
        org_id: orgId,
        purpose_of_use: 'treatment',
        outcome: 'success',
        reason: null,
        request_id: request.id,
      });

      const outcome = await deps.invitations.createOnce({
        invitation: {
          id,
          orgId,
          createdBy,
          tokenHash: createHash('sha256').update(token).digest('hex'),
        },
        idempotency: { actorRef: createdBy, key, requestHash },
        auditEvent: { id: uuidv7(), ...auditEvent },
        sealResponse: (expiresAt) =>
          deps.sealer.seal(
            JSON.stringify({ id, token, expires_at: expiresAt.toISOString() }),
            sealContext,
          ),
      });

      if (outcome.kind === 'conflict') {
        throw new ProblemError(
          422,
          'idempotency.key_reused',
          'This Idempotency-Key was already used for a different request.',
        );
      }
      if (outcome.kind === 'expired') {
        throw new ProblemError(
          422,
          'idempotency.key_expired',
          'This Idempotency-Key is past its replay window. Send the request with a new key.',
        );
      }
      if (outcome.kind === 'replay') {
        // This operation only ever stores 201 responses; anything else means a corrupted record.
        if (outcome.statusCode !== 201) throw new Error('Unexpected idempotency record');
        const body = JSON.parse(await deps.sealer.open(outcome.sealed, sealContext)) as CreatedBody;
        return reply.code(201).send(body);
      }
      deps.onCommitted();
      return reply.code(201).send({ id, token, expires_at: outcome.expiresAt.toISOString() });
    },
  );

  const own = (action: 'enrolment.read' | 'enrolment.confirm') =>
    ({
      kind: 'protected',
      action,
      resourceType: 'enrolment_invitation',
      purpose: 'treatment',
      resource: (req: { params: unknown }, subject: { orgId: string | null }) => {
        const id = (req.params as { id?: unknown }).id;
        return {
          type: 'enrolment_invitation',
          id: typeof id === 'string' && new RegExp(UUID).test(id) ? id : null,
          // Always the clinician's own organisation: the identity service only ever considers
          // transactions of this organisation, so another organisation's invitation never matches.
          orgId: subject.orgId,
          patientId: null,
        };
      },
    }) as const;

  /**
   * GET /v1/enrolments: the organisation's open invitations (ids and times; never tokens), and
   * those accepted in the last 30 days with only her sharing decision (REQ-001 acceptance: a
   * declined `share_with_care_team` shows only "invitation accepted, sharing declined").
   */
  app.get('/v1/enrolments', { config: { policy: own('enrolment.read') } }, async (request) => {
    const orgId = request.subject?.orgId;
    if (!orgId) throw new ProblemError(403, 'authz.org_mismatch', 'Not allowed.');
    const open = await deps.invitations.listOpen(orgId);
    const accepted = await deps.invitations.listAccepted(orgId);
    return {
      accepted: accepted.map((a) => ({
        id: a.id,
        accepted_at: a.acceptedAt.toISOString(),
        sharing: a.sharing,
      })),
      invitations: open.map((i) => ({
        id: i.id,
        created_at: i.createdAt.toISOString(),
        expires_at: i.expiresAt.toISOString(),
        in_use: i.reserved,
      })),
    };
  });

  /**
   * POST /v1/enrolments/{id}/confirm (ADR-0021 sections 2 and 3). The clinician selected this
   * invitation, identified the woman as the clinic normally does, and typed the code from her own
   * phone. The identity service checks the code (wrong codes count per invitation; the fifth locks
   * it for 15 minutes) and, on a match, reserves the invitation.
   */
  if (deps.identity) {
    const identity = deps.identity;
    app.post(
      '/v1/enrolments/:id/confirm',
      {
        config: { policy: own('enrolment.confirm') },
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
            required: ['code', 'identified', 'own_phone'],
            properties: {
              code: { type: 'string', pattern: '^[0-9]{6}$' },
              // The attestation (section 2): both must be true; anything else is refused.
              identified: { const: true },
              own_phone: { const: true },
            },
          },
        },
      },
      async (request) => {
        const orgId = request.subject?.orgId;
        const clinicianId = request.clinicianId;
        if (!orgId || !clinicianId)
          throw new ProblemError(403, 'authz.org_mismatch', 'Not allowed.');
        const { id } = request.params as { id: string };
        const { code } = request.body as { code: string };
        let out;
        try {
          out = await identity.confirm({
            orgId,
            invitationId: id,
            code,
            clinicianId,
            attestation: { identified: true, ownPhone: true },
            requestId: request.id,
          });
        } catch (error) {
          if (error instanceof IdentityUnavailableError)
            throw new ProblemError(503, 'upstream.unavailable', 'Try again in a minute.');
          throw error;
        }
        switch (out.outcome) {
          case 'confirmed':
            return { outcome: 'confirmed' };
          case 'wrong':
            return { outcome: 'wrong', remaining: out.remaining };
          case 'locked':
            return { outcome: 'locked', locked_until: out.lockedUntil };
          case 'unavailable':
            return { outcome: 'unavailable' };
        }
      },
    );
  }
}

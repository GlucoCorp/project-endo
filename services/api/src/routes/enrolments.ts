import { createHash, randomBytes } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { InvitationStore } from '@endo/clinical-store';
import { uuidv7 } from '@endo/domain';
import { ProblemError } from '@endo/service-kit';

export interface EnrolmentRouteDeps {
  readonly invitations: InvitationStore;
}

/**
 * POST /v1/enrolments (spec 9.2, REQ-001; ADR-0017). A clinician creates a single-use invitation
 * for their own organisation. The response carries the link token exactly once: only its SHA-256
 * is stored, so it can never be shown again. The token holds 256 random bits and no PHI. The
 * database sets the expiry, 7 days after its own clock.
 *
 * Not yet reachable in deployment: the API trusts no clinic caller until the clinic BFF exists.
 * Idempotency-Key handling and an outbox-backed creation audit event come in the next slice.
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
      const orgId = request.subject?.orgId;
      const createdBy = request.clinicianId;
      // Guaranteed by the authorisation hook; checked again so a wiring mistake fails closed.
      if (!orgId || !createdBy) throw new ProblemError(403, 'authz.org_mismatch', 'Not allowed.');

      const token = randomBytes(32).toString('base64url');
      const id = uuidv7();
      const { expiresAt } = await deps.invitations.create({
        id,
        orgId,
        createdBy,
        tokenHash: createHash('sha256').update(token).digest('hex'),
      });
      return reply.code(201).send({ id, token, expires_at: expiresAt.toISOString() });
    },
  );
}

import type { FastifyInstance } from 'fastify';
import type { AuditWriter } from '@endo/audit';
import type {
  ClaimRequest,
  InvitationState,
  ReservationOutcome,
  ReservationRequest,
} from '@endo/clinical-store';
import { uuidv7 } from '@endo/domain';
import { ProblemError } from '@endo/service-kit';

/**
 * What the enrolment coordinator (identity service) reads from the clinical store before a start
 * (ADR-0021 sections 6 and 13). Reserve, release, revoke and claim join this as their slices land.
 */
export interface EnrolmentCoordination {
  /** A live invitation (unclaimed, unexpired, not revoked) by the SHA-256 of its link token. */
  find(
    tokenHash: string,
  ): Promise<{ invitationId: string; orgId: string; reserved: boolean } | null>;
  state(orgId: string, invitationId: string): Promise<InvitationState>;
  /** Section 6: holds the invitation for one transaction (idempotent per transaction). */
  reserve(r: ReservationRequest): Promise<ReservationOutcome>;
  /** Section 6: ends this transaction's hold for good (idempotent; fenced). */
  release(r: ReservationRequest): Promise<ReservationOutcome>;
  /**
   * Section 10: creates the patient record and claims the invitation this transaction reserved,
   * in one clinical transaction (idempotent; a retry must name the same patient and person).
   */
  claim(r: ClaimRequest): Promise<ReservationOutcome>;
}

export interface CoordinatorRouteDeps {
  readonly coordination: EnrolmentCoordination;
  readonly audit: AuditWriter;
  /** Relays queued audit events promptly after a change. */
  readonly onCommitted?: () => void;
}

const UUID = '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$';
const SCOPE = 'api.enrolment.coordinate';
const policy = (action: string) =>
  ({ kind: 'workload', scope: SCOPE, action, resourceType: 'enrolment_invitation' }) as const;

/**
 * Coordinator routes (ADR-0021 section 13): callable only by the identity service, holding
 * workload scope `api.enrolment.coordinate`. Never reachable from a browser. Both are POST so the
 * token hash never appears in a URL; neither the hash nor the token is ever audited or logged.
 */
export function registerCoordinatorRoutes(app: FastifyInstance, deps: CoordinatorRouteDeps): void {
  const audited = async (requestId: string, action: string, id: string | null) => {
    await deps.audit.write({
      actor: { id: null, role: 'system' },
      action,
      resource: { type: 'enrolment_invitation', id },
      org_id: null,
      purpose_of_use: 'operations',
      outcome: 'success',
      reason: null,
      request_id: requestId,
    });
  };

  app.post(
    '/internal/v1/enrolment/invitations/find',
    {
      config: { policy: policy('api.enrolment.invitation.find') },
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['token_hash'],
          properties: { token_hash: { type: 'string', pattern: '^[0-9a-f]{64}$' } },
        },
        response: {
          200: {
            type: 'object',
            additionalProperties: false,
            required: ['invitation_id', 'org_id', 'reserved'],
            properties: {
              invitation_id: { type: 'string' },
              org_id: { type: 'string' },
              reserved: { type: 'boolean' },
            },
          },
        },
      },
    },
    async (request) => {
      const { token_hash } = request.body as { token_hash: string };
      const found = await deps.coordination.find(token_hash);
      // Which invitation was found (or that none was); never the hash.
      await audited(request.id, 'api.enrolment.invitation.found', found?.invitationId ?? null);
      // One answer for unknown, expired, claimed and revoked links: nothing to tell apart.
      if (!found) throw new ProblemError(404, 'enrolment.link_invalid', 'Not found.');
      return {
        invitation_id: found.invitationId,
        org_id: found.orgId,
        reserved: found.reserved,
      };
    },
  );

  app.post(
    '/internal/v1/enrolment/invitations/state',
    {
      config: { policy: policy('api.enrolment.invitation.state') },
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['org_id', 'invitation_id'],
          properties: {
            org_id: { type: 'string', pattern: UUID },
            invitation_id: { type: 'string', pattern: UUID },
          },
        },
        response: {
          200: {
            type: 'object',
            additionalProperties: false,
            required: ['status'],
            properties: {
              status: {
                type: 'string',
                enum: ['missing', 'live', 'expired', 'revoked', 'claimed'],
              },
              reserved_by: { type: ['string', 'null'] },
              patient_id: { type: 'string' },
            },
          },
        },
      },
    },
    async (request) => {
      const { org_id, invitation_id } = request.body as { org_id: string; invitation_id: string };
      const state = await deps.coordination.state(org_id, invitation_id);
      await audited(request.id, 'api.enrolment.invitation.state_read', invitation_id);
      if (state.status === 'missing') return { status: 'missing' };
      if (state.status === 'claimed')
        return { status: 'claimed', reserved_by: state.reservedBy, patient_id: state.patientId };
      return { status: state.status, reserved_by: state.reservedBy };
    },
  );

  const RESERVATION_BODY = {
    type: 'object',
    additionalProperties: false,
    required: ['org_id', 'invitation_id', 'transaction_id'],
    properties: {
      org_id: { type: 'string', pattern: UUID },
      invitation_id: { type: 'string', pattern: UUID },
      transaction_id: { type: 'string', pattern: UUID },
    },
  } as const;

  const stateBody = (state: InvitationState) =>
    state.status === 'missing'
      ? { status: 'missing' }
      : state.status === 'claimed'
        ? { status: 'claimed', reserved_by: state.reservedBy, patient_id: state.patientId }
        : { status: state.status, reserved_by: state.reservedBy };

  for (const op of ['reserve', 'release'] as const) {
    app.post(
      `/internal/v1/enrolment/invitations/${op}`,
      {
        config: { policy: policy(`api.enrolment.invitation.${op}`) },
        schema: { body: RESERVATION_BODY },
      },
      async (request) => {
        const b = request.body as { org_id: string; invitation_id: string; transaction_id: string };
        const r: ReservationRequest = {
          orgId: b.org_id,
          invitationId: b.invitation_id,
          transactionId: b.transaction_id,
          // Queued with the change, in the same database transaction (spec 2.6).
          auditEvent: {
            id: uuidv7(),
            actor: { id: null, role: 'system' },
            action:
              op === 'reserve'
                ? 'api.enrolment.invitation.reserved'
                : 'api.enrolment.invitation.released',
            resource: { type: 'enrolment_invitation', id: b.invitation_id },
            org_id: b.org_id,
            purpose_of_use: 'operations',
            outcome: 'success',
            reason: null,
            request_id: request.id,
          },
        };
        const out = await (op === 'reserve'
          ? deps.coordination.reserve(r)
          : deps.coordination.release(r));
        deps.onCommitted?.();
        return out.outcome === 'done'
          ? { outcome: 'done', changed: out.changed, state: stateBody(out.state) }
          : { outcome: 'refused', state: stateBody(out.state) };
      },
    );
  }

  /**
   * POST /internal/v1/enrolment/invitations/claim (ADR-0021 section 10): the last step that can
   * still fail cleanly. A definite refusal (revoked, expired, not reserved by this transaction)
   * lets the coordinator cancel; an unknown outcome is resolved by asking `state`.
   */
  app.post(
    '/internal/v1/enrolment/invitations/claim',
    {
      config: { policy: policy('api.enrolment.invitation.claim') },
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['org_id', 'invitation_id', 'transaction_id', 'patient_id', 'identity_ref'],
          properties: {
            org_id: { type: 'string', pattern: UUID },
            invitation_id: { type: 'string', pattern: UUID },
            transaction_id: { type: 'string', pattern: UUID },
            patient_id: { type: 'string', pattern: UUID },
            identity_ref: { type: 'string', pattern: UUID },
          },
        },
      },
    },
    async (request) => {
      const b = request.body as {
        org_id: string;
        invitation_id: string;
        transaction_id: string;
        patient_id: string;
        identity_ref: string;
      };
      const out = await deps.coordination.claim({
        orgId: b.org_id,
        invitationId: b.invitation_id,
        transactionId: b.transaction_id,
        patientId: b.patient_id,
        identityRef: b.identity_ref,
        auditEvent: {
          id: uuidv7(),
          actor: { id: null, role: 'system' },
          action: 'api.enrolment.invitation.claimed',
          resource: { type: 'enrolment_invitation', id: b.invitation_id },
          org_id: b.org_id,
          purpose_of_use: 'operations',
          outcome: 'success',
          reason: null,
          request_id: request.id,
        },
      });
      deps.onCommitted?.();
      return out.outcome === 'done'
        ? { outcome: 'done', changed: out.changed, state: stateBody(out.state) }
        : { outcome: 'refused', state: stateBody(out.state) };
    },
  );
}

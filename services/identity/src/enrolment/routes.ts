import { timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { uuidv7 } from '@endo/domain';
import { ProblemError } from '@endo/service-kit';
import type { ClinicalClient } from './clinical.ts';
import { ClinicalUnavailableError } from './clinical.ts';
import type { EnrolmentCodes } from './code.ts';
import { isOverdue, startTransaction, type EnrolmentTransaction } from './state-machine.ts';
import type { OutboxEvent, PostgresEnrolmentStore, StoredTransaction } from './store.ts';

export interface PatientRouteDeps {
  readonly store: PostgresEnrolmentStore;
  readonly codes: EnrolmentCodes;
  readonly clinical: ClinicalClient;
  readonly now: () => Date;
}

const UUID = '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$';
const UUID_RE = new RegExp(UUID);
const HEX64 = '^[0-9a-f]{64}$';
const SCOPE = 'identity.enrolment.patient';

const txIdParam = (req: FastifyRequest): string | null => {
  const id = (req.params as { id?: unknown }).id;
  return typeof id === 'string' && UUID_RE.test(id) ? id : null;
};
const access = (action: string, resourceId: (r: FastifyRequest) => string | null) =>
  ({
    kind: 'workload',
    scope: SCOPE,
    action,
    resourceId,
    resourceType: 'enrolment_transaction',
  }) as const;

/** An audit event for the identity outbox, about one enrolment transaction (opaque ids only). */
export function enrolmentAudit(
  action: string,
  tx: EnrolmentTransaction,
  requestId: string,
): OutboxEvent {
  return {
    id: uuidv7(),
    actor: { id: null, role: 'system' },
    action,
    resource: { type: 'enrolment_transaction', id: tx.id },
    org_id: tx.orgId,
    purpose_of_use: 'operations',
    outcome: 'success',
    reason: null,
    request_id: requestId,
  };
}

/** What the patient's page may know about her transaction: never the code after Start. */
export function enrolmentView(tx: EnrolmentTransaction, now: Date) {
  return {
    transaction_id: tx.id,
    status: tx.status,
    expired: isOverdue(tx, now),
    state_deadline: tx.stateDeadline?.toISOString() ?? null,
    expires_at: tx.expiresAt.toISOString(),
  };
}

const VIEW_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['transaction_id', 'status', 'expired', 'state_deadline', 'expires_at'],
  properties: {
    transaction_id: { type: 'string' },
    status: { type: 'string' },
    expired: { type: 'boolean' },
    state_deadline: { type: ['string', 'null'] },
    expires_at: { type: 'string' },
    code: { type: 'string', pattern: '^[0-9]{6}$' },
  },
} as const;

const BINDING_BODY = {
  type: 'object',
  additionalProperties: false,
  required: ['binding_hash'],
  properties: { binding_hash: { type: 'string', pattern: HEX64 } },
} as const;

/** One answer for an unknown transaction and a wrong browser binding: nothing to tell apart. */
const notFound = () => new ProblemError(404, 'enrolment.not_found', 'Not found.');

export function boundTransaction(
  stored: StoredTransaction | null,
  bindingHash: string,
): StoredTransaction {
  if (!stored) throw notFound();
  const a = Buffer.from(stored.bindingHash, 'hex');
  const b = Buffer.from(bindingHash, 'hex');
  if (a.length !== b.length || !timingSafeEqual(a, b)) throw notFound();
  return stored;
}

/**
 * The patient-side coordinator routes (ADR-0021 sections 3, 4 and 13), callable only by the
 * patient BFF with workload scope `identity.enrolment.patient`. The BFF passes the SHA-256 of the
 * link token and of the browser secret it holds in her cookie; neither secret reaches this
 * service. Every call after Start must present the same browser binding.
 */
export function registerPatientEnrolmentRoutes(app: FastifyInstance, deps: PatientRouteDeps) {
  app.post(
    '/internal/v1/enrolment/transactions',
    {
      config: { access: access('identity.enrolment.start', () => null) },
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['token_hash', 'binding_hash'],
          properties: {
            token_hash: { type: 'string', pattern: HEX64 },
            binding_hash: { type: 'string', pattern: HEX64 },
          },
        },
        response: { 200: VIEW_SCHEMA, 201: VIEW_SCHEMA },
      },
    },
    async (request, reply) => {
      const { token_hash, binding_hash } = request.body as {
        token_hash: string;
        binding_hash: string;
      };
      let invitation;
      try {
        invitation = await deps.clinical.find(token_hash);
      } catch (error) {
        if (error instanceof ClinicalUnavailableError)
          throw new ProblemError(503, 'upstream.unavailable', 'Try again later.');
        throw error;
      }
      if (!invitation) throw new ProblemError(404, 'enrolment.link_invalid', 'Not found.');

      // Start repeated from the same browser: the same transaction, never a new code (section 3).
      const open = await deps.store.findOpenByBinding(binding_hash, invitation.invitationId);
      if (open) return reply.code(200).send(enrolmentView(open.tx, deps.now()));

      if (invitation.reserved)
        throw new ProblemError(409, 'enrolment.unavailable', 'This link is in use.');
      const tx = startTransaction({
        id: uuidv7(),
        invitationId: invitation.invitationId,
        orgId: invitation.orgId,
        now: deps.now(),
      });
      const created = await deps.store.create(
        tx,
        binding_hash,
        (pending) =>
          deps.codes.issue({ invitationId: tx.invitationId, transactionId: tx.id }, pending),
        enrolmentAudit('identity.enrolment.started', tx, request.id),
      );
      // Another request from the same browser won the race: the same transaction, no code.
      if (created.outcome === 'existing')
        return reply.code(200).send(enrolmentView(created.tx, deps.now()));
      if (created.outcome === 'locked')
        throw new ProblemError(409, 'enrolment.locked', 'Try again later.');
      if (created.outcome === 'full')
        throw new ProblemError(409, 'enrolment.busy', 'Try again later.');
      // The only time the code leaves this service: her phone shows it to the clinician.
      return reply.code(201).send({ ...enrolmentView(tx, deps.now()), code: created.code });
    },
  );

  app.post(
    '/internal/v1/enrolment/transactions/:id/status',
    {
      config: { access: access('identity.enrolment.status', txIdParam) },
      schema: {
        params: {
          type: 'object',
          additionalProperties: false,
          required: ['id'],
          properties: { id: { type: 'string', pattern: UUID } },
        },
        body: BINDING_BODY,
        response: { 200: VIEW_SCHEMA },
      },
    },
    async (request) => {
      const { id } = request.params as { id: string };
      const { binding_hash } = request.body as { binding_hash: string };
      const stored = boundTransaction(await deps.store.get(id), binding_hash);
      return enrolmentView(stored.tx, deps.now());
    },
  );

  app.post(
    '/internal/v1/enrolment/transactions/:id/cancel',
    {
      config: { access: access('identity.enrolment.cancel', txIdParam) },
      schema: {
        params: {
          type: 'object',
          additionalProperties: false,
          required: ['id'],
          properties: { id: { type: 'string', pattern: UUID } },
        },
        body: BINDING_BODY,
        response: { 200: VIEW_SCHEMA },
      },
    },
    async (request) => {
      const { id } = request.params as { id: string };
      const { binding_hash } = request.body as { binding_hash: string };
      boundTransaction(await deps.store.get(id), binding_hash);
      const r = await deps.store.apply(
        id,
        { type: 'cancel', reason: 'patient-cancelled' },
        deps.now,
        (_, after) => enrolmentAudit('identity.enrolment.cancelled', after, request.id),
      );
      // Once her consent has been claimed, leaving is account deletion (REQ-009).
      if (!r.ok) throw new ProblemError(409, 'enrolment.cannot_cancel', 'Cannot cancel now.');
      return enrolmentView(r.tx, deps.now());
    },
  );
}

/**
 * The clinic side (ADR-0021 sections 2, 3 and 13), callable only by the API with workload scope
 * `identity.enrolment.clinic`. The API has already checked the clinician's session, membership and
 * organisation, and that both attestations are true; it passes the clinician's clinical-store id.
 *
 * The code is checked against this organisation's transactions for the selected invitation only;
 * wrong codes count per invitation, and the fifth locks it for 15 minutes. On a match the
 * invitation is reserved in the clinical store; if that is refused (revoked, expired, held by
 * another transaction), the transaction is cancelled and the answer is `unavailable`.
 */
export function registerClinicEnrolmentRoutes(app: FastifyInstance, deps: PatientRouteDeps) {
  app.post(
    '/internal/v1/enrolment/confirm',
    {
      config: {
        access: {
          kind: 'workload',
          scope: 'identity.enrolment.clinic',
          action: 'identity.enrolment.confirm',
          resourceId: () => null,
          resourceType: 'enrolment_transaction',
        },
      },
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['org_id', 'invitation_id', 'code', 'clinician_id', 'attestation'],
          properties: {
            org_id: { type: 'string', pattern: UUID },
            invitation_id: { type: 'string', pattern: UUID },
            code: { type: 'string', pattern: '^[0-9]{6}$' },
            clinician_id: { type: 'string', pattern: UUID },
            attestation: {
              type: 'object',
              additionalProperties: false,
              required: ['identified', 'own_phone'],
              properties: { identified: { const: true }, own_phone: { const: true } },
            },
          },
        },
      },
    },
    async (request) => {
      const b = request.body as {
        org_id: string;
        invitation_id: string;
        code: string;
        clinician_id: string;
      };
      // Who did it: the clinician, with the attestation the API required (section 2).
      const byClinician = (action: string, resource: { type: string; id: string }) => ({
        id: uuidv7(),
        actor: { id: b.clinician_id, role: 'clinician' },
        action,
        resource,
        org_id: b.org_id,
        purpose_of_use: 'treatment',
        outcome: 'success',
        reason: null,
        request_id: request.id,
      });
      const invitation = { type: 'enrolment_invitation', id: b.invitation_id };
      const result = await deps.store.confirmByCode(
        { invitationId: b.invitation_id, orgId: b.org_id, code: b.code },
        (code, binding, sealed) => deps.codes.matches(code, binding, sealed),
        deps.now,
        (e) => {
          switch (e.kind) {
            case 'confirmed':
              return byClinician('identity.enrolment.confirmed_attested', {
                type: 'enrolment_transaction',
                id: e.after.id,
              });
            case 'cancelled':
              return enrolmentAudit('identity.enrolment.cancelled', e.after, request.id);
            case 'wrong-code':
              return byClinician('identity.enrolment.wrong_code', invitation);
            case 'locked':
              return byClinician('identity.enrolment.locked', invitation);
          }
        },
      );
      if (result.outcome === 'wrong') return { outcome: 'wrong', remaining: result.remaining };
      if (result.outcome === 'locked')
        return { outcome: 'locked', locked_until: result.lockedUntil.toISOString() };

      const tx = result.tx;
      let reserved: 'done' | 'refused';
      try {
        reserved = await deps.clinical.reserve({
          orgId: tx.orgId,
          invitationId: tx.invitationId,
          transactionId: tx.id,
        });
      } catch (error) {
        // Unknown outcome: the transaction stays confirmed (its deadline still runs); reserve is
        // idempotent per transaction, so reconciliation can finish or release it (section 6).
        if (error instanceof ClinicalUnavailableError)
          throw new ProblemError(503, 'upstream.unavailable', 'Try again later.');
        throw error;
      }
      if (reserved === 'refused') {
        await deps.store.apply(
          tx.id,
          { type: 'cancel', reason: 'claim-refused' },
          deps.now,
          (_, after) => enrolmentAudit('identity.enrolment.cancelled', after, request.id),
        );
        return { outcome: 'unavailable' };
      }
      // The clinical store definitely holds it for this transaction: record that (migration 0007).
      await deps.store.recordReservation(
        tx.id,
        enrolmentAudit('identity.enrolment.reserved', tx, request.id),
      );
      return { outcome: 'confirmed' };
    },
  );
}

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
function view(tx: EnrolmentTransaction, now: Date) {
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

function bound(stored: StoredTransaction | null, bindingHash: string): StoredTransaction {
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
      if (open) return reply.code(200).send(view(open.tx, deps.now()));

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
      if (created.outcome === 'locked')
        throw new ProblemError(409, 'enrolment.locked', 'Try again later.');
      // The only time the code leaves this service: her phone shows it to the clinician.
      return reply.code(201).send({ ...view(tx, deps.now()), code: created.code });
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
      const stored = bound(await deps.store.get(id), binding_hash);
      return view(stored.tx, deps.now());
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
      bound(await deps.store.get(id), binding_hash);
      const r = await deps.store.apply(
        id,
        { type: 'cancel', reason: 'patient-cancelled' },
        deps.now,
        (_, after) => enrolmentAudit('identity.enrolment.cancelled', after, request.id),
      );
      // Once her consent has been claimed, leaving is account deletion (REQ-009).
      if (!r.ok) throw new ProblemError(409, 'enrolment.cannot_cancel', 'Cannot cancel now.');
      return view(r.tx, deps.now());
    },
  );
}

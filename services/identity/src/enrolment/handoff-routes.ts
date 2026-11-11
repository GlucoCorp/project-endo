import { createHash, randomBytes } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { uuidv7 } from '@endo/domain';
import { CONSENT_PURPOSES, type ConsentPurpose } from '@endo/authz';
import { ProblemError } from '@endo/service-kit';
import type { ConsentDecisions } from './state-machine.ts';
import { ClinicalUnavailableError } from './clinical.ts';
import {
  boundTransaction,
  enrolmentAudit,
  enrolmentView,
  type PatientRouteDeps,
} from './routes.ts';

/** The one identity-provider issuer this deployment trusts (ADR-0019 single-issuer invariant). */
export interface HandoffRouteDeps extends PatientRouteDeps {
  readonly issuer: string;
  /** Starts activation at once after her consent (the periodic sweep catches anything missed). */
  readonly onConsented?: (transactionId: string) => void;
}

const UUID = '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$';
const UUID_RE = new RegExp(UUID);
const HEX64 = '^[0-9a-f]{64}$';
const PATIENT_SCOPE = 'identity.enrolment.patient';
const KEYCLOAK_SCOPE = 'identity.enrolment.keycloak';
const sha256Hex = (s: string) => createHash('sha256').update(s).digest('hex');

const txIdParam = (req: FastifyRequest): string | null => {
  const id = (req.params as { id?: unknown }).id;
  return typeof id === 'string' && UUID_RE.test(id) ? id : null;
};
const access = (scope: string, action: string, resourceId: (r: FastifyRequest) => string | null) =>
  ({ kind: 'workload', scope, action, resourceId, resourceType: 'enrolment_transaction' }) as const;
const ID_PARAMS = {
  type: 'object',
  additionalProperties: false,
  required: ['id'],
  properties: { id: { type: 'string', pattern: UUID } },
} as const;

const BINDING_FIELDS = {
  kind: { type: 'string', enum: ['enrol', 'resume'] },
  issuer: { type: 'string', minLength: 1, maxLength: 255 },
  client_id: { type: 'string', minLength: 1, maxLength: 255 },
  redirect_uri: { type: 'string', minLength: 1, maxLength: 2048 },
  code_challenge: { type: 'string', pattern: '^[A-Za-z0-9_-]{43}$' },
  state: { type: 'string', minLength: 16, maxLength: 255 },
  nonce: { type: 'string', minLength: 16, maxLength: 255 },
} as const;
interface BindingBody {
  readonly kind: 'enrol' | 'resume';
  readonly issuer: string;
  readonly client_id: string;
  readonly redirect_uri: string;
  readonly code_challenge: string;
  readonly state: string;
  readonly nonce: string;
}
const binding = (b: BindingBody) => ({
  kind: b.kind,
  issuer: b.issuer,
  clientId: b.client_id,
  redirectUri: b.redirect_uri,
  codeChallenge: b.code_challenge,
  state: b.state,
  nonce: b.nonce,
});

/**
 * The handoff into Keycloak (ADR-0021 sections 5 to 7). The patient BFF asks for a handoff bound
 * to its own OIDC request; the Keycloak extension redeems it and reports the committed passkey;
 * the BFF's callback then moves her on to consent.
 */
export function registerHandoffRoutes(app: FastifyInstance, deps: HandoffRouteDeps): void {
  /**
   * A handoff needs the clinical store's reservation (identity migration 0007). If the confirm
   * route could not learn the outcome (a timeout), ask again now: reserving is idempotent per
   * transaction. Refused means the invitation is revoked, expired or held by another transaction:
   * the transaction is cancelled. Unreachable fails closed.
   */
  const ensureReserved = async (id: string, requestId: string): Promise<void> => {
    if (await deps.store.isReserved(id)) return;
    const stored = await deps.store.get(id);
    if (stored?.tx.status !== 'confirmed') return; // createHandoff refuses it in any case.
    const tx = stored.tx;
    let out: 'done' | 'refused';
    try {
      out = await deps.clinical.reserve({
        orgId: tx.orgId,
        invitationId: tx.invitationId,
        transactionId: tx.id,
      });
    } catch (error) {
      if (error instanceof ClinicalUnavailableError)
        throw new ProblemError(503, 'upstream.unavailable', 'Try again later.');
      throw error;
    }
    if (out === 'done') {
      await deps.store.recordReservation(
        tx.id,
        enrolmentAudit('identity.enrolment.reserved', tx, requestId),
      );
      return;
    }
    await deps.store.apply(
      tx.id,
      { type: 'cancel', reason: 'claim-refused' },
      deps.now,
      (_, after) => enrolmentAudit('identity.enrolment.cancelled', after, requestId),
    );
    throw new ProblemError(409, 'enrolment.unavailable', 'This invitation can no longer be used.');
  };

  app.post(
    '/internal/v1/enrolment/transactions/:id/handoff',
    {
      config: { access: access(PATIENT_SCOPE, 'identity.enrolment.handoff', txIdParam) },
      schema: {
        params: ID_PARAMS,
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['binding_hash', ...Object.keys(BINDING_FIELDS)],
          properties: { binding_hash: { type: 'string', pattern: HEX64 }, ...BINDING_FIELDS },
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const b = request.body as BindingBody & { binding_hash: string };
      boundTransaction(await deps.store.get(id), b.binding_hash);
      // Only this deployment's identity provider (single-issuer invariant).
      if (b.issuer !== deps.issuer)
        throw new ProblemError(400, 'request.invalid', 'Unknown identity provider.');
      if (b.kind === 'enrol') await ensureReserved(id, request.id);
      const ref = randomBytes(32).toString('base64url');
      const created = await deps.store.createHandoff(
        { ...binding(b), refHash: sha256Hex(ref), transactionId: id },
        deps.now,
        (tx) => enrolmentAudit(`identity.enrolment.handoff_${b.kind}`, tx, request.id),
      );
      if (!created) throw new ProblemError(409, 'enrolment.not_ready', 'Not ready yet.');
      // The reference leaves this service once, for her browser's authorisation request.
      return reply
        .code(201)
        .send({ handoff_ref: ref, expires_at: created.expiresAt.toISOString() });
    },
  );

  app.post(
    '/internal/v1/enrolment/handoffs/redeem',
    {
      config: { access: access(KEYCLOAK_SCOPE, 'identity.enrolment.redeem', () => null) },
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['handoff_ref', 'session', ...Object.keys(BINDING_FIELDS)],
          properties: {
            handoff_ref: { type: 'string', pattern: '^[A-Za-z0-9_-]{43}$' },
            session: {
              type: 'object',
              additionalProperties: false,
              required: ['root_session_id', 'client_uuid', 'tab_id'],
              properties: {
                root_session_id: { type: 'string', minLength: 1, maxLength: 255 },
                client_uuid: { type: 'string', minLength: 1, maxLength: 255 },
                tab_id: { type: 'string', minLength: 1, maxLength: 255 },
              },
            },
            ...BINDING_FIELDS,
          },
        },
      },
    },
    async (request) => {
      const b = request.body as BindingBody & {
        handoff_ref: string;
        session: { root_session_id: string; client_uuid: string; tab_id: string };
      };
      const result = await deps.store.redeemHandoff(
        {
          ...binding(b),
          refHash: sha256Hex(b.handoff_ref),
          session: {
            rootSessionId: b.session.root_session_id,
            clientUuid: b.session.client_uuid,
            tabId: b.session.tab_id,
          },
        },
        () => uuidv7(),
        deps.now,
        (tx, action) => enrolmentAudit(action, tx, request.id),
      );
      // One answer for every refusal: the extension ends the flow on a terminal error page.
      if (!result.ok) throw new ProblemError(403, 'enrolment.handoff_refused', 'Refused.');
      return {
        transaction_id: result.transactionId,
        provisional_subject: result.provisionalSubject,
        kind: result.kind,
      };
    },
  );

  /**
   * ADR-0021 section 8: Keycloak asks before showing the passkey challenge and again before
   * accepting the answer. Only a transaction still `redeemed`, for this provisional user, before
   * its deadline, may register a passkey; a cancellation from another tab stops it at once.
   */
  app.post(
    '/internal/v1/enrolment/transactions/:id/registration-check',
    {
      config: {
        access: access(KEYCLOAK_SCOPE, 'identity.enrolment.registration_check', txIdParam),
      },
      schema: {
        params: ID_PARAMS,
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['subject'],
          properties: { subject: { type: 'string', pattern: UUID } },
        },
      },
    },
    async (request) => {
      const { id } = request.params as { id: string };
      const { subject } = request.body as { subject: string };
      if (!(await deps.store.registrationAllowed(id, subject, deps.now())))
        throw new ProblemError(409, 'enrolment.wrong_state', 'Not in that state.');
      return { allowed: true };
    },
  );

  app.post(
    '/internal/v1/enrolment/transactions/:id/credential-committed',
    {
      config: {
        access: access(KEYCLOAK_SCOPE, 'identity.enrolment.credential_committed', txIdParam),
      },
      schema: { params: ID_PARAMS },
    },
    async (request) => {
      const { id } = request.params as { id: string };
      const r = await deps.store.apply(id, { type: 'credential-committed' }, deps.now, (_, after) =>
        enrolmentAudit('identity.enrolment.credential_committed', after, request.id),
      );
      if (!r.ok) throw new ProblemError(409, 'enrolment.wrong_state', 'Not in that state.');
      return { status: r.tx.status };
    },
  );

  /**
   * Her consent (ADR-0021 sections 10 and 12; spec 13.1): all four decisions, each with the version
   * of the explanation she saw and when. Declining self-tracking ends enrolment. Otherwise the
   * transaction moves to `claiming` with the ids the coordinator chooses now (the identity-vault
   * person and the clinical patient record); nothing permanent exists until the claim succeeds.
   */
  app.post(
    '/internal/v1/enrolment/transactions/:id/consent',
    {
      config: { access: access(PATIENT_SCOPE, 'identity.enrolment.consent', txIdParam) },
      schema: {
        params: ID_PARAMS,
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['binding_hash', 'decisions'],
          properties: {
            binding_hash: { type: 'string', pattern: HEX64 },
            decisions: {
              type: 'object',
              additionalProperties: false,
              required: [...CONSENT_PURPOSES],
              properties: Object.fromEntries(
                CONSENT_PURPOSES.map((p) => [
                  p,
                  {
                    type: 'object',
                    additionalProperties: false,
                    required: ['status', 'version', 'decided_at'],
                    properties: {
                      status: { type: 'string', enum: ['granted', 'declined'] },
                      version: { type: 'integer', minimum: 1, maximum: 999_999_999 },
                      decided_at: { type: 'string', format: 'date-time' },
                    },
                  },
                ]),
              ),
            },
          },
        },
      },
    },
    async (request) => {
      const { id } = request.params as { id: string };
      const b = request.body as {
        binding_hash: string;
        decisions: Record<
          ConsentPurpose,
          { status: 'granted' | 'declined'; version: number; decided_at: string }
        >;
      };
      boundTransaction(await deps.store.get(id), b.binding_hash);
      const now = deps.now();
      const given = new Map(Object.entries(b.decisions));
      const decisions = Object.fromEntries(
        CONSENT_PURPOSES.flatMap((p) => {
          const d = given.get(p);
          // A time from her browser is never later than now (the state machine refuses it).
          return d
            ? [[p, { status: d.status, version: d.version, decidedAt: new Date(d.decided_at) }]]
            : [];
        }),
      ) as unknown as ConsentDecisions;
      const r = await deps.store.apply(
        id,
        { type: 'consent', decisions, personId: uuidv7(), patientId: uuidv7() },
        () => now,
        (_, after) =>
          enrolmentAudit(
            after.status === 'cancelling'
              ? 'identity.enrolment.declined'
              : 'identity.enrolment.consented',
            after,
            request.id,
          ),
      );
      if (!r.ok) {
        if (r.reason === 'incomplete-consent')
          throw new ProblemError(400, 'request.invalid', 'Every choice is needed.');
        throw new ProblemError(409, 'enrolment.not_ready', 'Not ready yet.');
      }
      if (r.tx.status === 'claiming') deps.onConsented?.(id);
      return enrolmentView(r.tx, now);
    },
  );

  app.post(
    '/internal/v1/enrolment/transactions/:id/callback',
    {
      config: { access: access(PATIENT_SCOPE, 'identity.enrolment.callback', txIdParam) },
      schema: {
        params: ID_PARAMS,
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['binding_hash', 'subject'],
          properties: {
            binding_hash: { type: 'string', pattern: HEX64 },
            subject: { type: 'string', minLength: 1, maxLength: 255 },
          },
        },
      },
    },
    async (request) => {
      const { id } = request.params as { id: string };
      const b = request.body as { binding_hash: string; subject: string };
      boundTransaction(await deps.store.get(id), b.binding_hash);
      // Reconciling with Keycloak when the callback beats the commit notice comes with slice 6;
      // until then the callback waits for the extension's commit notice.
      const r = await deps.store.apply(
        id,
        { type: 'callback', subject: b.subject, credentialCommitted: false },
        deps.now,
        (_, after) => enrolmentAudit('identity.enrolment.consent_pending', after, request.id),
      );
      if (!r.ok) {
        if (r.reason === 'subject-mismatch')
          throw new ProblemError(403, 'enrolment.subject_mismatch', 'Not allowed.');
        throw new ProblemError(409, 'enrolment.not_ready', 'Not ready yet.');
      }
      return enrolmentView(r.tx, deps.now());
    },
  );
}

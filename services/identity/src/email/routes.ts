import type { FastifyInstance, FastifyRequest } from 'fastify';
import { uuidv7 } from '@endo/domain';
import { ProblemError } from '@endo/service-kit';
import type { EmailCodeStore } from './store.ts';

/** Sends one code email; Keycloak's sender does it (ADR-0026). True once handed over. */
export interface EmailSender {
  send(to: string, code: string, purpose: 'sign-in' | 'confirm'): Promise<boolean>;
}

export interface EmailRouteDeps {
  readonly store: EmailCodeStore;
  /** Delivers confirmation codes. Without it, confirming an address is unavailable. */
  readonly sender: EmailSender | null;
}

const UUID = '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$';
const EMAIL = { type: 'string', minLength: 3, maxLength: 254, pattern: '^[^\\s@]+@[^\\s@]+$' };
const IP = { type: 'string', minLength: 2, maxLength: 64, pattern: '^[0-9A-Fa-f.:]+$' };
const CODE = { type: 'string', pattern: '^[0-9]{6}$' };

const access = (scope: string, action: string) =>
  ({
    kind: 'workload',
    scope,
    action,
    resourceId: (r: FastifyRequest) => {
      const id = (r.body as { request_id?: unknown } | undefined)?.request_id;
      return typeof id === 'string' && new RegExp(UUID).test(id) ? id : null;
    },
    resourceType: 'email_code',
  }) as const;

/** An audit event about one code request: opaque ids and codes only, never an address. */
const audit = (requestId: string) => (action: string, id: string) => ({
  id: uuidv7(),
  actor: { id: null, role: 'system' },
  action,
  resource: { type: 'email_code', id },
  org_id: null,
  purpose_of_use: 'operations',
  outcome: 'success',
  reason: null,
  request_id: requestId,
});

/**
 * Email one-time codes (spec 10.1; ADR-0026). Sign-in: the Keycloak extension asks for a code
 * (scope `identity.email_code.keycloak`) and delivers it with Keycloak's sender, then asks for it
 * to be checked. Confirming a new address: the patient BFF (scope `identity.email.patient`), for
 * the person of her session. No answer ever says whether an address is known.
 */
export function registerEmailRoutes(app: FastifyInstance, deps: EmailRouteDeps): void {
  const kc = 'identity.email_code.keycloak';
  const patient = 'identity.email.patient';

  app.post(
    '/internal/v1/email-codes/sign-in',
    {
      config: { access: access(kc, 'identity.email_code.sign_in') },
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['address', 'source_ip'],
          properties: { address: EMAIL, source_ip: IP },
        },
      },
    },
    async (request) => {
      const { address, source_ip } = request.body as { address: string; source_ip: string };
      const d = await deps.store.issueSignIn(address, source_ip, audit(request.id));
      // To Keycloak only, which sends it; never to a browser.
      return { request_id: d.requestId, deliver: d.deliver };
    },
  );

  app.post(
    '/internal/v1/email-codes/sign-in/verify',
    {
      config: { access: access(kc, 'identity.email_code.verify') },
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['request_id', 'code'],
          properties: { request_id: { type: 'string', pattern: UUID }, code: CODE },
        },
      },
    },
    async (request) => {
      const { request_id, code } = request.body as { request_id: string; code: string };
      const subject = await deps.store.verifySignIn(request_id, code, audit(request.id));
      if (!subject) throw new ProblemError(403, 'email_code.refused', 'Refused.');
      return { subject };
    },
  );

  app.post(
    '/internal/v1/email-codes/confirm',
    {
      config: { access: access(patient, 'identity.email_code.confirm') },
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['person_id', 'address', 'source_ip'],
          properties: {
            person_id: { type: 'string', pattern: UUID },
            address: EMAIL,
            source_ip: IP,
          },
        },
      },
    },
    async (request, reply) => {
      const b = request.body as { person_id: string; address: string; source_ip: string };
      if (!deps.sender) throw new ProblemError(503, 'email.unavailable', 'Email is not available.');
      const d = await deps.store.issueConfirm(
        b.person_id,
        b.address,
        b.source_ip,
        audit(request.id),
      );
      if (d.deliver && !(await deps.sender.send(d.deliver.to, d.deliver.code, 'confirm')))
        throw new ProblemError(503, 'email.unavailable', 'Email is not available.');
      // A limited request looks the same: she simply receives nothing.
      return reply.code(202).send({ request_id: d.requestId });
    },
  );

  app.post(
    '/internal/v1/email-codes/confirm/verify',
    {
      config: { access: access(patient, 'identity.email_code.confirm_verify') },
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['person_id', 'request_id', 'code'],
          properties: {
            person_id: { type: 'string', pattern: UUID },
            request_id: { type: 'string', pattern: UUID },
            code: CODE,
          },
        },
      },
    },
    async (request, reply) => {
      const b = request.body as { person_id: string; request_id: string; code: string };
      if (!(await deps.store.verifyConfirm(b.person_id, b.request_id, b.code, audit(request.id))))
        throw new ProblemError(403, 'email_code.refused', 'Refused.');
      return reply.code(204).send();
    },
  );
}

import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { ReminderStore } from '@endo/clinical-store';
import type { FieldCipher } from '@endo/crypto';
import { uuidv7 } from '@endo/domain';
import { ProblemError } from '@endo/service-kit';
import { endpointHash, isAllowedPushEndpoint, localTime } from '../reminders.ts';

/**
 * Her weekly reminder (spec 15, 21.7 screen 9): she turns it on on a device (its push endpoint,
 * stored encrypted under her own key) with her hour and time zone, and turns it off. The endpoint
 * is never logged or echoed.
 */
export function registerReminderRoutes(
  app: FastifyInstance,
  deps: { readonly reminders: ReminderStore; readonly cipherFor: (orgId: string) => FieldCipher },
): void {
  const own = (request: FastifyRequest) => {
    const patientId = request.subject?.patientId;
    const orgId = request.subject?.orgId;
    if (!patientId || !orgId) throw new ProblemError(403, 'authz.not_own_resource', 'Not allowed.');
    return { patientId, orgId };
  };
  const policy = {
    kind: 'protected',
    action: 'reminders.manage_own',
    resourceType: 'push_subscription',
    purpose: 'patient_request',
    resource: (_r: FastifyRequest, s: { orgId: string | null; patientId: string | null }) => ({
      type: 'push_subscription',
      id: null,
      orgId: s.orgId,
      patientId: s.patientId,
    }),
  } as const;
  const refused = () =>
    new ProblemError(
      422,
      'reminder.endpoint_refused',
      'Reminders are not available on this device.',
    );

  app.post(
    '/v1/me/push-subscriptions',
    {
      config: { policy },
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['endpoint', 'time_zone'],
          properties: {
            endpoint: { type: 'string', maxLength: 2048 },
            remind_hour: { type: 'integer', minimum: 8, maximum: 20 },
            time_zone: { type: 'string', maxLength: 64 },
          },
        },
      },
    },
    async (request, reply) => {
      const { patientId, orgId } = own(request);
      const b = request.body as { endpoint: string; remind_hour?: number; time_zone: string };
      if (!isAllowedPushEndpoint(b.endpoint)) throw refused();
      try {
        localTime(new Date(), b.time_zone);
      } catch {
        throw new ProblemError(422, 'reminder.invalid_time_zone', 'Check your time zone.');
      }
      const id = uuidv7();
      await deps.reminders.subscribe({
        id,
        orgId,
        patientId,
        endpointEncrypted: await deps
          .cipherFor(orgId)
          .encrypt(b.endpoint, { patientId, field: 'push_subscription.endpoint', recordId: id }),
        endpointHash: endpointHash(b.endpoint),
        remindHour: b.remind_hour ?? 18,
        timeZone: b.time_zone,
      });
      return reply.code(201).send({ subscribed: true, remind_hour: b.remind_hour ?? 18 });
    },
  );

  app.post(
    '/v1/me/push-subscriptions/remove',
    {
      config: { policy },
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          properties: { endpoint: { type: 'string', maxLength: 2048 } },
        },
      },
    },
    async (request) => {
      const { patientId, orgId } = own(request);
      const b = request.body as { endpoint?: string };
      const removed = await deps.reminders.unsubscribe(
        orgId,
        patientId,
        b.endpoint === undefined ? null : endpointHash(b.endpoint),
      );
      return { removed };
    },
  );
}

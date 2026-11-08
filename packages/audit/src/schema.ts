import { z } from 'zod';
import { ROLES } from '@endo/domain';

/** First `prev_hash` in a chain. */
export const GENESIS_HASH = '0'.repeat(64);

const uuid = z
  .string()
  .regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
const SEGMENT = /^[a-z][a-z0-9_]*$/;
/** Dotted lower-case codes only, e.g. `episode.read`. No spaces, so no room for free text. */
const code = z
  .string()
  .max(64)
  .refine((s) => s.split('.').every((seg) => SEGMENT.test(seg)), { message: 'not a code' });

export const AuditOutcome = z.enum(['success', 'denied', 'error']);

/** Purpose of use (spec 12.9). Aligned with the HL7 PurposeOfUse value set where possible. */
export const PurposeOfUse = z.enum([
  'treatment', // clinician care
  'patient_request', // the woman viewing or managing her own data
  'operations', // system jobs, e.g. verdict generation, retention
  'support', // GluCorp support under a JIT approval ticket
  'system_check', // health checks and smoke tests, no health data
]);

/**
 * What callers supply. Strict: unknown keys are rejected, and every field is either an opaque ID,
 * a fixed code or an enum. There is deliberately no field that can carry content (spec 12.9).
 */
export const AuditEventInput = z.strictObject({
  actor: z.strictObject({
    id: uuid.nullable(), // null for unauthenticated requests
    role: z.enum([...ROLES, 'anonymous', 'system']),
  }),
  action: code,
  resource: z.strictObject({
    type: code,
    id: uuid.nullable(),
  }),
  org_id: uuid.nullable(),
  purpose_of_use: PurposeOfUse,
  outcome: AuditOutcome,
  /** Machine reason code for denials and errors, e.g. `authz.no_consent`. Never a message. */
  reason: code.nullable(),
  request_id: uuid,
});
export type AuditEventInputType = z.infer<typeof AuditEventInput>;

/** A stored event: input plus identity, time and chain fields. */
export type AuditEvent = AuditEventInputType & {
  readonly id: string;
  readonly sequence: number;
  readonly occurred_at: string;
  readonly prev_hash: string;
  readonly hash: string;
};

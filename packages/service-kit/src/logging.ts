import type { FastifyServerOptions } from 'fastify';

/**
 * Structured log allowlist (spec 20, RISK-I02). Anything not listed is dropped before it is
 * written. Add a field only after confirming it can never contain PHI; opaque IDs only.
 */
export const LOG_FIELD_ALLOWLIST = new Set([
  'service',
  'event',
  'reqId',
  'method',
  'route',
  'statusCode',
  'durationMs',
  'errorCode',
  'errorName',
  'outcome',
]);

export function filterLogFields(obj: Record<string, unknown>): Record<string, unknown> {
  const out = new Map<string, unknown>();
  for (const [k, v] of Object.entries(obj)) {
    if (
      LOG_FIELD_ALLOWLIST.has(k) &&
      (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean')
    ) {
      // Values are short codes; cap length so nothing large slips through by accident.
      out.set(k, typeof v === 'string' ? v.slice(0, 128) : v);
    }
  }
  return Object.fromEntries(out);
}

/**
 * Fastify/pino options: the allowlist filter runs on every log object, so request, response and
 * error objects (non-scalar) are always dropped: URLs, headers and messages are never logged.
 * No hostname or pid.
 */
export function loggerOptions(
  service: string,
  level: string,
  stream?: { write(msg: string): void },
): NonNullable<FastifyServerOptions['logger']> {
  return {
    level,
    base: { service },
    messageKey: 'event',
    formatters: {
      bindings: (b: Record<string, unknown>) => filterLogFields(b),
      log: (o: Record<string, unknown>) => filterLogFields(o),
    },
    ...(stream ? { stream } : {}),
  };
}

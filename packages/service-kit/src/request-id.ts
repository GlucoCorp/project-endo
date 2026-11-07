import { isUuid, uuidv7 } from '@endo/domain';

/**
 * Request ID for logs, audit and problem details. An incoming `x-request-id` is accepted only from
 * internal callers and only if it is a UUID; otherwise a new UUIDv7 is generated.
 */
export function requestIdFrom(header: string | string[] | undefined, trustHeader: boolean): string {
  if (trustHeader && typeof header === 'string' && isUuid(header)) return header;
  return uuidv7();
}

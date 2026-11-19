import { createHash, createPublicKey, type JsonWebKey } from 'node:crypto';
import { SignJWT, importJWK } from 'jose';
import type { ReminderEpisode, ReminderStore } from '@endo/clinical-store';
import type { FieldCipher } from '@endo/crypto';

/**
 * Weekly check-in reminders by Web Push (spec 15; Section 24 item 28). The push carries no
 * payload: the service worker shows fixed, generic text ("Your weekly check-in is ready.") and
 * opens the app, which needs sign-in. Nothing about her, her treatment or her clinic travels.
 *
 * - Endpoints are accepted only for known push services, over HTTPS (no request to an address
 *   she, or an attacker, chose), stored encrypted under her own key and never logged.
 * - Sent at her chosen hour in her time zone (8:00 to 20:00, so never in quiet hours), once per
 *   open week, claimed in the database before sending so replicas never send twice.
 * - A push service saying the subscription is gone (404 or 410) removes it.
 * - Accepted by the push service is not delivered: nothing claims she saw it.
 */
const PUSH_HOSTS = [
  'fcm.googleapis.com',
  'updates.push.services.mozilla.com',
  'web.push.apple.com',
] as const;
const PUSH_HOST_SUFFIXES = ['.notify.windows.com', '.push.apple.com'] as const;

export function isAllowedPushEndpoint(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.port) return false;
  const host = url.hostname.toLowerCase();
  return (
    (PUSH_HOSTS as readonly string[]).includes(host) ||
    PUSH_HOST_SUFFIXES.some((s) => host.endsWith(s) && host.length > s.length)
  );
}

export const endpointHash = (endpoint: string) =>
  createHash('sha256').update(`endo-push-endpoint-v1\n${endpoint}`).digest('hex');

export interface VapidConfig {
  /** P-256 private key (JWK) for the VAPID signature (RFC 8292). */
  readonly privateJwk: JsonWebKey;
  /** Operator contact for push services: an https URL or mailto, never a person's address. */
  readonly subject: string;
}

/** The uncompressed P-256 public key (base64url) that browsers subscribe with. */
export function vapidPublicKey(privateJwk: JsonWebKey): string {
  const pub = createPublicKey({ key: privateJwk, format: 'jwk' }).export({ format: 'jwk' });
  const x = Buffer.from(pub.x ?? '', 'base64url');
  const y = Buffer.from(pub.y ?? '', 'base64url');
  return Buffer.concat([Buffer.from([4]), x, y]).toString('base64url');
}

/** `Authorization: vapid t=…, k=…` for one endpoint (audience = its origin; 12-hour expiry). */
export async function vapidAuthorization(endpoint: string, config: VapidConfig, now: Date) {
  const key = await importJWK(config.privateJwk, 'ES256');
  const token = await new SignJWT({})
    .setProtectedHeader({ alg: 'ES256', typ: 'JWT' })
    .setAudience(new URL(endpoint).origin)
    .setSubject(config.subject)
    .setExpirationTime(Math.floor(now.getTime() / 1000) + 12 * 3600)
    .sign(key);
  return `vapid t=${token}, k=${vapidPublicKey(config.privateJwk)}`;
}

const addDays = (date: string, days: number) =>
  new Date(Date.parse(`${date}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);

/** Her local date and hour in a time zone. */
export function localTime(now: Date, timeZone: string): { date: string; hour: number } {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(now);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  return { date: `${get('year')}-${get('month')}-${get('day')}`, hour: Number(get('hour')) };
}

/** The first week she can complete today that is neither done nor reminded (REQ-003 window). */
export function weekToRemind(e: ReminderEpisode, today: string): number | null {
  for (let k = 1; k <= e.reviewIntervalWeeks; k++) {
    const weekEnd = addDays(e.startDate, k * 7);
    const open = today >= addDays(weekEnd, -1) && today < addDays(weekEnd, 7);
    if (open && !e.doneWeeks.includes(k) && !e.remindedWeeks.includes(k)) return k;
  }
  return null;
}

export interface ReminderRun {
  readonly sent: number;
  readonly removed: number;
  readonly failed: number;
}

export class ReminderService {
  readonly #store: ReminderStore;
  readonly #cipherFor: (orgId: string) => FieldCipher;
  readonly #vapid: VapidConfig;
  readonly #fetch: typeof fetch;
  readonly #now: () => Date;

  constructor(
    store: ReminderStore,
    cipherFor: (orgId: string) => FieldCipher,
    vapid: VapidConfig,
    fetchImpl: typeof fetch,
    now: () => Date,
  ) {
    this.#store = store;
    this.#cipherFor = cipherFor;
    this.#vapid = vapid;
    this.#fetch = fetchImpl;
    this.#now = now;
  }

  async run(): Promise<ReminderRun> {
    const now = this.#now();
    let sent = 0;
    let removed = 0;
    let failed = 0;
    for (const orgId of await this.#store.orgs()) {
      for (const sub of await this.#store.subscriptions(orgId)) {
        const local = localTime(now, sub.timeZone);
        if (local.hour !== sub.remindHour) continue;
        const due = (await this.#store.episodes(orgId, sub.patientId))
          .map((e) => ({ e, week: weekToRemind(e, local.date) }))
          .find((x) => x.week !== null);
        if (!due || due.week === null) continue;
        if (!(await this.#store.claim(orgId, sub.patientId, due.e.episodeId, due.week))) continue;
        const endpoint = await this.#cipherFor(orgId)
          .decrypt(sub.endpointEncrypted, {
            patientId: sub.patientId,
            field: 'push_subscription.endpoint',
            recordId: sub.id,
          })
          .catch(() => null);
        if (!endpoint || !isAllowedPushEndpoint(endpoint)) {
          await this.#store.remove(orgId, sub.id);
          removed++;
          continue;
        }
        try {
          const res = await this.#fetch(endpoint, {
            method: 'POST',
            headers: {
              authorization: await vapidAuthorization(endpoint, this.#vapid, now),
              ttl: '86400',
              urgency: 'normal',
              'content-length': '0',
            },
            redirect: 'error',
            signal: AbortSignal.timeout(10_000),
          });
          if (res.status === 404 || res.status === 410) {
            await this.#store.remove(orgId, sub.id);
            removed++;
          } else if (res.ok) sent++;
          else failed++;
        } catch {
          failed++;
        }
      }
    }
    return { sent, removed, failed };
  }
}

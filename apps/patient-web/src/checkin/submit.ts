import { redFlagKeyFor } from '@endo/domain';
import { paths, send, type SendResult } from './api.ts';
import type { OfflineQueue, QueueItem } from './queue.ts';

/**
 * Sending her week (REQ-003, REQ-007). Red flags go first, on their own, under a key derived from
 * the check-in's key, so the server records them once even if the check-in also carries them, and
 * even if the check-in is later refused. Anything that cannot be sent now is queued, encrypted,
 * and sent when she is back online and signed in.
 */
export type WeekOutcome =
  | { readonly kind: 'saved'; readonly openWeeks: readonly number[] }
  | { readonly kind: 'queued' }
  | { readonly kind: 'refused'; readonly code: string }
  | { readonly kind: 'signed-out' };

const sendItem = (fetchFn: typeof fetch) => (item: QueueItem) =>
  send(fetchFn, item.url, item.key, item.body);

/** Reports red flags as soon as she has answered them (before the rest of the check-in). */
export async function reportRedFlags(
  fetchFn: typeof fetch,
  queue: OfflineQueue,
  episodeId: string,
  checkInKey: string,
  flags: readonly string[],
  shownAt: Date,
  acknowledgedAt: Date | null,
): Promise<SendResult['kind'] | 'queued'> {
  const set = [...new Set(flags)].sort();
  const item: QueueItem = {
    kind: 'red_flags',
    url: paths.redFlags(episodeId),
    // Same derivation as the server's: the check-in key and this set of flags.
    key: await redFlagKeyFor(checkInKey, set),
    body: {
      flags: set,
      shown_at: shownAt.toISOString(),
      ...(acknowledgedAt ? { acknowledged_at: acknowledgedAt.toISOString() } : {}),
    },
    createdAt: new Date().toISOString(),
  };
  const r = await sendItem(fetchFn)(item);
  if (r.kind === 'offline' || r.kind === 'signed-out') {
    await queue.add(item);
    return 'queued';
  }
  return r.kind;
}

export async function submitWeek(
  fetchFn: typeof fetch,
  queue: OfflineQueue,
  episodeId: string,
  checkInKey: string,
  weekIndex: number,
  answers: Readonly<Record<string, unknown>>,
  redFlagsShownAt: Date | null,
): Promise<WeekOutcome> {
  const item: QueueItem = {
    kind: 'checkin',
    url: paths.checkIn(episodeId),
    key: checkInKey,
    body: {
      week_index: weekIndex,
      answers,
      client_created_at: new Date().toISOString(),
      ...(redFlagsShownAt ? { red_flags_shown_at: redFlagsShownAt.toISOString() } : {}),
    },
    createdAt: new Date().toISOString(),
  };
  // Anything queued earlier goes first, red flags first of all.
  await queue.drain(sendItem(fetchFn));
  const r = await sendItem(fetchFn)(item);
  switch (r.kind) {
    case 'ok':
      return {
        kind: 'saved',
        openWeeks: Array.isArray(r.body['open_weeks']) ? (r.body['open_weeks'] as number[]) : [],
      };
    case 'refused':
      return { kind: 'refused', code: r.code };
    case 'signed-out':
      await queue.add(item);
      return { kind: 'signed-out' };
    case 'offline':
      await queue.add(item);
      return { kind: 'queued' };
  }
}

/** Sends whatever is queued (on load, when back online). */
export function flush(fetchFn: typeof fetch, queue: OfflineQueue) {
  return queue.drain(sendItem(fetchFn));
}

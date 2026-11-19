/**
 * Her weekly reminder on this device (spec 15, 21.7 screen 9). The push carries no content: the
 * service worker shows "Your weekly check-in is ready." Turning it on asks the browser for
 * permission, subscribes with the server's VAPID key, and sends only the endpoint, her hour and
 * her time zone.
 */
export type ReminderResult = 'on' | 'off' | 'denied' | 'unsupported' | 'error';

export interface PushApi {
  readonly permission: () => Promise<NotificationPermission>;
  readonly subscribe: (
    key: Uint8Array<ArrayBuffer>,
  ) => Promise<{ endpoint: string; unsubscribe(): Promise<boolean> }>;
  readonly current: () => Promise<{ endpoint: string; unsubscribe(): Promise<boolean> } | null>;
}

export function decodeKey(base64url: string): Uint8Array<ArrayBuffer> {
  const b64 = base64url.replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

const post = (fetchFn: typeof fetch, url: string, body: unknown) =>
  fetchFn(url, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json', 'idempotency-key': crypto.randomUUID() },
    body: JSON.stringify(body),
  });

export async function turnOn(
  fetchFn: typeof fetch,
  push: PushApi | null,
  vapidKey: string | null,
  hour: number,
  timeZone: string,
): Promise<ReminderResult> {
  if (!push || !vapidKey) return 'unsupported';
  try {
    if ((await push.permission()) !== 'granted') return 'denied';
    const sub = await push.subscribe(decodeKey(vapidKey));
    const res = await post(fetchFn, '/v1/me/push-subscriptions', {
      endpoint: sub.endpoint,
      remind_hour: hour,
      time_zone: timeZone,
    });
    if (res.ok) return 'on';
    await sub.unsubscribe();
    return res.status === 422 ? 'unsupported' : 'error';
  } catch {
    return 'error';
  }
}

export async function turnOff(
  fetchFn: typeof fetch,
  push: PushApi | null,
): Promise<ReminderResult> {
  try {
    const sub = push ? await push.current() : null;
    const res = await post(
      fetchFn,
      '/v1/me/push-subscriptions/remove',
      sub ? { endpoint: sub.endpoint } : {},
    );
    if (sub) await sub.unsubscribe();
    return res.ok ? 'off' : 'error';
  } catch {
    return 'error';
  }
}

export async function isOn(push: PushApi | null): Promise<boolean> {
  try {
    return push ? (await push.current()) !== null : false;
  } catch {
    return false;
  }
}

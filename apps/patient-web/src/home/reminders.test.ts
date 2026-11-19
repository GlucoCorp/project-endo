import { describe, expect, it } from 'vitest';
import { decodeKey, isOn, turnOff, turnOn } from './reminders.ts';

const KEY = Buffer.from(new Uint8Array(65).fill(4)).toString('base64url');
const ENDPOINT = 'https://fcm.googleapis.com/fcm/send/x';

function fakePush(permission: NotificationPermission = 'granted', current = false) {
  const state = { unsubscribed: 0, subscribedWith: null as Uint8Array | null };
  const sub = {
    endpoint: ENDPOINT,
    unsubscribe: () => {
      state.unsubscribed++;
      return Promise.resolve(true);
    },
  };
  return {
    state,
    push: {
      permission: () => Promise.resolve(permission),
      subscribe: (k: Uint8Array<ArrayBuffer>) => {
        state.subscribedWith = k;
        return Promise.resolve(sub);
      },
      current: () => Promise.resolve(current ? sub : null),
    },
  };
}
function fakeFetch(status: number | Error) {
  const calls: { url: string; body: unknown }[] = [];
  const f = ((url: string, init: RequestInit) => {
    calls.push({ url, body: JSON.parse(init.body as string) as unknown });
    return status instanceof Error
      ? Promise.reject(status)
      : Promise.resolve(new Response('{}', { status }));
  }) as unknown as typeof fetch;
  return { f, calls };
}

describe('spec 15 weekly reminder on this device', () => {
  it('decodes the VAPID key', () => {
    expect(decodeKey(KEY)).toHaveLength(65);
    expect(decodeKey('AQ')).toEqual(new Uint8Array([1]));
  });

  it('asks permission, subscribes with the key, and sends only endpoint, hour and time zone', async () => {
    const { push, state } = fakePush();
    const { f, calls } = fakeFetch(201);
    expect(await turnOn(f, push, KEY, 19, 'Africa/Nairobi')).toBe('on');
    expect(state.subscribedWith).toHaveLength(65);
    expect(calls[0]).toEqual({
      url: '/v1/me/push-subscriptions',
      body: { endpoint: ENDPOINT, remind_hour: 19, time_zone: 'Africa/Nairobi' },
    });
  });

  it('reports denied, unsupported and errors; undoes a subscription the server refused', async () => {
    expect(await turnOn(fakeFetch(201).f, null, KEY, 18, 'UTC')).toBe('unsupported');
    expect(await turnOn(fakeFetch(201).f, fakePush().push, null, 18, 'UTC')).toBe('unsupported');
    expect(await turnOn(fakeFetch(201).f, fakePush('denied').push, KEY, 18, 'UTC')).toBe('denied');
    const refused = fakePush();
    expect(await turnOn(fakeFetch(422).f, refused.push, KEY, 18, 'UTC')).toBe('unsupported');
    expect(refused.state.unsubscribed).toBe(1);
    expect(await turnOn(fakeFetch(500).f, fakePush().push, KEY, 18, 'UTC')).toBe('error');
    expect(await turnOn(fakeFetch(new TypeError('x')).f, fakePush().push, KEY, 18, 'UTC')).toBe(
      'error',
    );
  });

  it('turns off on the server and in the browser; knows whether it is on', async () => {
    const on = fakePush('granted', true);
    const { f, calls } = fakeFetch(200);
    expect(await turnOff(f, on.push)).toBe('off');
    expect(calls[0]).toEqual({
      url: '/v1/me/push-subscriptions/remove',
      body: { endpoint: ENDPOINT },
    });
    expect(on.state.unsubscribed).toBe(1);
    expect(await turnOff(fakeFetch(200).f, null)).toBe('off');
    expect(await turnOff(fakeFetch(500).f, null)).toBe('error');
    expect(await turnOff(fakeFetch(new TypeError('x')).f, null)).toBe('error');
    expect(await isOn(on.push)).toBe(true);
    expect(await isOn(fakePush().push)).toBe(false);
    expect(await isOn(null)).toBe(false);
    expect(await isOn({ ...fakePush().push, current: () => Promise.reject(new Error('x')) })).toBe(
      false,
    );
  });
});

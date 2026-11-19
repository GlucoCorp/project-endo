import type { PushApi } from './reminders.ts';

/**
 * The browser's push API (spec 15). Covered by the browser tests, like idb.ts: the unit-test
 * runtime has no service worker or PushManager.
 */
/** The push API, or null where it is missing (then reminders are unavailable). */
export function browserPush(): PushApi | null {
  if (!('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window))
    return null;
  const registration = () => navigator.serviceWorker.ready;
  return {
    permission: () => Notification.requestPermission(),
    subscribe: async (key) =>
      (await registration()).pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: key,
      }),
    current: async () => (await registration()).pushManager.getSubscription(),
  };
}

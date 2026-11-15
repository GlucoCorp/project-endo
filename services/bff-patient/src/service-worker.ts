import type { FastifyInstance } from 'fastify';

/**
 * The patient app's service worker (spec 14), served from this origin at `/sw.js` so its scope is
 * the whole app.
 *
 * - Caches the app shell only: the page and its hashed assets, so the check-in, the urgent-care
 *   screen and the emergency number work offline. Never `/v1/` or `/auth/` responses (PHI).
 * - A Web Push carries no payload (Section 24 item 28): the notification text is fixed and
 *   generic, with no name, condition, treatment or clinic, and opening it opens the app, which
 *   needs sign-in.
 */
export const SERVICE_WORKER = `'use strict';
const CACHE = 'endo-shell-v1';
self.addEventListener('install', (e) => {
  self.skipWaiting();
  e.waitUntil(caches.open(CACHE).then((c) => c.add('/')).catch(() => undefined));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/v1/') || url.pathname.startsWith('/auth/')) return;
  if (e.request.mode === 'navigate') {
    e.respondWith(
      fetch(e.request)
        .then((r) => {
          if (r.ok) {
            const copy = r.clone();
            caches.open(CACHE).then((c) => c.put('/', copy));
          }
          return r;
        })
        .catch(() => caches.match('/').then((m) => m || Response.error())),
    );
    return;
  }
  if (url.pathname.startsWith('/assets/')) {
    e.respondWith(
      caches.match(e.request).then(
        (m) =>
          m ||
          fetch(e.request).then((r) => {
            if (r.ok) {
              const copy = r.clone();
              caches.open(CACHE).then((c) => c.put(e.request, copy));
            }
            return r;
          }),
      ),
    );
  }
});
self.addEventListener('push', (e) => {
  e.waitUntil(
    self.registration.showNotification('Weekly check-in', {
      body: 'Your weekly check-in is ready.',
      tag: 'endo-checkin',
    }),
  );
});
self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  e.waitUntil(self.clients.openWindow('/'));
});
`;

export function registerServiceWorker(app: FastifyInstance): void {
  app.get('/sw.js', { config: { auth: { kind: 'public', reason: 'app-shell' } } }, (_req, reply) =>
    reply
      .type('text/javascript; charset=utf-8')
      .header('cache-control', 'no-cache')
      .header('service-worker-allowed', '/')
      .header('content-security-policy', "default-src 'self'")
      .send(SERVICE_WORKER),
  );
}

/**
 * What the app needs before she is signed in, and keeps for offline use: the local emergency
 * number for the urgent-care screen (REQ-007), configured per deployment (region). Null when not
 * configured: the screen then says to call the local emergency number, and never guesses one.
 */
export function registerAppConfig(app: FastifyInstance, emergencyNumber: string | null): void {
  app.get(
    '/v1/app-config',
    { config: { auth: { kind: 'public', reason: 'app-shell' } } },
    (_r, reply) =>
      reply.header('cache-control', 'no-store').send({ emergency_number: emergencyNumber }),
  );
}

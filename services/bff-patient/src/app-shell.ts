import type { FastifyInstance } from 'fastify';
import { registerAppShell as register, type AppShell } from '@endo/service-kit';

export { loadAppShell, type AppShell } from '@endo/service-kit';

/** The patient app's page paths (its router's routes). Anything else is not the app. */
export const APP_PATHS = ['/', '/enrol', '/history', '/shared', '/my-data'] as const;

/** Serves the patient app (`@endo/service-kit` app shell) on its page paths, rate limited. */
export function registerAppShell(app: FastifyInstance, shell: AppShell): void {
  register(app, shell, {
    paths: APP_PATHS,
    config: { auth: { kind: 'public', reason: 'app-shell' } },
  });
}

import { Outlet, createRootRoute, createRoute, createRouter } from '@tanstack/react-router';
import { EnrolPage } from './enrol/EnrolPage.tsx';
import { t } from './i18n.ts';
import { QuickExit } from './QuickExit.tsx';

const root = createRootRoute({
  component: () => (
    <>
      <QuickExit />
      <Outlet />
    </>
  ),
});

/** Until sign-in exists (ADR-0021 slice 4), the only way in is an enrolment link. */
const home = createRoute({
  getParentRoute: () => root,
  path: '/',
  component: () => (
    <main>
      <p>{t('enrol.no-link')}</p>
    </main>
  ),
});

const enrol = createRoute({ getParentRoute: () => root, path: '/enrol', component: EnrolPage });

export const router = createRouter({ routeTree: root.addChildren([home, enrol]) });

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router;
  }
}

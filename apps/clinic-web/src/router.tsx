import { Outlet, createRootRoute, createRoute, createRouter } from '@tanstack/react-router';
import { PortalPage } from './portal/PortalPage.tsx';

const root = createRootRoute({ component: () => <Outlet /> });
const home = createRoute({ getParentRoute: () => root, path: '/', component: PortalPage });
const enrolments = createRoute({
  getParentRoute: () => root,
  path: '/enrolments',
  component: PortalPage,
});

export const router = createRouter({ routeTree: root.addChildren([home, enrolments]) });

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router;
  }
}

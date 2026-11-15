import { Outlet, createRootRoute, createRoute, createRouter } from '@tanstack/react-router';
import { DeskPage } from './desk/DeskPage.tsx';
import { PortalPage } from './portal/PortalPage.tsx';
import { AdminPage } from './admin/AdminPage.tsx';

const root = createRootRoute({ component: () => <Outlet /> });
const home = createRoute({ getParentRoute: () => root, path: '/', component: PortalPage });
const enrolments = createRoute({
  getParentRoute: () => root,
  path: '/enrolments',
  component: PortalPage,
});

const reviews = createRoute({ getParentRoute: () => root, path: '/reviews', component: DeskPage });
const admin = createRoute({ getParentRoute: () => root, path: '/admin', component: AdminPage });

export const router = createRouter({
  routeTree: root.addChildren([home, enrolments, reviews, admin]),
});

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router;
  }
}

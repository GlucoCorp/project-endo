import { Outlet, createRootRoute, createRoute, createRouter } from '@tanstack/react-router';
import { EnrolPage } from './enrol/EnrolPage.tsx';
import { HomePage } from './home/HomePage.tsx';
import { QuickExit } from './QuickExit.tsx';

const root = createRootRoute({
  component: () => (
    <>
      <QuickExit />
      <Outlet />
    </>
  ),
});

const home = createRoute({ getParentRoute: () => root, path: '/', component: HomePage });

const enrol = createRoute({ getParentRoute: () => root, path: '/enrol', component: EnrolPage });

export const router = createRouter({ routeTree: root.addChildren([home, enrol]) });

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router;
  }
}

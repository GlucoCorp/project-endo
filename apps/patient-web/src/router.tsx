import { Outlet, createRootRoute, createRoute, createRouter } from '@tanstack/react-router';
import { EnrolPage } from './enrol/EnrolPage.tsx';
import { HomePage } from './home/HomePage.tsx';
import { HistoryPage } from './history/HistoryPage.tsx';
import { SharedPage } from './history/SharedPage.tsx';
import { DataPage } from './data/DataPage.tsx';
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
const historyRoute = createRoute({
  getParentRoute: () => root,
  path: '/history',
  component: HistoryPage,
});
const shared = createRoute({ getParentRoute: () => root, path: '/shared', component: SharedPage });
const data = createRoute({ getParentRoute: () => root, path: '/my-data', component: DataPage });

export const router = createRouter({
  routeTree: root.addChildren([home, enrol, historyRoute, shared, data]),
});

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router;
  }
}

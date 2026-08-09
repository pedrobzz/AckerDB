/**
 * Studio's routes, and the one rule that shapes them.
 *
 * **Every screen is its own route under the shell, and the gate wraps the
 * shell.** So a URL names a screen whether or not the tab holding it has a
 * credential yet: an operator following a link signs in and arrives where the
 * link pointed, rather than at a connect page that forgets it. This is the same
 * property filters will need when they become search parameters — the address
 * bar is the state, so a screen can be sent to someone else.
 *
 * The routes are written out one per screen rather than generated from
 * {@link SCREENS}. A route built inside a loop has `path: string`, which erases
 * the very typing that makes `<Link to="/logs">` a checked fact and makes a
 * typed `validateSearch` possible on the screens that grow one. The cost is a
 * literal repeated in two places, and `test/app/shell/screens.check.ts` is what
 * turns that from a convention into a compile error.
 */
import { createRootRoute, createRoute, createRouter } from "@tanstack/react-router";
import { STUDIO_PATH_PREFIX } from "../origin.ts";
import { ConnectGate } from "./connect/gate.tsx";
import { PendingScreen } from "./shell/screen.tsx";
import { Shell } from "./shell/shell.tsx";
import { StudioLanding } from "./shell/landing.tsx";

const rootRoute = createRootRoute({
  component: () => (
    <ConnectGate>
      <Shell />
    </ConnectGate>
  ),
});

const landingRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/",
  component: StudioLanding,
});

const logsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/logs",
  component: () => <PendingScreen screen="logs" />,
});

const tracesRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/traces",
  component: () => <PendingScreen screen="traces" />,
});

const errorsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/errors",
  component: () => <PendingScreen screen="errors" />,
});

const analyticsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/analytics",
  component: () => <PendingScreen screen="analytics" />,
});

const healthRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/health",
  component: () => <PendingScreen screen="health" />,
});

const dataRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/data",
  component: () => <PendingScreen screen="data" />,
});

const jobsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/jobs",
  component: () => <PendingScreen screen="jobs" />,
});

const filesRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/files",
  component: () => <PendingScreen screen="files" />,
});

const realtimeRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/realtime",
  component: () => <PendingScreen screen="realtime" />,
});

const functionsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/functions",
  component: () => <PendingScreen screen="functions" />,
});

export const routeTree = rootRoute.addChildren([
  landingRoute,
  logsRoute,
  tracesRoute,
  errorsRoute,
  analyticsRoute,
  healthRoute,
  dataRoute,
  jobsRoute,
  filesRoute,
  realtimeRoute,
  functionsRoute,
]);

/**
 * The router's basepath is the prefix the launcher serves the shell under, so a
 * client-side route and the path the browser shows are the same string.
 */
export function createStudioRouter() {
  return createRouter({ routeTree, basepath: STUDIO_PATH_PREFIX });
}

declare module "@tanstack/react-router" {
  interface Register {
    router: ReturnType<typeof createStudioRouter>;
  }
}

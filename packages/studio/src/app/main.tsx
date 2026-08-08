/**
 * The Studio SPA entry.
 *
 * Two bindings to the launcher, both derived from one constant. The router's
 * basepath is {@link STUDIO_PATH_PREFIX}, the same prefix the launcher serves
 * the shell under, so a client-side route and the path the browser shows are
 * the same string. And the client's `url` is the page's own origin, because
 * `acker studio` proxies the application onto it — Studio never learns, stores,
 * or is told an application URL, which is what leaves the credential with
 * exactly one place it can be sent.
 *
 * The provider takes a credential *source*, not a credential; see
 * `credential.ts` for why that distinction is the difference between a rotation
 * and a reconnect.
 */
import { AckerDBProvider, type AckerDBProviderConfig } from "@ackerdb/client-react";
import {
  RouterProvider,
  createRootRoute,
  createRoute,
  createRouter,
} from "@tanstack/react-router";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { STUDIO_PATH_PREFIX } from "../origin.ts";
import { ConnectScreen } from "./connect.tsx";
import { studioCredential } from "./credential.ts";

const rootRoute = createRootRoute();
const connectRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/",
  component: ConnectScreen,
});

const router = createRouter({
  routeTree: rootRoute.addChildren([connectRoute]),
  basepath: STUDIO_PATH_PREFIX,
});

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}

const config: AckerDBProviderConfig = {
  url: window.location.origin,
  credentialSource: studioCredential.source,
};

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <AckerDBProvider config={config}>
      <RouterProvider router={router} />
    </AckerDBProvider>
  </StrictMode>,
);

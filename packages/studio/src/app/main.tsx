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
import { RouterProvider } from "@tanstack/react-router";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { studioCredential } from "./credential.ts";
import { createStudioRouter } from "./routes.tsx";
import "./theme.css";

const router = createStudioRouter();

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

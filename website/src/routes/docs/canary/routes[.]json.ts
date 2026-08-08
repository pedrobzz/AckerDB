import { createFileRoute } from "@tanstack/react-router";
import { canaryIdentity } from "@/lib/documentation/release";
import { routeManifestFor } from "@/lib/documentation/tree";

export const Route = createFileRoute("/docs/canary/routes.json")({
  server: {
    handlers: {
      GET: () => Response.json(routeManifestFor(canaryIdentity(), import.meta.env.VITE_GIT_COMMIT)),
    },
  },
});

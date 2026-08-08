import { createFileRoute } from "@tanstack/react-router";
import { latestIdentity } from "@/lib/documentation/release";
import { routeManifestFor } from "@/lib/documentation/tree";

export const Route = createFileRoute("/docs/routes.json")({
  server: {
    handlers: {
      GET: () => Response.json(routeManifestFor(latestIdentity(), import.meta.env.VITE_GIT_COMMIT)),
    },
  },
});

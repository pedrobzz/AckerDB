import { createFileRoute, notFound } from "@tanstack/react-router";
import { identityForVersionId } from "@/lib/documentation/release";
import { routeManifestFor } from "@/lib/documentation/tree";

export const Route = createFileRoute("/docs/$version/routes.json")({
  server: {
    handlers: {
      GET: ({ params }) => {
        const identity = identityForVersionId(params.version);
        if (!identity || identity.kind !== "stable") throw notFound();
        return Response.json(routeManifestFor(identity, import.meta.env.VITE_GIT_COMMIT));
      },
    },
  },
});

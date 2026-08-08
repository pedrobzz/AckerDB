import { createFileRoute } from "@tanstack/react-router";
import { versionCatalog } from "@/lib/documentation/release";

export const Route = createFileRoute("/docs/versions.json")({
  server: {
    handlers: {
      GET: () =>
        Response.json(versionCatalog(), {
          headers: { "Cache-Control": "no-cache" },
        }),
    },
  },
});

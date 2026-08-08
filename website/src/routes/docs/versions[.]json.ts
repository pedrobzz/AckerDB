import { createFileRoute } from "@tanstack/react-router";
import { documentationVersionCatalog } from "@/lib/documentation/release";

export const Route = createFileRoute("/docs/versions.json")({
  server: {
    handlers: {
      GET: () =>
        Response.json(documentationVersionCatalog, {
          headers: { "Cache-Control": "no-cache" },
        }),
    },
  },
});

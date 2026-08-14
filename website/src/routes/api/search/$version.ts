import { createFileRoute, notFound } from "@tanstack/react-router";
import { identityForVersionId } from "@/lib/documentation/release";
import { searchApiFor } from "@/lib/documentation/search/search-api";

export const Route = createFileRoute("/api/search/$version")({
  server: {
    handlers: {
      GET: ({ params }) => {
        const identity = identityForVersionId(params.version);
        if (!identity) throw notFound();
        return searchApiFor(identity).staticGET();
      },
    },
  },
});

import { createFileRoute, notFound } from "@tanstack/react-router";
import { documentationLocation } from "@/lib/documentation/identity";
import { publishedIdentity } from "@/lib/documentation/release";
import { getMarkdown, source } from "@/lib/documentation/source";

export const Route = createFileRoute("/docs/{$}.md")({
  server: {
    handlers: {
      GET: async ({ params }) => {
        const segments = params._splat?.split("/").filter(Boolean) ?? [];
        if (segments.length > 0) {
          segments[segments.length - 1] = segments.at(-1)?.replace(/\.md$/, "") ?? "";
        }
        const location = documentationLocation(segments);
        const identity = publishedIdentity(location.identity);
        if (!identity) throw notFound();
        const slugs = location.slugs.at(-1) === "index" ? location.slugs.slice(0, -1) : location.slugs;
        const page = source.getPage(slugs);
        if (!page) throw notFound();

        return new Response(await getMarkdown(page, identity), {
          headers: { "Content-Type": "text/markdown; charset=utf-8" },
        });
      },
    },
  },
});

import { createFileRoute } from "@tanstack/react-router";
import { latestIdentity } from "@/lib/documentation/release";
import { getMarkdown, source } from "@/lib/documentation/source";

export const Route = createFileRoute("/llms-full.txt")({
  server: {
    handlers: {
      GET: async () => {
        const pages = await Promise.all(
          source.getPages().map((page) => getMarkdown(page, latestIdentity())),
        );
        return new Response(pages.join("\n\n---\n\n"), {
          headers: { "Content-Type": "text/plain; charset=utf-8" },
        });
      },
    },
  },
});

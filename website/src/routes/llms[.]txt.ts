import { createFileRoute } from "@tanstack/react-router";
import { llms } from "fumadocs-core/source";
import { source } from "@/lib/documentation/source";

function markdownPageLinks(index: string): string {
  return index.replaceAll(
    /\]\((\/docs(?:\/[^)#\s]*)?)(#[^)\s]+)?\)/g,
    (_link, path: string, hash: string | undefined) =>
      `](${path === "/docs" ? "/docs/index.md" : `${path}.md`}${hash ?? ""})`,
  );
}

export const Route = createFileRoute("/llms.txt")({
  server: {
    handlers: {
      GET: () =>
        new Response(markdownPageLinks(llms(source).index()), {
          headers: { "Content-Type": "text/plain; charset=utf-8" },
        }),
    },
  },
});

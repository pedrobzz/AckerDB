import { createFileRoute, Link, notFound } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { staticFunctionMiddleware } from "@tanstack/start-static-server-functions";
import { useFumadocsLoader } from "fumadocs-core/source/client";
import type * as PageTree from "fumadocs-core/page-tree";
import { Suspense, use } from "react";
import { DocumentationShell } from "@/components/documentation/documentation-shell";
import { getMdxComponents } from "@/components/mdx";
import { pageTreeFor, routeAncestryFor } from "@/lib/documentation/tree";
import {
  documentationLocation,
  documentationUrl,
  type DocumentationIdentity,
} from "@/lib/documentation/identity";
import {
  publishedIdentity,
  versionCatalog,
} from "@/lib/documentation/release";
import { docs, source } from "@/lib/documentation/source";

interface DocsSearch {
  unavailable?: string;
}

function markdownUrl(identity: DocumentationIdentity, slugs: string[]): string {
  if (slugs.length === 0) return `${identity.basePath}/index.md`;
  return `${identity.basePath}/${slugs.join("/")}.md`;
}

function githubReference(identity: DocumentationIdentity, commit: string): string {
  if (commit !== "working-tree") return commit;
  return identity.kind === "latest" ? "main" : "canary";
}

const loadDocumentationPage = createServerFn({ method: "GET" })
  .validator((segments: string[]) => segments)
  .middleware([staticFunctionMiddleware])
  .handler(async ({ data: segments }) => {
    const location = documentationLocation(segments);
    const identity = publishedIdentity(location.identity);
    if (!identity) throw notFound();
    const page = source.getPage(location.slugs);
    if (!page) throw notFound();

    const commit = import.meta.env.VITE_GIT_COMMIT || "working-tree";
    const currentUrl = documentationUrl(identity, page.slugs);
    const pageTree = pageTreeFor(identity);

    return {
      catalog: versionCatalog(),
      currentIdentity: identity,
      currentAncestry: routeAncestryFor(pageTree, currentUrl),
      currentUrl,
      description: page.data.description,
      githubUrl: `https://github.com/pedrobzz/ackerdb/edit/${githubReference(identity, commit)}/website/content/docs/${page.path}`,
      markdownUrl: markdownUrl(identity, page.slugs),
      pageTree: await source.serializePageTree(pageTree),
      path: page.path,
      title: page.data.title,
    };
  });

export const Route = createFileRoute("/docs/$")({
  beforeLoad: ({ params }) => {
    const segments = params._splat?.split("/").filter(Boolean) ?? [];
    if (!publishedIdentity(documentationLocation(segments).identity)) throw notFound();
  },
  validateSearch: (search: Record<string, unknown>): DocsSearch => ({
    unavailable: typeof search.unavailable === "string" ? search.unavailable : undefined,
  }),
  loader: async ({ params }) => {
    const segments = params._splat?.split("/").filter(Boolean) ?? [];
    const data = await loadDocumentationPage({ data: segments });
    await docs.getPage(data.path)?.preload();
    return data;
  },
  head: ({ loaderData }) => ({
    meta: loaderData
      ? [
          { title: `${loaderData.title} — AckerDB` },
          { name: "description", content: loaderData.description },
        ]
      : [],
    links: loaderData
      ? [{ rel: "canonical", href: `https://ackerdb.dev${loaderData.currentUrl}` }]
      : [],
  }),
  component: DocumentationPage,
});

type DocumentationLoaderData = Awaited<ReturnType<typeof loadDocumentationPage>>;
type DocumentationClientData = Omit<DocumentationLoaderData, "pageTree"> & {
  pageTree: PageTree.Root;
};

function DocumentationContent({
  catalog,
  currentIdentity,
  currentAncestry,
  currentUrl,
  description,
  githubUrl,
  markdownUrl: pageMarkdownUrl,
  pageTree,
  path,
  title,
  unavailableRoute,
}: DocumentationClientData & {
  unavailableRoute?: string;
}) {
  const page = docs.getPage(path);
  if (!page) throw new Error(`Unknown documentation page: ${path}`);

  const { toc } = use(page.load());
  const MDX = page.body;

  return (
    <DocumentationShell
      catalog={catalog}
      currentIdentity={currentIdentity}
      currentAncestry={currentAncestry}
      currentUrl={currentUrl}
      description={description}
      githubUrl={githubUrl}
      markdownUrl={pageMarkdownUrl}
      title={title}
      toc={toc}
      tree={pageTree}
      unavailableRoute={unavailableRoute}
    >
      <MDX components={getMdxComponents(undefined, currentIdentity)} />
    </DocumentationShell>
  );
}

function DocumentationPage() {
  const data = useFumadocsLoader(Route.useLoaderData());
  const { unavailable } = Route.useSearch();

  return (
    <>
      <Link hidden reloadDocument to={data.markdownUrl} />
      <Suspense>
        <DocumentationContent {...data} unavailableRoute={unavailable} />
      </Suspense>
    </>
  );
}

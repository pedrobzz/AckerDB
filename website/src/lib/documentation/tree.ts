import type * as PageTree from "fumadocs-core/page-tree";
import type {
  DocumentationIdentity,
  DocumentationRouteManifest,
} from "./identity";
import { contentRouteFromUrl } from "./identity";
import { source } from "./source";

function versionNode(node: PageTree.Node, identity: DocumentationIdentity): PageTree.Node {
  if (node.type === "page") {
    return {
      ...node,
      url: versionUrl(node.url, identity),
    };
  }

  if (node.type === "folder") {
    return {
      ...node,
      index: node.index
        ? {
            ...node.index,
            url: versionUrl(node.index.url, identity),
          }
        : undefined,
      children: node.children.map((child) => versionNode(child, identity)),
    };
  }

  return node;
}

function versionUrl(url: string, identity: DocumentationIdentity): string {
  if (!url.startsWith("/docs")) return url;
  return `${identity.basePath}${url.slice("/docs".length)}`;
}

export function pageTreeFor(identity: DocumentationIdentity): PageTree.Root {
  const tree = source.getPageTree();
  return {
    ...tree,
    children: tree.children.map((node) => versionNode(node, identity)),
  };
}

interface RouteEntry {
  route: string;
  ancestry: string[];
}

function folderIdentity(folder: PageTree.Folder, fallback: string): string {
  return folder.$id ?? folder.$ref?.folder ?? fallback;
}

function routeEntries(tree: PageTree.Root): RouteEntry[] {
  const entries: RouteEntry[] = [];

  function visit(nodes: PageTree.Node[], ancestry: string[]): void {
    nodes.forEach((node, index) => {
      if (node.type === "page") {
        entries.push({ route: contentRouteFromUrl(node.url), ancestry });
        return;
      }
      if (node.type !== "folder") return;

      const folderAncestry = [
        ...ancestry,
        folderIdentity(node, `${ancestry.join("/")}:${index}:${String(node.name)}`),
      ];
      if (node.index) {
        entries.push({
          route: contentRouteFromUrl(node.index.url),
          ancestry: folderAncestry,
        });
      }
      visit(
        node.children.filter(
          (child) =>
            child.type !== "page" || !node.index || child.url !== node.index.url,
        ),
        folderAncestry,
      );
    });
  }

  visit(tree.children, []);
  return entries;
}

export function routeAncestryFor(tree: PageTree.Root, currentUrl: string): string[] {
  return routeEntries(tree).find(
    (entry) => entry.route === contentRouteFromUrl(currentUrl),
  )?.ancestry ?? [];
}

export function routeManifestFor(
  identity: DocumentationIdentity,
  commit = "working-tree",
): DocumentationRouteManifest {
  const entries = routeEntries(pageTreeFor(identity));
  const routes = entries.map((entry) => entry.route).sort();

  return {
    schemaVersion: 1,
    identity,
    commit,
    routes,
    entries,
  };
}

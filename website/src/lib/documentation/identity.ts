export type DocumentationIdentity =
  | {
      kind: "latest";
      label: string;
      basePath: "/docs";
      version?: string;
    }
  | {
      kind: "canary";
      label: "Canary";
      basePath: "/docs/canary";
      version?: string;
    }
  | {
      kind: "stable";
      label: string;
      basePath: `/docs/${string}`;
      version: string;
    };

export interface DocumentationLocation {
  identity: DocumentationIdentity;
  slugs: string[];
}

export interface DocumentationVersionCatalog {
  schemaVersion: 1;
  latest: DocumentationIdentity & { kind: "latest"; version: string };
  canary: DocumentationIdentity & { kind: "canary" };
  historical: Array<DocumentationIdentity & { kind: "stable" }>;
}

export function createDocumentationVersionCatalog(input: {
  latestVersion: string;
  historicalVersions: readonly string[];
}): DocumentationVersionCatalog {
  return {
    schemaVersion: 1,
    latest: {
      kind: "latest",
      label: `v${input.latestVersion} (Latest)`,
      basePath: "/docs",
      version: input.latestVersion,
    },
    canary: {
      kind: "canary",
      label: "Canary",
      basePath: "/docs/canary",
    },
    historical: input.historicalVersions.map((version) => ({
      kind: "stable",
      label: `v${version}`,
      basePath: `/docs/${version}`,
      version,
    })),
  };
}

export interface DocumentationRouteManifest {
  schemaVersion: 1;
  identity: DocumentationIdentity;
  commit: string;
  routes: string[];
  entries: Array<{
    route: string;
    ancestry: string[];
  }>;
}

const exactStableVersion = /^\d+\.\d+\.\d+$/;

export function documentationLocation(segments: string[]): DocumentationLocation {
  const [first, ...remaining] = segments.filter(Boolean);

  if (first === "canary") {
    return {
      identity: {
        kind: "canary",
        label: "Canary",
        basePath: "/docs/canary",
      },
      slugs: remaining,
    };
  }

  if (first && exactStableVersion.test(first)) {
    return {
      identity: {
        kind: "stable",
        label: `v${first}`,
        basePath: `/docs/${first}`,
        version: first,
      },
      slugs: remaining,
    };
  }

  return {
    identity: {
      kind: "latest",
      label: "Latest",
      basePath: "/docs",
    },
    slugs: first ? [first, ...remaining] : [],
  };
}

export function contentRoute(slugs: string[]): string {
  return slugs.length === 0 ? "/" : `/${slugs.join("/")}`;
}

export function documentationUrl(identity: DocumentationIdentity, slugs: string[]): string {
  const route = contentRoute(slugs);
  return route === "/" ? identity.basePath : `${identity.basePath}${route}`;
}

export function versionedDocumentationHref(
  href: string,
  identity: DocumentationIdentity,
): string {
  if (href === "/docs") return identity.basePath;
  if (
    href.startsWith("/docs/") ||
    href.startsWith("/docs#") ||
    href.startsWith("/docs?")
  ) {
    return `${identity.basePath}${href.slice("/docs".length)}`;
  }
  return href;
}

export function versionedDocumentationMarkdown(
  markdown: string,
  identity: DocumentationIdentity,
): string {
  return markdown.replaceAll(
    /\]\((\/docs(?:[/?#][^)\s]*)?)\)/g,
    (_link, href: string) => `](${versionedDocumentationHref(href, identity)})`,
  );
}

export function contentRouteFromUrl(url: string): string {
  const pathname = new URL(url, "https://ackerdb.dev").pathname;
  const segments = pathname.split("/").filter(Boolean);

  if (segments[0] !== "docs") return "/";

  return contentRoute(documentationLocation(segments.slice(1)).slugs);
}

export function resolveVersionSwitch(
  currentUrl: string,
  target: DocumentationIdentity,
  targetManifest: Pick<DocumentationRouteManifest, "entries" | "routes">,
  currentAncestry: readonly string[],
): { url: string; unavailable: boolean } {
  const requestedRoute = contentRouteFromUrl(currentUrl);
  const routes = new Set(targetManifest.routes);

  if (routes.has(requestedRoute)) {
    return {
      url: requestedRoute === "/" ? target.basePath : `${target.basePath}${requestedRoute}`,
      unavailable: false,
    };
  }

  let fallback = "/";
  for (let depth = currentAncestry.length; depth > 0; depth -= 1) {
    const candidate = targetManifest.entries.find((entry) =>
      currentAncestry
        .slice(0, depth)
        .every((ancestor, index) => entry.ancestry[index] === ancestor),
    );
    if (candidate) {
      fallback = candidate.route;
      break;
    }
  }

  const targetUrl = fallback === "/" ? target.basePath : `${target.basePath}${fallback}`;
  return {
    url: `${targetUrl}?unavailable=${encodeURIComponent(requestedRoute)}`,
    unavailable: true,
  };
}

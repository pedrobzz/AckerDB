import { describe, expect, test } from "bun:test";
import { access, readFile } from "node:fs/promises";
import { join } from "node:path";

const publicArtifact = join(import.meta.dir, "..", ".output", "public");

interface RouteManifest {
  identity: {
    kind: "latest" | "canary";
    label: string;
    basePath: string;
    version?: string;
  };
  commit: string;
  routes: string[];
  entries: Array<{ route: string; ancestry: string[] }>;
}

async function routeManifest(path: string): Promise<RouteManifest> {
  return JSON.parse(await readFile(join(publicArtifact, path), "utf8")) as RouteManifest;
}

function emittedPagePaths(base: string, route: string): [string, string] {
  const directory = base ? join("docs", base) : "docs";
  if (route === "/") return [join(directory, "index.html"), join(directory, "index.md")];

  const slug = route.slice(1);
  return [join(directory, slug, "index.html"), join(directory, `${slug}.md`)];
}

function documentationArtifactForUrl(url: string): string | undefined {
  const path = url.split(/[?#]/, 1)[0];
  if (!path.startsWith("/docs")) return undefined;
  if (path.endsWith(".md")) return path.slice(1);
  if (path === "/docs") return "docs/index.html";
  if (path === "/docs/canary") return "docs/canary/index.html";
  return `${path.slice(1)}/index.html`;
}

describe("Product documentation static artifact", () => {
  test("contains the website and both channels in the non-publishable local preview", async () => {
    const entryPoints = [
      "index.html",
      "favicon.svg",
      "docs/index.html",
      "docs/canary/index.html",
      "docs/index.md",
      "docs/canary/index.md",
      "docs/versions.json",
      "docs/routes.json",
      "docs/canary/routes.json",
      "api/search/latest",
      "api/search/canary",
      "llms.txt",
      "llms-full.txt",
    ];

    await Promise.all(entryPoints.map((entryPoint) => access(join(publicArtifact, entryPoint))));
  });

  test("serves meaningful documentation HTML without client rendering", async () => {
    const introduction = await readFile(join(publicArtifact, "docs", "index.html"), "utf8");

    expect(introduction).toContain("AckerDB is the backend that stays in your application");
    expect(introduction).toContain("One server. One application model.");
    expect(introduction).toContain(
      '<link rel="canonical" href="https://ackerdb.dev/docs"',
    );
  });

  test("previews HTML and Markdown for every Latest and Canary page from one checkout", async () => {
    const latest = await routeManifest("docs/routes.json");
    const canary = await routeManifest("docs/canary/routes.json");
    const corePackage = JSON.parse(
      await readFile(join(import.meta.dir, "..", "..", "packages", "core", "package.json"), "utf8"),
    ) as { version: string };

    expect(latest.identity).toEqual({
      kind: "latest",
      label: `v${corePackage.version} (Latest)`,
      basePath: "/docs",
      version: corePackage.version,
    });
    expect(canary.identity).toMatchObject({ kind: "canary", basePath: "/docs/canary" });
    expect(latest.commit).toBe("working-tree");
    expect(canary.commit).toBe("working-tree");
    expect(latest.routes.length).toBeGreaterThan(60);
    expect(canary.routes).toEqual(latest.routes);
    expect(
      latest.entries.find((entry) => entry.route === "/external-cache-adapters"),
    ).toMatchObject({ ancestry: ["(plugins)", "(plugins)/(cache)"] });

    await Promise.all(
      latest.routes.flatMap((route) => emittedPagePaths("", route).map((path) => access(join(publicArtifact, path)))),
    );
    await Promise.all(
      canary.routes.flatMap((route) => emittedPagePaths("canary", route).map((path) => access(join(publicArtifact, path)))),
    );

    const canaryIntroduction = await readFile(
      join(publicArtifact, "docs", "canary", "index.html"),
      "utf8",
    );
    const canaryMarkdown = await readFile(
      join(publicArtifact, "docs", "canary", "index.md"),
      "utf8",
    );
    expect(canaryIntroduction).toContain(
      '<link rel="canonical" href="https://ackerdb.dev/docs/canary"',
    );
    expect(canaryIntroduction).toContain('href="/docs/canary/installation"');
    expect(canaryMarkdown).toContain("](/docs/canary/installation)");
    expect(canaryMarkdown).not.toContain("](/docs/installation)");
  });

  test("keeps Installation aligned with the repository runtime and lockstep package version", async () => {
    const [installation, bunVersion, corePackage] = await Promise.all([
      readFile(join(publicArtifact, "docs", "installation.md"), "utf8"),
      readFile(join(import.meta.dir, "..", "..", ".bun-version"), "utf8"),
      readFile(
        join(import.meta.dir, "..", "..", "packages", "core", "package.json"),
        "utf8",
      ).then((contents) => JSON.parse(contents) as { version: string }),
    ]);

    expect(installation).toContain(`Bun ${bunVersion.trim()}`);
    for (const packageName of ["server", "client-react", "cli"]) {
      expect(installation).toContain(`@ackerdb/${packageName}@${corePackage.version}`);
    }
  });

  test("keeps search and agent outputs inside Product documentation", async () => {
    const [latestSearch, canarySearch, llms, llmsFull] = await Promise.all([
      readFile(join(publicArtifact, "api", "search", "latest"), "utf8"),
      readFile(join(publicArtifact, "api", "search", "canary"), "utf8"),
      readFile(join(publicArtifact, "llms.txt"), "utf8"),
      readFile(join(publicArtifact, "llms-full.txt"), "utf8"),
    ]);

    expect(latestSearch).toContain('"url":"/docs/installation');
    expect(latestSearch).toContain("defineTable");
    expect(latestSearch).not.toContain('"url":"/docs/canary');
    expect(canarySearch).toContain('"url":"/docs/canary/installation');
    expect(llms).toContain("Introduction");
    expect(llms).toContain("](/docs/installation.md)");
    expect(llms).not.toContain("](/docs/installation)");
    expect(llmsFull).toContain("One server. One application model.");

    for (const output of [latestSearch, canarySearch, llms, llmsFull]) {
      expect(output).not.toContain("docs/adr/");
      expect(output).not.toContain("docs/handoffs/");
      expect(output).not.toContain("INTEGRATION-REPORT");
    }
  });

  test("publishes exactly three substantive pages and placeholders everywhere else", async () => {
    const { routes } = await routeManifest("docs/routes.json");
    const llmsFull = await readFile(join(publicArtifact, "llms-full.txt"), "utf8");
    const substantiveRoutes = new Set(["/", "/installation", "/basic-usage"]);

    for (const route of routes) {
      const [, markdownPath] = emittedPagePaths("", route);
      const markdown = await readFile(join(publicArtifact, markdownPath), "utf8");

      if (substantiveRoutes.has(route)) {
        expect(markdown).not.toContain("is coming soon.");
      } else {
        expect(markdown.trim()).toMatch(/\bcoming soon\.$/);
      }
      expect(llmsFull).toContain(markdown.trim());
    }
  });

  test("resolves every Product documentation link inside the static artifact", async () => {
    const latest = await routeManifest("docs/routes.json");
    const canary = await routeManifest("docs/canary/routes.json");

    for (const [base, routes] of [
      ["", latest.routes],
      ["canary", canary.routes],
    ] as const) {
      for (const route of routes) {
        const [htmlPath] = emittedPagePaths(base, route);
        const html = await readFile(join(publicArtifact, htmlPath), "utf8");
        const links = html.matchAll(/href="([^"]+)"/g);

        for (const match of links) {
          const target = documentationArtifactForUrl(match[1]);
          if (target) await access(join(publicArtifact, target));
        }
      }
    }
  });
});

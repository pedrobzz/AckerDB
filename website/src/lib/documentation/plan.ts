import {
  documentationLocation,
  type DocumentationIdentity,
} from "./identity";

export type StableVersion = `${number}.${number}.${number}`;
export type CanaryVersion = `${StableVersion}-canary.${number}`;

export type DocumentationPublicationPlan =
  | {
      kind: "preview";
      commit: "working-tree";
      sourceVersion: StableVersion;
    }
  | {
      kind: "latest-bootstrap";
      commit: string;
      packageVersion: StableVersion;
    }
  | {
      kind: "canary";
      commit: string;
      latestVersion: StableVersion;
      packageVersion: CanaryVersion;
    }
  | {
      kind: "stable";
      commit: string;
      packageVersion: StableVersion;
    };

type PublicationEnvironment = Readonly<Record<string, string | undefined>>;

const exactStableVersion = /^\d+\.\d+\.\d+$/;
const fullCommit = /^[0-9a-f]{40}$/;

function stableVersion(value: string | undefined, name: string): StableVersion {
  if (!value || !exactStableVersion.test(value)) {
    throw new Error(`${name} must be an exact stable x.y.z version`);
  }
  return value as StableVersion;
}

function publicCommit(value: string | undefined): string {
  if (!value || !fullCommit.test(value)) {
    throw new Error("A public Documentation build requires a full Git commit SHA");
  }
  return value;
}

function sourceStableVersion(sourceVersion: string): StableVersion {
  return stableVersion(sourceVersion, "AckerDB source version");
}

export function parseDocumentationPublicationPlan(
  environment: PublicationEnvironment,
  sourceVersion: string,
): DocumentationPublicationPlan {
  const source = sourceStableVersion(sourceVersion);
  const kind = environment.VITE_DOCS_PUBLICATION_KIND ?? "preview";

  if (kind === "preview") {
    return { kind, commit: "working-tree", sourceVersion: source };
  }

  const commit = publicCommit(environment.VITE_GIT_COMMIT);

  if (kind === "canary") {
    const packageVersion = environment.VITE_DOCS_PACKAGE_VERSION;
    const canaryPattern = new RegExp(
      `^${source.replaceAll(".", "\\.")}-canary\\.(?:0|[1-9]\\d*)$`,
    );
    if (!packageVersion || !canaryPattern.test(packageVersion)) {
      throw new Error(
        `Canary Documentation package version must be ${source}-canary.N`,
      );
    }

    return {
      kind,
      commit,
      latestVersion: stableVersion(
        environment.VITE_DOCS_LATEST_VERSION,
        "Deployed Latest version",
      ),
      packageVersion: packageVersion as CanaryVersion,
    };
  }

  if (kind === "latest-bootstrap" || kind === "stable") {
    const packageVersion = stableVersion(
      environment.VITE_DOCS_PACKAGE_VERSION,
      "Documentation package version",
    );
    if (packageVersion !== source) {
      throw new Error(
        `Documentation package version ${packageVersion} does not match source version ${source}`,
      );
    }
    return { kind, commit, packageVersion };
  }

  throw new Error(`Unknown Documentation publication kind: ${kind}`);
}

export function publicationEntryPaths(plan: DocumentationPublicationPlan): string[] {
  const latest = [
    "/",
    "/docs",
    "/docs/routes.json",
    "/api/search/latest",
    "/llms.txt",
    "/llms-full.txt",
  ];

  if (plan.kind === "preview") {
    return [
      ...latest,
      "/docs/canary",
      "/docs/canary/routes.json",
      "/api/search/canary",
      "/docs/versions.json",
    ];
  }
  if (plan.kind === "latest-bootstrap") return latest;
  if (plan.kind === "canary") {
    return ["/docs/canary", "/docs/canary/routes.json", "/api/search/canary"];
  }

  return [
    ...latest,
    `/docs/${plan.packageVersion}`,
    `/docs/${plan.packageVersion}/routes.json`,
    `/api/search/${plan.packageVersion}`,
  ];
}

export function documentationPackageVersion(
  plan: DocumentationPublicationPlan,
): StableVersion | CanaryVersion {
  return plan.kind === "preview" ? plan.sourceVersion : plan.packageVersion;
}

export function publicationOwnsIdentity(
  plan: DocumentationPublicationPlan,
  identity: DocumentationIdentity,
): boolean {
  if (plan.kind === "preview") return identity.kind !== "stable";
  if (plan.kind === "latest-bootstrap") return identity.kind === "latest";
  if (plan.kind === "canary") return identity.kind === "canary";
  return (
    identity.kind === "latest" ||
    (identity.kind === "stable" && identity.version === plan.packageVersion)
  );
}

export function publicationOwnsPath(
  plan: DocumentationPublicationPlan,
  value: string,
): boolean {
  const pathname = new URL(value, "https://ackerdb.dev").pathname;
  if (pathname === "/404") return plan.kind !== "canary";
  if (pathname === "/") return plan.kind !== "canary";
  if (pathname === "/llms.txt" || pathname === "/llms-full.txt") {
    return plan.kind !== "canary";
  }
  if (pathname === "/docs/versions.json") return plan.kind === "preview";

  if (pathname.startsWith("/api/search/")) {
    const version = pathname.slice("/api/search/".length);
    if (version === "latest") return publicationOwnsIdentity(plan, documentationLocation([]).identity);
    return publicationOwnsIdentity(plan, documentationLocation([version]).identity);
  }

  if (pathname === "/docs" || pathname.startsWith("/docs/")) {
    const segments = pathname
      .slice("/docs".length)
      .split("/")
      .filter(Boolean);
    return publicationOwnsIdentity(plan, documentationLocation(segments).identity);
  }

  return false;
}

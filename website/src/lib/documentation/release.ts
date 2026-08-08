import corePackage from "../../../../packages/core/package.json";
import type {
  DocumentationIdentity,
  DocumentationVersionCatalog,
} from "./identity";
import {
  parseDocumentationPublicationPlan,
  publicationOwnsIdentity,
} from "./plan";

export const stableVersion = corePackage.version;
export const documentationPlan = parseDocumentationPublicationPlan(
  import.meta.env,
  stableVersion,
);

function latestVersion(): string {
  return documentationPlan.kind === "canary"
    ? documentationPlan.latestVersion
    : stableVersion;
}

export function latestIdentity(): DocumentationIdentity & {
  kind: "latest";
  version: string;
} {
  return {
    kind: "latest",
    label: `v${latestVersion()} (Latest)`,
    basePath: "/docs",
    version: latestVersion(),
  };
}

export function canaryIdentity(): DocumentationIdentity & { kind: "canary" } {
  return {
    kind: "canary",
    label: "Canary",
    basePath: "/docs/canary",
  };
}

export function versionCatalog(): DocumentationVersionCatalog {
  const historical = documentationPlan.kind === "stable"
    ? [{
        kind: "stable" as const,
        label: `v${documentationPlan.packageVersion}`,
        basePath: `/docs/${documentationPlan.packageVersion}` as const,
        version: documentationPlan.packageVersion,
      }]
    : [];

  return {
    schemaVersion: 1,
    latest: latestIdentity(),
    canary: canaryIdentity(),
    historical,
  };
}

export function identityForVersionId(versionId: string): DocumentationIdentity | undefined {
  if (versionId === "latest") return latestIdentity();
  if (versionId === "canary") return canaryIdentity();
  return versionCatalog().historical.find((identity) => identity.version === versionId);
}

export function publishedIdentity(
  identity: DocumentationIdentity,
): DocumentationIdentity | undefined {
  const resolved = identity.kind === "latest"
    ? latestIdentity()
    : identity.kind === "canary"
      ? canaryIdentity()
      : identityForVersionId(identity.version);
  if (!resolved || !publicationOwnsIdentity(documentationPlan, resolved)) return undefined;
  return resolved;
}

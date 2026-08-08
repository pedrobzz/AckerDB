import corePackage from "../../../../packages/core/package.json";
import {
  createDocumentationVersionCatalog,
  type DocumentationIdentity,
  type DocumentationVersionCatalog,
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
  return versionCatalog().latest;
}

export function canaryIdentity(): DocumentationIdentity & { kind: "canary" } {
  return versionCatalog().canary;
}

export function versionCatalog(): DocumentationVersionCatalog {
  return createDocumentationVersionCatalog({
    latestVersion: latestVersion(),
    historicalVersions:
      documentationPlan.kind === "stable"
        ? [documentationPlan.packageVersion]
        : [],
  });
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

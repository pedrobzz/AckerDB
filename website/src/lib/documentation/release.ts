import corePackage from "../../../../packages/core/package.json";
import {
  createDocumentationVersionCatalog,
  type DocumentationIdentity,
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

export const documentationVersionCatalog = createDocumentationVersionCatalog({
  latestVersion:
    documentationPlan.kind === "canary"
      ? documentationPlan.latestVersion
      : stableVersion,
  historicalVersions:
    documentationPlan.kind === "stable"
      ? [documentationPlan.packageVersion]
      : [],
});

export function identityForVersionId(versionId: string): DocumentationIdentity | undefined {
  if (versionId === "latest") return documentationVersionCatalog.latest;
  if (versionId === "canary") return documentationVersionCatalog.canary;
  return documentationVersionCatalog.historical.find((identity) => identity.version === versionId);
}

export function publishedIdentity(
  identity: DocumentationIdentity,
): DocumentationIdentity | undefined {
  const resolved = identity.kind === "latest"
    ? documentationVersionCatalog.latest
    : identity.kind === "canary"
      ? documentationVersionCatalog.canary
      : identityForVersionId(identity.version);
  if (!resolved || !publicationOwnsIdentity(documentationPlan, resolved)) return undefined;
  return resolved;
}

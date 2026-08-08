import { describe, expect, test } from "bun:test";
import {
  parseDocumentationPublicationPlan,
  publicationEntryPaths,
  publicationOwnsPath,
  publicationOwnsIdentity,
} from "../src/lib/documentation/plan";
import { documentationLocation } from "../src/lib/documentation/identity";

const commit = "0123456789abcdef0123456789abcdef01234567";

describe("Documentation publication plan", () => {
  test("defaults to an explicitly non-publishable dual-channel preview", () => {
    const plan = parseDocumentationPublicationPlan({}, "0.17.0");

    expect(plan).toEqual({ kind: "preview", commit: "working-tree", sourceVersion: "0.17.0" });
    expect(publicationEntryPaths(plan)).toContain("/docs");
    expect(publicationEntryPaths(plan)).toContain("/docs/canary");
    expect(publicationEntryPaths(plan)).toContain("/docs/versions.json");
  });

  test("builds Latest bootstrap from one exact stable source commit", () => {
    const plan = parseDocumentationPublicationPlan(
      {
        VITE_DOCS_PUBLICATION_KIND: "latest-bootstrap",
        VITE_DOCS_PACKAGE_VERSION: "0.17.0",
        VITE_GIT_COMMIT: commit,
      },
      "0.17.0",
    );

    expect(publicationEntryPaths(plan)).toContain("/docs");
    expect(publicationEntryPaths(plan)).not.toContain("/docs/canary");
    expect(publicationOwnsIdentity(plan, documentationLocation([]).identity)).toBe(true);
    expect(publicationOwnsIdentity(plan, documentationLocation(["canary"]).identity)).toBe(false);
  });

  test("builds Canary independently while retaining the deployed Latest label", () => {
    const plan = parseDocumentationPublicationPlan(
      {
        VITE_DOCS_LATEST_VERSION: "0.16.2",
        VITE_DOCS_PACKAGE_VERSION: "0.17.0-canary.42",
        VITE_DOCS_PUBLICATION_KIND: "canary",
        VITE_GIT_COMMIT: commit,
      },
      "0.17.0",
    );

    expect(plan).toMatchObject({
      kind: "canary",
      latestVersion: "0.16.2",
      packageVersion: "0.17.0-canary.42",
    });
    expect(publicationEntryPaths(plan)).toContain("/docs/canary");
    expect(publicationEntryPaths(plan)).not.toContain("/docs");
    expect(publicationOwnsPath(plan, "/docs/canary/installation.md")).toBe(true);
    expect(publicationOwnsPath(plan, "/")).toBe(false);
    expect(publicationOwnsPath(plan, "/404")).toBe(false);
    expect(publicationOwnsPath(plan, "/docs")).toBe(false);
  });

  test("builds Latest and one route-specific immutable stable snapshot together", () => {
    const plan = parseDocumentationPublicationPlan(
      {
        VITE_DOCS_PACKAGE_VERSION: "0.17.0",
        VITE_DOCS_PUBLICATION_KIND: "stable",
        VITE_GIT_COMMIT: commit,
      },
      "0.17.0",
    );

    expect(publicationEntryPaths(plan)).toEqual(
      expect.arrayContaining([
        "/docs",
        "/docs/0.17.0",
        "/docs/0.17.0/routes.json",
        "/api/search/latest",
        "/api/search/0.17.0",
      ]),
    );
    expect(
      publicationOwnsIdentity(plan, documentationLocation(["0.17.0"]).identity),
    ).toBe(true);
    expect(
      publicationOwnsIdentity(plan, documentationLocation(["0.16.2"]).identity),
    ).toBe(false);
    expect(publicationOwnsPath(plan, "/docs/0.17.0/basic-usage")).toBe(true);
    expect(publicationOwnsPath(plan, "/docs/0.16.2/basic-usage")).toBe(false);
    expect(publicationOwnsPath(plan, "/docs/canary/basic-usage")).toBe(false);
  });

  test("rejects ambiguous or mismatched public identities", () => {
    expect(() =>
      parseDocumentationPublicationPlan(
        {
          VITE_DOCS_PACKAGE_VERSION: "0.18.0",
          VITE_DOCS_PUBLICATION_KIND: "stable",
          VITE_GIT_COMMIT: commit,
        },
        "0.17.0",
      ),
    ).toThrow("source version");

    expect(() =>
      parseDocumentationPublicationPlan(
        {
          VITE_DOCS_LATEST_VERSION: "0.17.0",
          VITE_DOCS_PACKAGE_VERSION: "0.17.0-canary.42",
          VITE_DOCS_PUBLICATION_KIND: "canary",
          VITE_GIT_COMMIT: "short",
        },
        "0.17.0",
      ),
    ).toThrow("full Git commit");

    expect(() =>
      parseDocumentationPublicationPlan(
        {
          VITE_DOCS_PACKAGE_VERSION: "0.17.0-canary.42",
          VITE_DOCS_PUBLICATION_KIND: "canary",
          VITE_GIT_COMMIT: commit,
        },
        "0.17.0",
      ),
    ).toThrow("Latest version");
  });
});

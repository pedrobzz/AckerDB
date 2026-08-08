import { describe, expect, test } from "bun:test";
import { createDocumentationVersionCatalog } from "../src/lib/documentation/identity";

describe("Documentation version catalog", () => {
  test("constructs the shared Latest, Canary, and stable identities", () => {
    expect(
      createDocumentationVersionCatalog({
        latestVersion: "0.20.0",
        historicalVersions: ["0.19.1", "0.18.0"],
      }),
    ).toEqual({
      schemaVersion: 1,
      latest: {
        kind: "latest",
        label: "v0.20.0 (Latest)",
        basePath: "/docs",
        version: "0.20.0",
      },
      canary: {
        kind: "canary",
        label: "Canary",
        basePath: "/docs/canary",
      },
      historical: [
        {
          kind: "stable",
          label: "v0.19.1",
          basePath: "/docs/0.19.1",
          version: "0.19.1",
        },
        {
          kind: "stable",
          label: "v0.18.0",
          basePath: "/docs/0.18.0",
          version: "0.18.0",
        },
      ],
    });
  });
});

import { describe, expect, test } from "bun:test";
import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  createPublicationArtifact,
  type PublicationFileOwnership,
  verifyPublicationArtifact,
} from "../src/lib/documentation/publication/artifact";
import {
  artifactDirectory,
  createArtifact,
  latestAsset,
  publicationCommit as commit,
  stableAsset,
} from "./publication-fixture";

describe("documentation publication artifacts", () => {
  test("inventories every file deterministically with explicit mutable ownership", async () => {
    const directory = await artifactDirectory({
      "docs/index.html": "latest",
      "assets/app-deadbeef.js": "asset",
    });
    const ownership: Record<string, PublicationFileOwnership> = {
      "docs/index.html": { kind: "mutable", channel: "latest" },
      "assets/app-deadbeef.js": latestAsset,
    };

    try {
      const artifact = await createPublicationArtifact({
        directory,
        kind: "latest-bootstrap",
        commit,
        packageVersion: "0.18.0",
        ownership,
      });
      const reorderedArtifact = await createPublicationArtifact({
        directory,
        kind: "latest-bootstrap",
        commit,
        packageVersion: "0.18.0",
        ownership: {
          "assets/app-deadbeef.js": latestAsset,
          "docs/index.html": { channel: "latest", kind: "mutable" },
        },
      });

      expect(artifact).toEqual({
        schemaVersion: 1,
        kind: "latest-bootstrap",
        commit,
        packageVersion: "0.18.0",
        rootDigest: "dcf2e497b3561e0071c3f7ca763b8144ea07d12d27f0af00197d992fbc6eeaee",
        files: [
          {
            path: "assets/app-deadbeef.js",
            sha256: "d59386e0ae435e292fbe0ebcdb954b75ed5fb3922091277cb19f798fc5d50718",
            ownership: latestAsset,
          },
          {
            path: "docs/index.html",
            sha256: "5e1e2bcac305958b27077ca136f35f0abae7cf38c9af678f7d220ed0cb51d4f8",
            ownership: { kind: "mutable", channel: "latest" },
          },
        ],
      });
      expect(reorderedArtifact).toEqual(artifact);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("binds a stable artifact to its immutable exact-version tree and verifies its bytes", async () => {
    const directory = await artifactDirectory({
      "assets/app.js": "asset",
      "docs/index.html": "latest",
      "docs/0.18.0/index.html": "stable",
    });

    try {
      const artifact = await createPublicationArtifact({
        directory,
        kind: "stable",
        commit,
        packageVersion: "0.18.0",
        ownership: {
          "assets/app.js": {
            kind: "content-addressed",
            referencedBy: [
              { kind: "stable", version: "0.18.0" },
              { kind: "mutable", channel: "latest" },
            ],
          },
          "docs/index.html": { kind: "mutable", channel: "latest" },
          "docs/0.18.0/index.html": { kind: "stable", version: "0.18.0" },
        },
      });

      expect(artifact.exactVersionDigest).toBe(
        "05059e0d5ac9b5ef643470d99b25f83b89021dcbf79745dde4da95cb8ecec16f",
      );
      expect(artifact.files[0]?.ownership).toEqual(stableAsset("0.18.0"));
      await expect(verifyPublicationArtifact(directory, artifact)).resolves.toBeUndefined();

      await writeFile(join(directory, "docs/index.html"), "tampered");
      await expect(verifyPublicationArtifact(directory, artifact)).rejects.toThrow(
        "does not match its manifest",
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("requires Canary to arrive through its own artifact after bootstrap", async () => {
    await expect(
      createArtifact("latest-bootstrap", "0.18.0", {
        "docs/index.html": {
          contents: "latest",
          ownership: { kind: "mutable", channel: "latest" },
        },
        "docs/canary/index.html": {
          contents: "canary",
          ownership: { kind: "mutable", channel: "canary" },
        },
      }),
    ).rejects.toThrow("Latest bootstrap artifacts must own only Latest mutable files");
  });
});

import { describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  createPublicationArtifact,
  type PublicationFileOwnership,
  transitionPublication,
  verifyPublicationArtifact,
} from "../src/lib/documentation/publication";

const commit = "0123456789abcdef0123456789abcdef01234567";
const latestAsset: PublicationFileOwnership = {
  kind: "content-addressed",
  referencedBy: [{ kind: "mutable", channel: "latest" }],
};
const canaryAsset: PublicationFileOwnership = {
  kind: "content-addressed",
  referencedBy: [{ kind: "mutable", channel: "canary" }],
};

function stableAsset(version: string): PublicationFileOwnership {
  return {
    kind: "content-addressed",
    referencedBy: [
      { kind: "mutable", channel: "latest" },
      { kind: "stable", version },
    ],
  };
}

async function artifactDirectory(
  files: Readonly<Record<string, string>>,
): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "ackerdb-publication-"));
  for (const [path, contents] of Object.entries(files)) {
    await mkdir(join(directory, path, ".."), { recursive: true });
    await writeFile(join(directory, path), contents);
  }
  return directory;
}

async function createArtifact(
  kind: "latest-bootstrap" | "canary" | "stable",
  packageVersion: string,
  files: Readonly<Record<string, { contents: string; ownership: PublicationFileOwnership }>>,
) {
  const directory = await artifactDirectory(
    Object.fromEntries(Object.entries(files).map(([path, file]) => [path, file.contents])),
  );
  try {
    return await createPublicationArtifact({
      directory,
      kind,
      commit,
      packageVersion,
      ownership: Object.fromEntries(
        Object.entries(files).map(([path, file]) => [path, file.ownership]),
      ),
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

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

describe("documentation publication transitions", () => {
  test("uploads Latest as pre-activation without advertising a missing Canary", async () => {
    const artifact = await createArtifact("latest-bootstrap", "0.18.0", {
      "docs/index.html": {
        contents: "latest",
        ownership: { kind: "mutable", channel: "latest" },
      },
      "assets/app-deadbeef.js": {
        contents: "asset",
        ownership: latestAsset,
      },
    });

    const transition = transitionPublication(undefined, artifact);

    expect(transition.operations).toEqual([
      {
        kind: "put",
        path: "assets/app-deadbeef.js",
        sourcePath: "assets/app-deadbeef.js",
        sha256: "d59386e0ae435e292fbe0ebcdb954b75ed5fb3922091277cb19f798fc5d50718",
      },
      {
        kind: "put",
        path: "docs/index.html",
        sourcePath: "docs/index.html",
        sha256: "5e1e2bcac305958b27077ca136f35f0abae7cf38c9af678f7d220ed0cb51d4f8",
      },
    ]);
    expect(transition.state.catalog).toBeUndefined();
    expect(transition.state.mutable.latest.assets.map((file) => file.path)).toEqual([
      "assets/app-deadbeef.js",
    ]);
  });

  test("activates the version catalog only when the first Canary is independently published", async () => {
    const bootstrap = await createArtifact("latest-bootstrap", "0.18.0", {
      "docs/index.html": {
        contents: "latest",
        ownership: { kind: "mutable", channel: "latest" },
      },
    });
    const canary = await createArtifact("canary", "0.19.0-canary.1", {
      "docs/canary/index.html": {
        contents: "canary",
        ownership: { kind: "mutable", channel: "canary" },
      },
    });
    const preActivation = transitionPublication(undefined, bootstrap).state;
    const activation = transitionPublication(preActivation, canary);
    const catalog = activation.state.catalog;
    if (!catalog) throw new Error("Canary did not activate the catalog");

    expect(catalog).toEqual({
      schemaVersion: 1,
      latest: {
        kind: "latest",
        label: "v0.18.0 (Latest)",
        basePath: "/docs",
        version: "0.18.0",
      },
      canary: { kind: "canary", label: "Canary", basePath: "/docs/canary" },
      historical: [],
    });
    expect(activation.operations.at(-1)).toEqual({
      kind: "catalog",
      path: "docs/versions.json",
      catalog,
    });
  });

  test("replaces only Canary inventory, deletes removed Canary files, and keeps assets additive", async () => {
    const bootstrap = await createArtifact("latest-bootstrap", "0.18.0", {
      "docs/index.html": {
        contents: "latest",
        ownership: { kind: "mutable", channel: "latest" },
      },
      "assets/old-a1.js": {
        contents: "old asset",
        ownership: latestAsset,
      },
    });
    const firstCanary = await createArtifact("canary", "0.18.1-canary.1", {
      "docs/canary/index.html": {
        contents: "old canary",
        ownership: { kind: "mutable", channel: "canary" },
      },
      "docs/canary/removed.html": {
        contents: "remove me",
        ownership: { kind: "mutable", channel: "canary" },
      },
      "assets/canary-old.js": {
        contents: "old canary asset",
        ownership: canaryAsset,
      },
    });
    const initial = transitionPublication(
      transitionPublication(undefined, bootstrap).state,
      firstCanary,
    ).state;
    const canary = await createArtifact("canary", "0.19.0-canary.4", {
      "docs/canary/index.html": {
        contents: "new canary",
        ownership: { kind: "mutable", channel: "canary" },
      },
      "docs/canary/new.html": {
        contents: "new page",
        ownership: { kind: "mutable", channel: "canary" },
      },
      "assets/new-b2.js": {
        contents: "new asset",
        ownership: canaryAsset,
      },
    });

    const transition = transitionPublication(initial, canary);

    expect(transition.state.mutable.latest).toEqual(initial.mutable.latest);
    expect(transition.state.historical).toEqual(initial.historical);
    expect(transition.state.mutable.latest.assets.map((file) => file.path)).toEqual([
      "assets/old-a1.js",
    ]);
    expect(transition.state.mutable.canary?.assets.map((file) => file.path)).toEqual([
      "assets/new-b2.js",
    ]);
    expect(transition.operations.map((operation) => [operation.kind, operation.path])).toEqual([
      ["put", "assets/new-b2.js"],
      ["put", "docs/canary/index.html"],
      ["put", "docs/canary/new.html"],
      ["delete", "docs/canary/removed.html"],
      ["delete", "assets/canary-old.js"],
    ]);
  });

  test("promotes stable bytes to Latest while preserving Canary and adding one immutable version", async () => {
    const bootstrap = await createArtifact("latest-bootstrap", "0.18.0", {
      "docs/index.html": {
        contents: "old latest",
        ownership: { kind: "mutable", channel: "latest" },
      },
      "old.html": {
        contents: "old root",
        ownership: { kind: "mutable", channel: "latest" },
      },
    });
    const canary = await createArtifact("canary", "0.19.0-canary.1", {
      "docs/canary/index.html": {
        contents: "canary",
        ownership: { kind: "mutable", channel: "canary" },
      },
    });
    const initial = transitionPublication(
      transitionPublication(undefined, bootstrap).state,
      canary,
    ).state;
    const stable = await createArtifact("stable", "0.19.0", {
      "docs/index.html": {
        contents: "new latest",
        ownership: { kind: "mutable", channel: "latest" },
      },
      "docs/0.19.0/index.html": {
        contents: "exact stable",
        ownership: { kind: "stable", version: "0.19.0" },
      },
      "assets/stable-c3.js": {
        contents: "stable asset",
        ownership: stableAsset("0.19.0"),
      },
    });

    const transition = transitionPublication(initial, stable);

    expect(transition.state.mutable.canary).toEqual(initial.mutable.canary!);
    expect(transition.state.mutable.latest.packageVersion).toBe("0.19.0");
    expect(transition.state.mutable.latest.assets.map((file) => file.path)).toEqual([
      "assets/stable-c3.js",
    ]);
    expect(transition.state.historical).toEqual([
      expect.objectContaining({
        kind: "stable",
        version: "0.19.0",
        commit,
        exactVersionDigest: stable.exactVersionDigest,
      }),
    ]);
    expect(transition.state.historical[0]?.assets.map((file) => file.path)).toEqual([
      "assets/stable-c3.js",
    ]);
    const catalog = transition.state.catalog;
    if (!catalog) throw new Error("Stable publication lost the active catalog");
    expect(catalog.historical).toEqual([
      {
        kind: "stable",
        label: "v0.19.0",
        basePath: "/docs/0.19.0",
        version: "0.19.0",
      },
    ]);
    expect(transition.operations.map((operation) => [operation.kind, operation.path])).toEqual([
      ["put", "assets/stable-c3.js"],
      ["put", "docs/index.html"],
      ["put", "docs/0.19.0/index.html"],
      ["delete", "old.html"],
      ["catalog", "docs/versions.json"],
    ]);
  });

  test("treats an identical stable publication record as an idempotent no-op", async () => {
    const bootstrap = await createArtifact("latest-bootstrap", "0.18.0", {
      "docs/index.html": {
        contents: "old latest",
        ownership: { kind: "mutable", channel: "latest" },
      },
    });
    const stable = await createArtifact("stable", "0.19.0", {
      "docs/index.html": {
        contents: "latest",
        ownership: { kind: "mutable", channel: "latest" },
      },
      "docs/0.19.0/index.html": {
        contents: "stable",
        ownership: { kind: "stable", version: "0.19.0" },
      },
      "assets/app-hash.js": {
        contents: "asset",
        ownership: stableAsset("0.19.0"),
      },
    });
    const canary = await createArtifact("canary", "0.19.0-canary.1", {
      "docs/canary/index.html": {
        contents: "canary",
        ownership: { kind: "mutable", channel: "canary" },
      },
    });
    const published = transitionPublication(
      transitionPublication(
        transitionPublication(undefined, bootstrap).state,
        canary,
      ).state,
      stable,
    ).state;

    expect(transitionPublication(published, stable)).toEqual({
      state: published,
      operations: [],
    });
  });

  test("rejects another bootstrap after Latest exists", async () => {
    const bootstrap = await createArtifact("latest-bootstrap", "0.18.0", {
      "docs/index.html": {
        contents: "latest",
        ownership: { kind: "mutable", channel: "latest" },
      },
    });
    const published = transitionPublication(undefined, bootstrap).state;

    expect(() => transitionPublication(published, bootstrap)).toThrow(
      "Latest bootstrap is allowed only before Latest and history exist",
    );
  });

  test("rejects a stable publication that would move Latest backwards", async () => {
    const bootstrap = await createArtifact("latest-bootstrap", "0.19.0", {
      "docs/index.html": {
        contents: "latest",
        ownership: { kind: "mutable", channel: "latest" },
      },
    });
    const canary = await createArtifact("canary", "0.20.0-canary.1", {
      "docs/canary/index.html": {
        contents: "canary",
        ownership: { kind: "mutable", channel: "canary" },
      },
    });
    const stale = await createArtifact("stable", "0.18.0", {
      "docs/index.html": {
        contents: "stale latest",
        ownership: { kind: "mutable", channel: "latest" },
      },
      "docs/0.18.0/index.html": {
        contents: "stale history",
        ownership: { kind: "stable", version: "0.18.0" },
      },
    });
    const active = transitionPublication(
      transitionPublication(undefined, bootstrap).state,
      canary,
    ).state;

    expect(() => transitionPublication(active, stale)).toThrow(
      "Stable documentation must advance Latest beyond 0.19.0",
    );
  });

  test("rejects different bytes at an existing content-addressed path", async () => {
    const bootstrap = await createArtifact("latest-bootstrap", "0.18.0", {
      "docs/index.html": {
        contents: "latest",
        ownership: { kind: "mutable", channel: "latest" },
      },
      "assets/app-hash.js": {
        contents: "original asset",
        ownership: latestAsset,
      },
    });
    const canary = await createArtifact("canary", "0.19.0-canary.1", {
      "docs/canary/index.html": {
        contents: "canary",
        ownership: { kind: "mutable", channel: "canary" },
      },
      "assets/app-hash.js": {
        contents: "different asset",
        ownership: canaryAsset,
      },
    });

    expect(() =>
      transitionPublication(transitionPublication(undefined, bootstrap).state, canary),
    ).toThrow("Published path collision has different ownership or bytes");
  });

  test("keeps a removed Canary asset while Latest still references the same bytes", async () => {
    const bootstrap = await createArtifact("latest-bootstrap", "0.18.0", {
      "docs/index.html": {
        contents: "latest",
        ownership: { kind: "mutable", channel: "latest" },
      },
      "assets/shared.js": { contents: "shared", ownership: latestAsset },
    });
    const firstCanary = await createArtifact("canary", "0.19.0-canary.1", {
      "docs/canary/index.html": {
        contents: "canary one",
        ownership: { kind: "mutable", channel: "canary" },
      },
      "assets/shared.js": { contents: "shared", ownership: canaryAsset },
    });
    const nextCanary = await createArtifact("canary", "0.19.0-canary.2", {
      "docs/canary/index.html": {
        contents: "canary two",
        ownership: { kind: "mutable", channel: "canary" },
      },
    });
    const active = transitionPublication(
      transitionPublication(undefined, bootstrap).state,
      firstCanary,
    ).state;

    const transition = transitionPublication(active, nextCanary);

    expect(transition.operations.map((operation) => [operation.kind, operation.path])).toEqual([
      ["put", "docs/canary/index.html"],
    ]);
    expect(transition.state.mutable.latest.assets.map((file) => file.path)).toEqual([
      "assets/shared.js",
    ]);
  });

  test("rejects different immutable bytes for an existing exact version", async () => {
    const bootstrap = await createArtifact("latest-bootstrap", "0.18.0", {
      "docs/index.html": {
        contents: "bootstrap",
        ownership: { kind: "mutable", channel: "latest" },
      },
    });
    const first = await createArtifact("stable", "0.19.0", {
      "docs/index.html": {
        contents: "first latest",
        ownership: { kind: "mutable", channel: "latest" },
      },
      "docs/0.19.0/index.html": {
        contents: "first exact",
        ownership: { kind: "stable", version: "0.19.0" },
      },
    });
    const collision = await createArtifact("stable", "0.19.0", {
      "docs/index.html": {
        contents: "different latest",
        ownership: { kind: "mutable", channel: "latest" },
      },
      "docs/0.19.0/index.html": {
        contents: "different exact",
        ownership: { kind: "stable", version: "0.19.0" },
      },
    });
    const canary = await createArtifact("canary", "0.19.0-canary.1", {
      "docs/canary/index.html": {
        contents: "canary",
        ownership: { kind: "mutable", channel: "canary" },
      },
    });
    const published = transitionPublication(
      transitionPublication(
        transitionPublication(undefined, bootstrap).state,
        canary,
      ).state,
      first,
    ).state;

    expect(() => transitionPublication(published, collision)).toThrow(
      "Stable documentation version collision: 0.19.0",
    );
  });

  test("never creates Canary history and treats the same Canary record as idempotent", async () => {
    const bootstrap = await createArtifact("latest-bootstrap", "0.18.0", {
      "docs/index.html": {
        contents: "bootstrap",
        ownership: { kind: "mutable", channel: "latest" },
      },
    });
    const stable = await createArtifact("stable", "0.19.0", {
      "docs/index.html": {
        contents: "latest",
        ownership: { kind: "mutable", channel: "latest" },
      },
      "docs/0.19.0/index.html": {
        contents: "stable",
        ownership: { kind: "stable", version: "0.19.0" },
      },
    });
    const firstCanary = await createArtifact("canary", "0.19.0-canary.1", {
      "docs/canary/index.html": {
        contents: "first canary",
        ownership: { kind: "mutable", channel: "canary" },
      },
    });
    const canary = await createArtifact("canary", "0.20.0-canary.1", {
      "docs/canary/index.html": {
        contents: "canary",
        ownership: { kind: "mutable", channel: "canary" },
      },
    });
    const beforeCanary = transitionPublication(
      transitionPublication(
        transitionPublication(undefined, bootstrap).state,
        firstCanary,
      ).state,
      stable,
    ).state;
    const afterCanary = transitionPublication(beforeCanary, canary).state;

    expect(afterCanary.mutable.latest).toEqual(beforeCanary.mutable.latest);
    expect(afterCanary.historical).toEqual(beforeCanary.historical);
    expect(transitionPublication(afterCanary, canary)).toEqual({
      state: afterCanary,
      operations: [],
    });
  });
});

import { describe, expect, test } from "bun:test";
import { transitionPublication } from "../../src/lib/documentation/publication/deployment";
import {
  canaryAsset,
  createArtifact,
  latestAsset,
  publicationCommit as commit,
  stableAsset,
} from "./fixture";

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

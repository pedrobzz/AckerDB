import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import corePackage from "../../../packages/core/package.json";
import {
  type PublicationArtifactManifest,
  verifyPublicationArtifact,
} from "../../src/lib/documentation/publication/artifact";
import { transitionPublication } from "../../src/lib/documentation/publication/deployment";

const websiteDirectory = fileURLToPath(new URL("../..", import.meta.url));
const repositoryDirectory = resolve(websiteDirectory, "..");

function commandOutput(command: string, arguments_: string[], cwd: string): string {
  const result = spawnSync(command, arguments_, { cwd, encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(result.stderr.trim() || `${command} ${arguments_.join(" ")} failed`);
  }
  return result.stdout.trim();
}

function buildArtifact(
  output: string,
  kind: "latest-bootstrap" | "canary" | "stable",
  commit: string,
  packageVersion: string,
  latestVersion?: string,
): void {
  const arguments_ = [
    "run",
    "build:publication",
    "--kind",
    kind,
    "--commit",
    commit,
    "--package-version",
    packageVersion,
    "--out",
    output,
  ];
  if (latestVersion) arguments_.push("--latest-version", latestVersion);

  const result = spawnSync(process.execPath, arguments_, {
    cwd: websiteDirectory,
    stdio: "inherit",
  });
  if (result.status !== 0) {
    throw new Error(`${kind} publication build exited with ${result.status ?? "no status"}`);
  }
}

async function manifestAt(output: string): Promise<PublicationArtifactManifest> {
  return JSON.parse(
    await readFile(join(output, "publication-manifest.json"), "utf8"),
  ) as PublicationArtifactManifest;
}

function paths(manifest: PublicationArtifactManifest): Set<string> {
  return new Set(manifest.files.map((file) => file.path));
}

function assertNoPrefix(files: Set<string>, prefix: string): void {
  assert.equal(
    [...files].some((path) => path === prefix || path.startsWith(`${prefix}/`)),
    false,
    `Artifact leaked ${prefix}`,
  );
}

async function verify(): Promise<void> {
  const commit = commandOutput("git", ["rev-parse", "HEAD"], repositoryDirectory);
  const stableVersion = corePackage.version;
  const canaryVersion = `${stableVersion}-canary.0`;
  const temporary = await mkdtemp(join(tmpdir(), "ackerdb-docs-publications-"));

  try {
    const bootstrapOutput = join(temporary, "latest-bootstrap");
    const canaryOutput = join(temporary, "canary");
    const stableOutput = join(temporary, "stable");

    buildArtifact(
      bootstrapOutput,
      "latest-bootstrap",
      commit,
      stableVersion,
    );
    buildArtifact(
      canaryOutput,
      "canary",
      commit,
      canaryVersion,
      stableVersion,
    );
    buildArtifact(stableOutput, "stable", commit, stableVersion);

    const [bootstrap, canary, stable] = await Promise.all([
      manifestAt(bootstrapOutput),
      manifestAt(canaryOutput),
      manifestAt(stableOutput),
    ]);
    await Promise.all([
      verifyPublicationArtifact(join(bootstrapOutput, "public"), bootstrap),
      verifyPublicationArtifact(join(canaryOutput, "public"), canary),
      verifyPublicationArtifact(join(stableOutput, "public"), stable),
    ]);

    for (const manifest of [bootstrap, canary, stable]) {
      assert.equal(manifest.commit, commit);
      assert.ok(manifest.files.length > 100);
      assert.equal(manifest.files.some((file) => file.path === "docs/versions.json"), false);
    }

    const bootstrapPaths = paths(bootstrap);
    assert.ok(bootstrapPaths.has("index.html"));
    assert.ok(bootstrapPaths.has("docs/index.html"));
    assert.ok(bootstrapPaths.has("api/search/latest"));
    assert.ok(bootstrapPaths.has("llms.txt"));
    assertNoPrefix(bootstrapPaths, "docs/canary");
    assertNoPrefix(bootstrapPaths, `docs/${stableVersion}`);
    assert.equal(bootstrapPaths.has("api/search/canary"), false);

    const canaryPaths = paths(canary);
    assert.ok(canaryPaths.has("docs/canary/index.html"));
    assert.ok(canaryPaths.has("api/search/canary"));
    assert.equal(canaryPaths.has("index.html"), false);
    assert.equal(canaryPaths.has("favicon.svg"), false);
    assert.equal(canaryPaths.has("llms.txt"), false);
    assertNoPrefix(canaryPaths, `docs/${stableVersion}`);
    assert.equal(canaryPaths.has("api/search/latest"), false);

    const stablePaths = paths(stable);
    assert.ok(stablePaths.has("index.html"));
    assert.ok(stablePaths.has("docs/index.html"));
    assert.ok(stablePaths.has(`docs/${stableVersion}/index.html`));
    assert.ok(stablePaths.has("api/search/latest"));
    assert.ok(stablePaths.has(`api/search/${stableVersion}`));
    assertNoPrefix(stablePaths, "docs/canary");
    assert.equal(stablePaths.has("api/search/canary"), false);

    for (const file of canary.files) {
      if (file.path.startsWith("assets/")) {
        assert.deepEqual(file.ownership, {
          kind: "content-addressed",
          referencedBy: [{ kind: "mutable", channel: "canary" }],
        });
      } else {
        assert.deepEqual(file.ownership, { kind: "mutable", channel: "canary" });
      }
    }
    for (const file of stable.files) {
      if (!file.path.startsWith("__tsr/staticServerFnCache/")) continue;
      assert.ok(
        file.ownership.kind === "mutable" || file.ownership.kind === "stable",
        `${file.path} must follow the route it caches`,
      );
    }

    const [canaryIntroduction, latestIntroduction, exactIntroduction] = await Promise.all([
      readFile(join(canaryOutput, "public/docs/canary/index.html"), "utf8"),
      readFile(join(stableOutput, "public/docs/index.html"), "utf8"),
      readFile(
        join(stableOutput, `public/docs/${stableVersion}/index.html`),
        "utf8",
      ),
    ]);
    assert.match(
      canaryIntroduction,
      /<link rel="canonical" href="https:\/\/ackerdb\.dev\/docs\/canary"/,
    );
    assert.match(
      latestIntroduction,
      /<link rel="canonical" href="https:\/\/ackerdb\.dev\/docs"/,
    );
    assert.match(
      exactIntroduction,
      new RegExp(
        `<link rel="canonical" href="https://ackerdb\\.dev/docs/${stableVersion.replaceAll(".", "\\.")}"`,
      ),
    );
    assert.ok(exactIntroduction.includes(`href="/docs/${stableVersion}/installation"`));
    assert.ok(canaryIntroduction.includes('href="/docs/canary/installation"'));
    for (const introduction of [canaryIntroduction, latestIntroduction, exactIntroduction]) {
      assert.ok(introduction.includes("One server. One application model."));
    }

    const [canaryInstallation, stableInstallation] = await Promise.all([
      readFile(join(canaryOutput, "public/docs/canary/installation.md"), "utf8"),
      readFile(join(stableOutput, "public/docs/installation.md"), "utf8"),
    ]);
    assert.ok(canaryInstallation.includes(`@ackerdb/server@${canaryVersion}`));
    assert.ok(stableInstallation.includes(`@ackerdb/server@${stableVersion}`));

    const preActivation = transitionPublication(undefined, bootstrap);
    assert.equal(preActivation.state.catalog, undefined);
    assert.equal(preActivation.operations.some((operation) => operation.kind === "catalog"), false);
    const activation = transitionPublication(preActivation.state, canary);
    assert.equal(activation.state.catalog?.latest.version, stableVersion);
    assert.equal(activation.state.catalog?.historical.length, 0);
    assert.equal(activation.operations.at(-1)?.kind, "catalog");

    process.stdout.write(
      `Verified independent Latest, Canary, and ${stableVersion} Documentation artifacts.\n`,
    );
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

await verify();

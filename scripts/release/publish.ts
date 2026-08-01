// bun scripts/release/publish.ts <npm|bootstrap|beta> [--demo]
//
// npm: GitHub CD only. canary publishes X.Y.Z-canary.<run-number>; main
// publishes X.Y.Z. bootstrap: one interactive X.Y.Z-canary.0 publication that
// creates the npm package records before OIDC can be attached. beta: the current
// working tree goes only to local Verdaccio as X.Y.Z-beta.N and may be published
// repeatedly for the same target version.
import {
  appendFileSync,
  cpSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  rmSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import {
  PACKAGES,
  assertRegistryReachable,
  assertWebRtcDistribution,
  fail,
  git,
  packageDirectory,
  pkgJsonPath,
  syncedVersion,
  tryGit,
} from "../lib.ts";
import {
  WEBRTC_LOADER_DECLARATION_PATH,
  WEBRTC_LOADER_PATH,
  writeWebRtcLoader,
} from "../../packages/realtime/native/webrtc/generate-loader.ts";
import {
  sha256File,
  targetBinaryName,
  type TargetBuildManifest,
} from "../../packages/realtime/native/webrtc/evidence.ts";
import { WEBRTC_TARGETS } from "../../packages/realtime/native/webrtc/provenance.ts";
import { ensureNativeArtifacts } from "./native-artifacts.ts";
import {
  assertStableVersion,
  bootstrapCanaryVersion,
  nextBetaVersion,
  publicVersion,
} from "./versioning.ts";

const PUBLIC_REGISTRY = "https://registry.npmjs.org";
const LOCAL_REGISTRY = "http://127.0.0.1:4874";
const BINDING_DIRECTORY = dirname(WEBRTC_LOADER_PATH);
const NATIVE_PACKAGES_DIRECTORY = "packages/realtime-native";
const DISTRIBUTION_DIRECTORY = "packages/realtime/native/webrtc/distribution";
const mode = process.argv[2];
if (mode !== "npm" && mode !== "bootstrap" && mode !== "beta") {
  fail("usage: bun scripts/release/publish.ts <npm|bootstrap|beta> [--demo]");
}
const demoMode = process.argv.includes("--demo");

interface PackageMetadata {
  readonly versions?: Readonly<Record<string, {
    readonly dist?: { readonly tarball?: string };
  }>>;
}

async function packageMetadata(
  registry: string,
  packageName: string,
): Promise<PackageMetadata | null> {
  const response = await fetch(
    `${registry.replace(/\/+$/, "")}/${encodeURIComponent(packageName)}`,
  );
  if (response.status === 404) return null;
  if (!response.ok) {
    throw new Error(`registry query for ${packageName} failed with ${response.status}`);
  }
  return await response.json() as PackageMetadata;
}

async function nextBeta(baseVersion: string): Promise<string> {
  const versions = new Set<string>();
  for (const pkg of PACKAGES) {
    const manifest = await packageMetadata(LOCAL_REGISTRY, `@ackerdb/${pkg}`);
    for (const version of Object.keys(manifest?.versions ?? {})) versions.add(version);
  }
  return nextBetaVersion(baseVersion, versions);
}

function retargetManifest(source: string, version: string): string {
  const manifest = JSON.parse(source) as Record<string, any>;
  manifest.version = version;
  for (const field of [
    "dependencies",
    "devDependencies",
    "optionalDependencies",
    "peerDependencies",
  ]) {
    const dependencies = manifest[field] as Record<string, string> | undefined;
    if (!dependencies) continue;
    for (const name of Object.keys(dependencies)) {
      if (name.startsWith("@ackerdb/")) dependencies[name] = `workspace:${version}`;
    }
  }
  return `${JSON.stringify(manifest, null, 2)}\n`;
}

function files(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name);
}

function packPackage(pkg: string, destination: string): string {
  const before = new Set(files(destination));
  const result = Bun.spawnSync(
    ["bun", "pm", "pack", "--destination", destination, "--ignore-scripts", "--quiet"],
    {
      cwd: packageDirectory(pkg),
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  if (result.exitCode !== 0) {
    throw new Error(`packing @ackerdb/${pkg} failed:\n${result.stderr.toString().trim()}`);
  }
  const created = files(destination).filter(
    (name) => !before.has(name) && name.endsWith(".tgz"),
  );
  if (created.length !== 1) {
    throw new Error(`packing @ackerdb/${pkg} produced ${created.length} tarballs`);
  }
  return join(destination, created[0]!);
}

async function existingTarball(
  registry: string,
  pkg: string,
  version: string,
): Promise<string | null> {
  const metadata = await packageMetadata(registry, `@ackerdb/${pkg}`);
  return metadata?.versions?.[version]?.dist?.tarball ?? null;
}

async function identicalPublishedTarball(
  registry: string,
  pkg: string,
  version: string,
  tarball: string,
): Promise<boolean> {
  const published = await existingTarball(registry, pkg, version);
  if (published === null) return false;
  const response = await fetch(published);
  if (!response.ok) {
    throw new Error(
      `published tarball for @ackerdb/${pkg}@${version} returned ${response.status}`,
    );
  }
  const local = await sha256File(tarball);
  const remote = new Bun.CryptoHasher("sha256")
    .update(await response.arrayBuffer())
    .digest("hex");
  if (local !== remote) {
    throw new Error(`@ackerdb/${pkg}@${version} already exists with different bytes`);
  }
  return true;
}

async function repinDemo(sourceVersion: string, version: string): Promise<void> {
  const manifests = ["demo/package.json"];
  const demoRoot = JSON.parse(await Bun.file("demo/package.json").text()) as {
    readonly workspaces?: readonly string[];
  };
  for (const workspace of demoRoot.workspaces ?? []) {
    const base = `demo/${workspace.replace(/\/\*$/, "")}`;
    for (const entry of readdirSync(base, { withFileTypes: true })) {
      const manifest = `${base}/${entry.name}/package.json`;
      if (entry.isDirectory() && existsSync(manifest)) manifests.push(manifest);
    }
  }

  const priorBeta = new RegExp(
    `^${sourceVersion.replaceAll(".", "\\.")}-beta\\.\\d+$`,
  );
  const leftAlone: string[] = [];
  for (const path of manifests) {
    const manifest = JSON.parse(await Bun.file(path).text()) as Record<string, any>;
    let changed = false;
    for (const field of [
      "dependencies",
      "devDependencies",
      "optionalDependencies",
      "peerDependencies",
    ]) {
      const dependencies = manifest[field] as Record<string, string> | undefined;
      if (!dependencies) continue;
      for (const [name, specifier] of Object.entries(dependencies)) {
        if (!name.startsWith("@ackerdb/")) continue;
        if (specifier === sourceVersion || priorBeta.test(specifier)) {
          dependencies[name] = version;
          changed = true;
        } else {
          leftAlone.push(`${path}: ${name}@${specifier}`);
        }
      }
    }
    if (changed) await Bun.write(path, `${JSON.stringify(manifest, null, 2)}\n`);
  }

  const install = Bun.spawnSync(["bun", "install", "--no-cache"], {
    cwd: "demo",
    stdout: "inherit",
    stderr: "inherit",
  });
  if (install.exitCode !== 0) {
    fail(`demo install failed after pinning ${version}`);
  }
  if (leftAlone.length > 0) {
    console.log(`left deliberate demo divergences unchanged:\n${leftAlone.join("\n")}`);
  }
}

const sources = new Map<string, string>();
for (const pkg of PACKAGES) sources.set(pkg, await Bun.file(pkgJsonPath(pkg)).text());
const sourceVersion = syncedVersion((pkg) => sources.get(pkg)!);
try {
  assertStableVersion(sourceVersion);
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}

let registry: string;
let tag: "latest" | "canary" | "beta";
let version: string;
if (mode === "beta") {
  registry = LOCAL_REGISTRY;
  tag = "beta";
  await assertRegistryReachable(registry);
  version = await nextBeta(sourceVersion);
} else if (mode === "bootstrap") {
  if (process.env.GITHUB_ACTIONS === "true") {
    fail("the npm bootstrap is interactive and must never run in CI");
  }
  const branch = tryGit("symbolic-ref", "--short", "HEAD");
  if (branch === null || branch === "main" || branch === "canary") {
    fail("bootstrap the npm package records from a clean topic branch");
  }
  if (git("status", "--porcelain", "--untracked-files=all") !== "") {
    fail("the npm bootstrap requires a clean working tree");
  }
  registry = PUBLIC_REGISTRY;
  tag = "canary";
  version = bootstrapCanaryVersion(sourceVersion);
  for (const pkg of PACKAGES) {
    const metadata = await packageMetadata(registry, `@ackerdb/${pkg}`);
    const versions = Object.keys(metadata?.versions ?? {});
    if (versions.some((published) => published !== version)) {
      fail(
        `@ackerdb/${pkg} is already initialized on npm; ` +
          "configure trusted publishing instead of using the bootstrap",
      );
    }
  }
} else {
  if (process.env.GITHUB_ACTIONS !== "true") {
    fail("public npm publication runs only in GitHub Actions");
  }
  const branch = process.env.GITHUB_REF_NAME;
  if (branch !== "main" && branch !== "canary") {
    fail("public npm publication runs only after a merge to main or canary");
  }
  if (git("rev-list", "--parents", "-n", "1", "HEAD").split(/\s+/).length !== 3) {
    fail("protected-branch publication requires a two-parent pull-request merge commit");
  }
  registry = PUBLIC_REGISTRY;
  tag = branch === "main" ? "latest" : "canary";
  try {
    version = publicVersion(branch, sourceVersion, process.env.GITHUB_RUN_NUMBER);
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }
  if (git("status", "--porcelain", "--untracked-files=all") !== "") {
    fail("public npm publication requires a clean protected-branch checkout");
  }
}

const temporary = mkdtempSync(join(tmpdir(), "ackerdb-release-"));
const bindingSnapshot = join(temporary, "binding");
const nativePackagesSnapshot = join(temporary, "realtime-native");
const distributionSnapshot = join(temporary, "distribution");
const hadDistribution = existsSync(DISTRIBUTION_DIRECTORY);
cpSync(BINDING_DIRECTORY, bindingSnapshot, { recursive: true, preserveTimestamps: true });
cpSync(NATIVE_PACKAGES_DIRECTORY, nativePackagesSnapshot, {
  recursive: true,
  preserveTimestamps: true,
});
if (hadDistribution) {
  cpSync(DISTRIBUTION_DIRECTORY, distributionSnapshot, {
    recursive: true,
    preserveTimestamps: true,
  });
}

async function restore(): Promise<void> {
  rmSync(BINDING_DIRECTORY, { recursive: true, force: true });
  cpSync(bindingSnapshot, BINDING_DIRECTORY, { recursive: true, preserveTimestamps: true });
  rmSync(NATIVE_PACKAGES_DIRECTORY, { recursive: true, force: true });
  cpSync(nativePackagesSnapshot, NATIVE_PACKAGES_DIRECTORY, {
    recursive: true,
    preserveTimestamps: true,
  });
  rmSync(DISTRIBUTION_DIRECTORY, { recursive: true, force: true });
  if (hadDistribution) {
    cpSync(distributionSnapshot, DISTRIBUTION_DIRECTORY, {
      recursive: true,
      preserveTimestamps: true,
    });
  }
  for (const pkg of PACKAGES) await Bun.write(pkgJsonPath(pkg), sources.get(pkg)!);
  rmSync(temporary, { recursive: true, force: true });
}

let publicationError: unknown;
try {
  await ensureNativeArtifacts(
    mode === "beta" ? [LOCAL_REGISTRY, PUBLIC_REGISTRY] : [PUBLIC_REGISTRY],
  );
  for (const pkg of PACKAGES) {
    await Bun.write(pkgJsonPath(pkg), retargetManifest(sources.get(pkg)!, version));
  }
  await writeWebRtcLoader(version);
  const loader = {
    cjsSha256: await sha256File(WEBRTC_LOADER_PATH),
    dtsSha256: await sha256File(WEBRTC_LOADER_DECLARATION_PATH),
  };
  for (const target of WEBRTC_TARGETS) {
    const path = join(
      BINDING_DIRECTORY,
      targetBinaryName(target).replace(/\.node$/, ".manifest.json"),
    );
    const manifest = JSON.parse(await Bun.file(path).text()) as TargetBuildManifest;
    await Bun.write(path, `${JSON.stringify({ ...manifest, version, loader }, null, 2)}\n`);
  }
  assertWebRtcDistribution();

  const tarballs = new Map(
    PACKAGES.map((pkg) => [pkg, packPackage(pkg, temporary)] as const),
  );
  const published: string[] = [];
  for (const pkg of PACKAGES) {
    const tarball = tarballs.get(pkg)!;
    if (await identicalPublishedTarball(registry, pkg, version, tarball)) {
      console.log(`skipping @ackerdb/${pkg}@${version}; identical bytes are already published`);
      published.push(`@ackerdb/${pkg}`);
      continue;
    }
    console.log(`publishing @ackerdb/${pkg}@${version} with dist-tag ${tag}`);
    const result = Bun.spawnSync(
      [
        "npm",
        "publish",
        tarball,
        `--registry=${registry}`,
        "--access=public",
        `--tag=${tag}`,
      ],
      { stdin: "inherit", stdout: "inherit", stderr: "inherit" },
    );
    if (result.exitCode !== 0) {
      const retry = mode === "npm"
        ? "rerun the same GitHub workflow to resume safely"
        : mode === "bootstrap"
          ? "rerun bun run release:bootstrap after completing npm authentication"
          : "rerun the same beta publication to resume safely";
      throw new Error(
        `publishing @ackerdb/${pkg}@${version} failed after ${published.length} package(s); ` +
          retry,
      );
    }
    published.push(`@ackerdb/${pkg}`);
  }

  if (mode !== "beta") {
    const tagName = `v${version}`;
    const existing = tryGit("rev-parse", "-q", "--verify", `refs/tags/${tagName}^{commit}`);
    const head = git("rev-parse", "HEAD");
    if (existing !== null && existing !== head) {
      throw new Error(`${tagName} already points at ${existing}, not ${head}`);
    }
    if (existing === null) {
      git("tag", tagName);
      git("push", "origin", `refs/tags/${tagName}`);
    }
  }

  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(process.env.GITHUB_OUTPUT, `version=${version}\n`);
  }
  console.log(`published all @ackerdb packages at ${version}`);
} catch (error) {
  publicationError = error;
} finally {
  await restore();
}

if (publicationError !== undefined) {
  fail(publicationError instanceof Error ? publicationError.message : String(publicationError));
}

if (mode === "beta" && demoMode) {
  await repinDemo(sourceVersion, version);
  console.log("restore the demo beta pins when testing is complete");
}

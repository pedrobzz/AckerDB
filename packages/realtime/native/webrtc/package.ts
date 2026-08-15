import { readFileSync } from "node:fs";
import {
  copyFile,
  cp,
  mkdir,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { candidateSourceFromCleanCheckout } from "./candidate.ts";
import {
  DISTRIBUTION_MANIFEST_SCHEMA_VERSION,
  TARGET_EVIDENCE_FILES,
  assertProvenanceRevision,
  assertTargetBuildManifest,
  nativeBindingSourceDigest,
  sha256File,
  targetBinaryName,
  type TargetBuildManifest,
  type WebRtcTarget,
} from "./evidence.ts";
import { NATIVE_ABI, WEBRTC_TARGETS } from "./provenance.ts";

const nativeRoot = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(nativeRoot, "../../../..");
const bindingDirectory = join(nativeRoot, "binding");
const distributionDirectory = join(nativeRoot, "distribution");
const nativePackagesDirectory = join(repositoryRoot, "packages/realtime-native");
const sourceProvenance = join(nativeRoot, "PROVENANCE.md");
const realtimeManifest = JSON.parse(
  readFileSync(join(repositoryRoot, "packages/realtime/package.json"), "utf8"),
) as { readonly version?: string };
if (typeof realtimeManifest.version !== "string") {
  throw new Error("@ackerdb/realtime has no package version");
}

function evidencePrefix(target: WebRtcTarget): string {
  return targetBinaryName(target).replace(/\.node$/, "");
}

function targetPackageDirectory(target: WebRtcTarget): string {
  return join(nativePackagesDirectory, target.platformArchABI);
}

async function mustExist(path: string, label: string): Promise<void> {
  await readFile(path).catch(() => {
    throw new Error(`missing generated ${label}: ${path}`);
  });
}

async function readTarget(
  target: WebRtcTarget,
  nativeBindingSourceSha256: string,
): Promise<TargetBuildManifest> {
  const prefix = evidencePrefix(target);
  const manifest = JSON.parse(await readFile(
    join(bindingDirectory, `${prefix}.manifest.json`),
    "utf8",
  )) as TargetBuildManifest;
  assertTargetBuildManifest(
    manifest,
    target,
    realtimeManifest.version!,
    nativeBindingSourceSha256,
  );
  const binary = join(bindingDirectory, targetBinaryName(target));
  if (await sha256File(binary) !== manifest.sha256) {
    throw new Error(`WebRTC build digest mismatch for ${target.platformArchABI}`);
  }
  const [notices] = await Promise.all([
    readFile(join(bindingDirectory, `${prefix}.THIRD_PARTY_NOTICES.txt`), "utf8"),
    mustExist(
      join(bindingDirectory, `${prefix}.licenses`, "Google-WebRTC-LICENSE.md"),
      "archive license",
    ),
  ]);
  if (notices.trim() === "") throw new Error(`empty cargo-about notices for ${target.packageName}`);
  assertProvenanceRevision(await readFile(sourceProvenance, "utf8"));
  return manifest;
}

async function assertStagedTarget(
  target: WebRtcTarget,
  manifest: TargetBuildManifest,
): Promise<void> {
  const directory = targetPackageDirectory(target);
  const files = await readdir(directory);
  const expected = ["package.json", targetBinaryName(target), ...TARGET_EVIDENCE_FILES]
    .sort();
  if (JSON.stringify(files.sort()) !== JSON.stringify(expected)) {
    throw new Error(
      `${target.packageName} contains unexpected payload: ${files.sort().join(", ")}`,
    );
  }
  const binary = join(directory, targetBinaryName(target));
  if (await sha256File(binary) !== manifest.sha256) {
    throw new Error(`staged WebRTC binary digest mismatch for ${target.packageName}`);
  }
  const archiveLicense = join(directory, manifest.upstream.license.file);
  const licenses = await readdir(join(directory, "licenses"));
  if (JSON.stringify(licenses.sort()) !== JSON.stringify(["Google-WebRTC-LICENSE.md"])) {
    throw new Error(`${target.packageName} has incomplete or unexpected license evidence`);
  }
  if (await sha256File(archiveLicense) !== manifest.upstream.license.sha256) {
    throw new Error(`staged archive license digest mismatch for ${target.packageName}`);
  }
}

async function stageTarget(manifest: TargetBuildManifest): Promise<void> {
  const target = WEBRTC_TARGETS.find((candidate) =>
    candidate.platformArchABI === manifest.platformArchABI
  );
  if (target === undefined) {
    throw new Error(`unknown WebRTC target ${manifest.platformArchABI}`);
  }
  const directory = targetPackageDirectory(target);
  const packageManifest = JSON.parse(await readFile(
    join(directory, "package.json"),
    "utf8",
  )) as {
    readonly name?: string;
    readonly version?: string;
    readonly main?: string;
    readonly files?: readonly string[];
  };
  if (
    packageManifest.name !== target.packageName ||
    packageManifest.version !== realtimeManifest.version ||
    packageManifest.main !== targetBinaryName(target) ||
    JSON.stringify(packageManifest.files) !==
      JSON.stringify([targetBinaryName(target), ...TARGET_EVIDENCE_FILES])
  ) {
    throw new Error(`${target.packageName} does not declare the exact native payload`);
  }

  const prefix = evidencePrefix(target);
  await Promise.all([
    rm(join(directory, targetBinaryName(target)), { force: true }),
    rm(join(directory, "manifest.json"), { force: true }),
    rm(join(directory, "THIRD_PARTY_NOTICES.txt"), { force: true }),
    rm(join(directory, "PROVENANCE.md"), { force: true }),
    rm(join(directory, "licenses"), { force: true, recursive: true }),
  ]);
  await mkdir(directory, { recursive: true });
  await Promise.all([
    copyFile(
      join(bindingDirectory, targetBinaryName(target)),
      join(directory, targetBinaryName(target)),
    ),
    copyFile(
      join(bindingDirectory, `${prefix}.manifest.json`),
      join(directory, "manifest.json"),
    ),
    copyFile(
      join(bindingDirectory, `${prefix}.THIRD_PARTY_NOTICES.txt`),
      join(directory, "THIRD_PARTY_NOTICES.txt"),
    ),
    copyFile(sourceProvenance, join(directory, "PROVENANCE.md")),
    cp(join(bindingDirectory, `${prefix}.licenses`), join(directory, "licenses"), {
      force: true,
      recursive: true,
    }),
  ]);
  await assertStagedTarget(target, manifest);
}

const hostOnly = process.argv.includes("--host");
const candidate = process.argv.includes("--candidate");
if (hostOnly && candidate) {
  throw new Error("a release candidate must assemble every advertised target");
}
const nativeBindingSourceSha256 = await nativeBindingSourceDigest();
const targets = hostOnly
  ? [WEBRTC_TARGETS.find((target) =>
    target.host === `${process.platform}-${process.arch}`
  ) ?? (() => {
    throw new Error(
      `AckerDB has no native package for ${process.platform}-${process.arch}`,
    );
  })()]
  : WEBRTC_TARGETS;
const manifests = await Promise.all(
  targets.map((target) => readTarget(target, nativeBindingSourceSha256)),
);
const loader = {
  cjsSha256: await sha256File(join(bindingDirectory, "index.cjs")),
  dtsSha256: await sha256File(join(bindingDirectory, "index.d.cts")),
};
if (manifests.some((manifest) => !Bun.deepEquals(manifest.loader, loader))) {
  throw new Error("WebRTC targets were built with divergent generated N-API loaders");
}
await Promise.all(manifests.map(stageTarget));

if (hostOnly) {
  console.log(`staged verified WebRTC package ${manifests[0]!.packageName}`);
  process.exit(0);
}

await rm(distributionDirectory, { force: true, recursive: true });
await mkdir(distributionDirectory, { recursive: true });
await writeFile(
  join(distributionDirectory, "manifest.json"),
  `${JSON.stringify({
    schemaVersion: DISTRIBUTION_MANIFEST_SCHEMA_VERSION,
    version: realtimeManifest.version,
    nativeAbi: NATIVE_ABI,
    nativeBindingSourceSha256,
    loader,
    ...(candidate ? { source: candidateSourceFromCleanCheckout(repositoryRoot) } : {}),
    fork: manifests[0]!.fork,
    targets: manifests,
  }, null, 2)}\n`,
  "utf8",
);
console.log(`assembled ${manifests.length} verified WebRTC platform packages`);

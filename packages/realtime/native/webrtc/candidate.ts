import { execFileSync, spawnSync } from "node:child_process";
import {
  mkdtempSync,
  lstatSync,
  readFileSync,
  readdirSync,
  rmSync,
} from "node:fs";
import { mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, posix, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  PACKAGES,
  packageDirectory,
  pkgJsonPath,
} from "../../../../scripts/lib.ts";
import { withPackageLicense } from "../../../../scripts/release/package-license.ts";
import {
  CANDIDATE_MANIFEST_SCHEMA_VERSION,
  DISTRIBUTION_MANIFEST_SCHEMA_VERSION,
  TARGET_EVIDENCE_FILES,
  assertProvenanceRevision,
  assertTargetCycloneDx,
  assertTargetBuildManifest,
  nativeBindingSourceDigest,
  sha256File,
  targetBinaryName,
  type TargetBuildManifest,
  type WebRtcTarget,
} from "./evidence.ts";
import {
  ACKERDB_LIBWEBRTC_REPOSITORY,
  ACKERDB_LIBWEBRTC_REVISION,
  LIVEKIT_NATIVE_REPOSITORY,
  LIVEKIT_UPSTREAM_REVISION,
  NATIVE_ABI,
  WEBRTC_TARGETS,
} from "./provenance.ts";

export const CANDIDATE_MANIFEST_FILE = "webrtc-candidate-manifest.json";
export { DISTRIBUTION_MANIFEST_SCHEMA_VERSION } from "./evidence.ts";

const nativeRoot = dirname(fileURLToPath(import.meta.url));
const defaultRepositoryRoot = resolve(nativeRoot, "../../../..");
const decoder = new TextDecoder();

export interface CandidateSource {
  commit: string;
  clean: true;
}

export interface CandidateEvidence {
  path: string;
  sha256: string;
}

export interface CandidateTarget {
  manifest: TargetBuildManifest;
  evidence: CandidateEvidence[];
}

export interface CandidateTarball {
  packageName: string;
  file: string;
  sha256: string;
  sourceManifestSha256: string;
  packedManifestSha256: string;
}

export interface CandidateLoader {
  cjsSha256: string;
  dtsSha256: string;
}

export interface CandidateManifest {
  schemaVersion: typeof CANDIDATE_MANIFEST_SCHEMA_VERSION;
  source: CandidateSource;
  version: string;
  nativeAbi: typeof NATIVE_ABI;
  nativeBindingSourceSha256: string;
  loader: CandidateLoader;
  fork: TargetBuildManifest["fork"];
  targets: CandidateTarget[];
  tarballs: CandidateTarball[];
}

/**
 * The one read-only result consumed by stable publication. Its paths are
 * absolute and came from the just-verified candidate manifest; callers never
 * search the artifact directory again.
 */
export interface VerifiedCandidate {
  readonly manifest: CandidateManifest;
  readonly tarballs: ReadonlyMap<string, string>;
}

interface DistributionManifest {
  readonly schemaVersion: typeof DISTRIBUTION_MANIFEST_SCHEMA_VERSION;
  readonly version: string;
  readonly nativeAbi: typeof NATIVE_ABI;
  readonly nativeBindingSourceSha256: string;
  readonly loader: CandidateLoader;
  readonly source?: CandidateSource;
  readonly fork: TargetBuildManifest["fork"];
  readonly targets: readonly TargetBuildManifest[];
}

interface PackedPackage {
  readonly tarball: string;
  readonly files: readonly string[];
  readonly manifest: Record<string, unknown>;
}

function fail(message: string): never {
  throw new Error(`invalid WebRTC release candidate: ${message}`);
}

function json(value: Uint8Array, label: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(decoder.decode(value));
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      fail(`${label} is not a JSON object`);
    }
    return parsed as Record<string, unknown>;
  } catch (error) {
    if (error instanceof SyntaxError) fail(`${label} is invalid JSON`);
    throw error;
  }
}

function text(value: Uint8Array): string {
  return decoder.decode(value);
}

function command(command: readonly string[], cwd?: string): Uint8Array {
  const temporary = mkdtempSync(join(tmpdir(), "ackerdb-webrtc-command-"));
  const output = join(temporary, "stdout");
  try {
    execFileSync("sh", [
      "-c",
      'output="$1"; shift; "$@" > "$output"',
      "sh",
      output,
      ...command,
    ], {
      cwd,
      stdio: ["ignore", "ignore", "pipe"],
    });
    return new Uint8Array(readFileSync(output));
  } catch (error) {
    fail(
      `${command[0]} failed while verifying packed evidence: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  } finally {
    rmSync(temporary, { force: true, recursive: true });
  }
}

export function isSafeCandidateArchivePath(file: string): boolean {
  return !file.includes("\\") &&
    posix.normalize(file) === file &&
    file.startsWith("package/");
}

function archiveFiles(tarball: string): readonly string[] {
  const files = text(command(["tar", "-tzf", tarball]))
    .split("\n")
    .filter(Boolean);
  if (files.some((file) => !isSafeCandidateArchivePath(file))) {
    fail(`${tarball} contains a path outside package/`);
  }
  return files.filter((file) => !file.endsWith("/"));
}

function archiveFile(tarball: string, path: string): Uint8Array {
  return command(["tar", "-xOf", tarball, path]);
}

function sha256(value: Uint8Array): string {
  return new Bun.CryptoHasher("sha256").update(value).digest("hex");
}

function exact(actual: readonly string[], expected: readonly string[], label: string): void {
  const normalizedActual = [...actual].sort();
  const normalizedExpected = [...expected].sort();
  if (!Bun.deepEquals(normalizedActual, normalizedExpected)) {
    fail(`${label} is ${normalizedActual.join(", ")}, expected ${normalizedExpected.join(", ")}`);
  }
}

function string(value: unknown, label: string): string {
  if (typeof value !== "string") fail(`${label} is not a string`);
  return value;
}

function sha256String(value: unknown, label: string): string {
  const digest = string(value, label);
  if (!/^[0-9a-f]{64}$/.test(digest)) fail(`${label} is not a SHA-256 digest`);
  return digest;
}

function loader(value: unknown, label: string): CandidateLoader {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    fail(`${label} is not an object`);
  }
  const candidate = value as Record<string, unknown>;
  return {
    cjsSha256: sha256String(candidate.cjsSha256, `${label}.cjsSha256`),
    dtsSha256: sha256String(candidate.dtsSha256, `${label}.dtsSha256`),
  };
}

function candidateSource(value: unknown, label: string): CandidateSource {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    fail(`${label} is not an object`);
  }
  const source = value as Record<string, unknown>;
  const commit = string(source.commit, `${label}.commit`);
  if (!/^[0-9a-f]{40}$/.test(commit)) fail(`${label}.commit is not an immutable Git commit`);
  if (source.clean !== true) fail(`${label}.clean is not true`);
  return { commit, clean: true };
}

function candidatePath(directory: string, file: string): string {
  if (
    file.length === 0 ||
    file !== file.split("/").at(-1) ||
    file === "." ||
    file === ".."
  ) {
    fail(`tarball file ${JSON.stringify(file)} is not a local filename`);
  }
  const path = resolve(directory, file);
  if (relative(directory, path).startsWith("..")) fail(`tarball file ${file} escapes candidate directory`);
  let regularFile = false;
  try {
    regularFile = lstatSync(path).isFile();
  } catch {
    // Report a candidate-boundary error below for missing and unreadable files.
  }
  if (!regularFile) {
    fail(`tarball file ${file} is not a regular local file`);
  }
  return path;
}

const expectedPackageNames = Object.freeze(
  PACKAGES.map((pkg) => `@ackerdb/${pkg}`),
);

interface SourcePackage {
  readonly bytes: Uint8Array;
  readonly manifest: Record<string, unknown>;
}

function lockstepDependencies(
  manifest: Record<string, unknown>,
  version: string,
  expectedPrefix: "workspace:" | "",
  label: string,
): void {
  for (const field of [
    "dependencies",
    "devDependencies",
    "optionalDependencies",
    "peerDependencies",
  ]) {
    const dependencies = manifest[field];
    if (dependencies === undefined) continue;
    if (dependencies === null || typeof dependencies !== "object" || Array.isArray(dependencies)) {
      fail(`${label} ${field} is not an object`);
    }
    for (const [name, specifier] of Object.entries(dependencies)) {
      if (!name.startsWith("@ackerdb/")) continue;
      if (specifier !== `${expectedPrefix}${version}`) {
        fail(`${label} ${field}.${name} is not ${JSON.stringify(`${expectedPrefix}${version}`)}`);
      }
    }
  }
}

function sourcePackages(repositoryRoot: string): ReadonlyMap<string, SourcePackage> {
  const packages = new Map<string, SourcePackage>();
  let version: string | undefined;
  for (const pkg of PACKAGES) {
    const packageName = `@ackerdb/${pkg}`;
    const bytes = new Uint8Array(readFileSync(join(repositoryRoot, pkgJsonPath(pkg))));
    const manifest = json(bytes, `${pkgJsonPath(pkg)} source package.json`);
    if (manifest.name !== packageName) {
      fail(`${pkgJsonPath(pkg)} declares ${JSON.stringify(manifest.name)}, expected ${packageName}`);
    }
    const packageVersion = string(manifest.version, `${pkgJsonPath(pkg)} version`);
    version ??= packageVersion;
    if (packageVersion !== version) {
      fail(`source package ${packageName} is ${packageVersion}, expected lockstep ${version}`);
    }
    lockstepDependencies(manifest, packageVersion, "workspace:", `${packageName} source manifest`);
    packages.set(packageName, { bytes, manifest });
  }
  exact([...packages.keys()], expectedPackageNames, "source package set");
  return packages;
}

function assertPackedLockstepManifest(
  manifest: Record<string, unknown>,
  packageName: string,
  version: string,
): void {
  if (manifest.name !== packageName || manifest.version !== version) {
    fail(`${packageName} packed package identity does not match the candidate version`);
  }
  lockstepDependencies(manifest, version, "", `${packageName} packed manifest`);
}

function assertPackedDependencyRewrite(
  source: Record<string, unknown>,
  packed: Record<string, unknown>,
  packageName: string,
  version: string,
): void {
  for (const field of [
    "dependencies",
    "devDependencies",
    "optionalDependencies",
    "peerDependencies",
  ]) {
    const sourceDependencies = source[field] as Record<string, unknown> | undefined;
    const packedDependencies = packed[field] as Record<string, unknown> | undefined;
    const sourceAckerdb = Object.entries(sourceDependencies ?? {})
      .filter(([name]) => name.startsWith("@ackerdb/"))
      .sort(([left], [right]) => left.localeCompare(right));
    const packedAckerdb = Object.entries(packedDependencies ?? {})
      .filter(([name]) => name.startsWith("@ackerdb/"))
      .sort(([left], [right]) => left.localeCompare(right));
    if (
      !Bun.deepEquals(
        packedAckerdb,
        sourceAckerdb.map(([name]) => [name, version]),
      )
    ) {
      fail(`${packageName} packed ${field} does not preserve the source lockstep dependencies`);
    }
  }
}

function expectedTargetFiles(target: WebRtcTarget): readonly string[] {
  return [
    "package/package.json",
    "package/LICENSE.md",
    `package/${targetBinaryName(target)}`,
    "package/manifest.json",
    "package/sbom.cdx.json",
    "package/THIRD_PARTY_NOTICES.txt",
    "package/PROVENANCE.md",
    "package/licenses/Google-WebRTC-LICENSE.md",
  ];
}

function expectedEvidencePaths(): readonly string[] {
  return [
    "manifest.json",
    "sbom.cdx.json",
    "THIRD_PARTY_NOTICES.txt",
    "PROVENANCE.md",
    "licenses/Google-WebRTC-LICENSE.md",
  ];
}

function asTargetManifest(value: unknown): TargetBuildManifest {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    fail("target manifest is not an object");
  }
  return value as TargetBuildManifest;
}

function packageFromTarball(tarball: string): PackedPackage {
  const files = archiveFiles(tarball);
  if (!files.includes("package/package.json")) {
    fail(`${tarball} has no package.json (${files.join(", ")})`);
  }
  return {
    tarball,
    files,
    manifest: json(archiveFile(tarball, "package/package.json"), `${tarball} package.json`),
  };
}

function packageName(pack: PackedPackage): string {
  return string(pack.manifest.name, `${pack.tarball} package name`);
}

function assertTargetPackageManifest(
  manifest: Record<string, unknown>,
  target: WebRtcTarget,
  version: string,
): void {
  const expectedOs = [target.host.split("-")[0]];
  const expectedCpu = [target.host.endsWith("arm64") ? "arm64" : "x64"];
  const expectedLibc = target.host.startsWith("linux") ? ["glibc"] : undefined;
  if (
    manifest.name !== target.packageName ||
    manifest.version !== version ||
    manifest.main !== targetBinaryName(target) ||
    !Bun.deepEquals(manifest.files, [targetBinaryName(target), ...TARGET_EVIDENCE_FILES]) ||
    !Bun.deepEquals(manifest.os, expectedOs) ||
    !Bun.deepEquals(manifest.cpu, expectedCpu) ||
    !Bun.deepEquals(manifest.libc, expectedLibc)
  ) {
    fail(`${target.packageName} package metadata does not match its target identity`);
  }
}

function assertRootPackageManifest(
  manifest: Record<string, unknown>,
  version: string,
): void {
  const optionalDependencies = manifest.optionalDependencies;
  const expected = Object.fromEntries(
    WEBRTC_TARGETS.map((target) => [target.packageName, version]),
  );
  if (
    manifest.name !== "@ackerdb/realtime" ||
    manifest.version !== version ||
    !Bun.deepEquals(optionalDependencies, expected)
  ) {
    fail("@ackerdb/realtime package metadata does not select the exact native packages");
  }
}

function assertDistributionManifest(
  value: Record<string, unknown>,
  source: CandidateSource,
): DistributionManifest {
  const distribution = value as unknown as DistributionManifest;
  if (
    distribution.schemaVersion !== DISTRIBUTION_MANIFEST_SCHEMA_VERSION ||
    typeof distribution.version !== "string" ||
    distribution.nativeAbi !== NATIVE_ABI ||
    !/^[0-9a-f]{64}$/.test(distribution.nativeBindingSourceSha256) ||
    !Bun.deepEquals(loader(distribution.loader, "root distribution loader"), distribution.loader) ||
    !Bun.deepEquals(distribution.source, source) ||
    !Array.isArray(distribution.targets) ||
    distribution.targets.length !== WEBRTC_TARGETS.length
  ) {
    fail("root distribution manifest has an invalid source, ABI, or target set");
  }
  const fork = distribution.fork;
  if (
    fork === undefined ||
    fork.repository !== ACKERDB_LIBWEBRTC_REPOSITORY ||
    fork.revision !== ACKERDB_LIBWEBRTC_REVISION ||
    fork.upstreamRepository !== LIVEKIT_NATIVE_REPOSITORY ||
    fork.upstreamRevision !== LIVEKIT_UPSTREAM_REVISION
  ) {
    fail("root distribution manifest has an invalid fork identity");
  }
  return distribution;
}

function readCandidateTarget(
  pack: PackedPackage,
  target: WebRtcTarget,
  version: string,
  nativeBindingSourceSha256: string,
): CandidateTarget {
  exact(pack.files, expectedTargetFiles(target), `${target.packageName} exact target payload`);
  assertTargetPackageManifest(pack.manifest, target, version);
  const manifest = asTargetManifest(json(
    archiveFile(pack.tarball, "package/manifest.json"),
    `${target.packageName} manifest.json`,
  ));
  assertTargetBuildManifest(manifest, target, version, nativeBindingSourceSha256);
  const binary = archiveFile(pack.tarball, `package/${targetBinaryName(target)}`);
  if (sha256(binary) !== manifest.sha256) fail(`${target.packageName} binary digest differs from manifest`);

  const licensePath = `package/${manifest.upstream.license.file}`;
  const license = archiveFile(pack.tarball, licensePath);
  if (sha256(license) !== manifest.upstream.license.sha256) {
    fail(`${target.packageName} archive license digest differs from manifest`);
  }
  try {
    assertTargetCycloneDx(json(
      archiveFile(pack.tarball, "package/sbom.cdx.json"),
      `${target.packageName} SBOM`,
    ), target);
  } catch {
    fail(`${target.packageName} SBOM is not target-bound CycloneDX evidence`);
  }
  if (archiveFile(pack.tarball, "package/THIRD_PARTY_NOTICES.txt").byteLength === 0) {
    fail(`${target.packageName} notices are empty`);
  }
  try {
    assertProvenanceRevision(text(archiveFile(pack.tarball, "package/PROVENANCE.md")));
  } catch {
    fail(`${target.packageName} provenance does not bind the immutable fork revision`);
  }
  const evidence = expectedEvidencePaths().map((path) => ({
    path,
    sha256: sha256(archiveFile(pack.tarball, `package/${path}`)),
  }));
  return { manifest, evidence };
}

function assertCandidateTarget(
  entry: CandidateTarget,
  target: WebRtcTarget,
  version: string,
  nativeBindingSourceSha256: string,
  canonicalLoader: CandidateLoader,
): void {
  assertTargetBuildManifest(entry.manifest, target, version, nativeBindingSourceSha256);
  if (!Bun.deepEquals(entry.manifest.loader, canonicalLoader)) {
    fail(`${target.packageName} loader differs from candidate loader`);
  }
  exact(entry.evidence.map((evidence) => evidence.path), expectedEvidencePaths(), `${target.packageName} evidence paths`);
  for (const evidence of entry.evidence) sha256String(evidence.sha256, `${target.packageName} ${evidence.path}`);
}

function readCandidate(value: unknown): CandidateManifest {
  if (value === null || typeof value !== "object" || Array.isArray(value)) fail("candidate manifest is not an object");
  const candidate = value as CandidateManifest;
  if (candidate.schemaVersion !== CANDIDATE_MANIFEST_SCHEMA_VERSION) fail("candidate schema version is unsupported");
  candidate.source = candidateSource(candidate.source, "candidate source");
  candidate.version = string(candidate.version, "candidate package version");
  if (candidate.nativeAbi !== NATIVE_ABI) fail("candidate native ABI differs from the supported ABI");
  candidate.nativeBindingSourceSha256 = sha256String(
    candidate.nativeBindingSourceSha256,
    "candidate source digest",
  );
  candidate.loader = loader(candidate.loader, "candidate loader");
  if (
    candidate.fork === undefined ||
    candidate.fork.repository !== ACKERDB_LIBWEBRTC_REPOSITORY ||
    candidate.fork.revision !== ACKERDB_LIBWEBRTC_REVISION ||
    candidate.fork.upstreamRepository !== LIVEKIT_NATIVE_REPOSITORY ||
    candidate.fork.upstreamRevision !== LIVEKIT_UPSTREAM_REVISION
  ) {
    fail("candidate fork identity differs from the immutable binding source");
  }
  if (!Array.isArray(candidate.targets) || candidate.targets.length !== WEBRTC_TARGETS.length) {
    fail("candidate must bind exactly five target packages");
  }
  if (!Array.isArray(candidate.tarballs) || candidate.tarballs.length !== PACKAGES.length) {
    fail(`candidate must bind exactly ${PACKAGES.length} publish tarballs`);
  }
  return candidate;
}

function exactCandidateTargets(candidate: CandidateManifest): readonly CandidateTarget[] {
  const seen = new Set<string>();
  const result = WEBRTC_TARGETS.map((target) => {
    const entry = candidate.targets.find((candidateTarget) =>
      candidateTarget?.manifest?.packageName === target.packageName
    );
    if (entry === undefined || seen.has(target.packageName)) {
      fail(`candidate is missing ${target.packageName}`);
    }
    seen.add(target.packageName);
    assertCandidateTarget(
      entry,
      target,
      candidate.version,
      candidate.nativeBindingSourceSha256,
      candidate.loader,
    );
    return entry;
  });
  return result;
}

function exactCandidateTarballs(candidate: CandidateManifest): ReadonlyMap<string, CandidateTarball> {
  const records = new Map<string, CandidateTarball>();
  for (const tarball of candidate.tarballs) {
    if (records.has(tarball?.packageName)) fail(`candidate repeats tarball ${tarball?.packageName}`);
    const packageName = string(tarball?.packageName, "tarball package name");
    records.set(packageName, tarball);
    sha256String(tarball?.sha256, `${tarball.packageName} tarball digest`);
    sha256String(tarball?.sourceManifestSha256, `${tarball.packageName} source manifest digest`);
    sha256String(tarball?.packedManifestSha256, `${tarball.packageName} packed manifest digest`);
  }
  exact([...records.keys()], expectedPackageNames, "candidate tarball package set");
  return records;
}

async function tarballsIn(directory: string): Promise<readonly string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".tgz"))
    .map((entry) => join(directory, entry.name))
    .sort();
}

function rootDistribution(pack: PackedPackage, source: CandidateSource): DistributionManifest {
  if (pack.files.some((file) => file.endsWith(".node"))) {
    fail("@ackerdb/realtime final tarball contains a native binary");
  }
  for (const required of [
    "package/native/webrtc/binding/index.cjs",
    "package/native/webrtc/binding/index.d.cts",
    "package/native/webrtc/PROVENANCE.md",
    "package/native/webrtc/distribution/manifest.json",
  ]) {
    if (!pack.files.includes(required)) fail(`@ackerdb/realtime final tarball is missing ${required}`);
  }
  const distribution = assertDistributionManifest(json(
    archiveFile(pack.tarball, "package/native/webrtc/distribution/manifest.json"),
    "root distribution manifest",
  ), source);
  if (
    sha256(archiveFile(pack.tarball, "package/native/webrtc/binding/index.cjs")) !==
      distribution.loader.cjsSha256 ||
    sha256(archiveFile(pack.tarball, "package/native/webrtc/binding/index.d.cts")) !==
      distribution.loader.dtsSha256
  ) {
    fail("root N-API loader differs from distribution evidence");
  }
  return distribution;
}

export async function createCandidateManifest(options: {
  readonly directory: string;
  readonly source: CandidateSource;
  readonly repositoryRoot?: string;
}): Promise<CandidateManifest> {
  const source = candidateSource(options.source, "candidate source");
  const sources = sourcePackages(options.repositoryRoot ?? defaultRepositoryRoot);
  const sourceVersion = string(
    sources.get("@ackerdb/realtime")!.manifest.version,
    "@ackerdb/realtime source version",
  );
  const tarballs = await tarballsIn(options.directory);
  const packages = tarballs.map(packageFromTarball);
  const packageByName = new Map<string, PackedPackage>();
  for (const pack of packages) {
    const name = packageName(pack);
    if (packageByName.has(name)) fail(`multiple final tarballs declare ${name}`);
    packageByName.set(name, pack);
  }
  exact(
    [...packageByName.keys()],
    expectedPackageNames,
    "final tarball package set",
  );
  for (const [packageName, pack] of packageByName) {
    assertPackedLockstepManifest(pack.manifest, packageName, sourceVersion);
    assertPackedDependencyRewrite(
      sources.get(packageName)!.manifest,
      pack.manifest,
      packageName,
      sourceVersion,
    );
  }
  const root = packageByName.get("@ackerdb/realtime")!;
  const distribution = rootDistribution(root, source);
  assertRootPackageManifest(root.manifest, distribution.version);
  if (sourceVersion !== distribution.version) {
    fail(`source package version ${sourceVersion} differs from packed candidate ${distribution.version}`);
  }
  const targets = WEBRTC_TARGETS.map((target) => readCandidateTarget(
    packageByName.get(target.packageName)!,
    target,
    distribution.version,
    distribution.nativeBindingSourceSha256,
  ));
  if (!Bun.deepEquals(distribution.targets, targets.map((target) => target.manifest))) {
    fail("root distribution manifest differs from final target manifests");
  }
  if (!Bun.deepEquals(distribution.fork, targets[0]!.manifest.fork)) {
    fail("root distribution manifest differs from target fork identity");
  }
  if (targets.some((target) => !Bun.deepEquals(target.manifest.loader, distribution.loader))) {
    fail("root distribution manifest differs from target N-API loader evidence");
  }
  return {
    schemaVersion: CANDIDATE_MANIFEST_SCHEMA_VERSION,
    source,
    version: distribution.version,
    nativeAbi: distribution.nativeAbi,
    nativeBindingSourceSha256: distribution.nativeBindingSourceSha256,
    loader: distribution.loader,
    fork: distribution.fork,
    targets,
    tarballs: await Promise.all(PACKAGES.map(async (pkg) => {
      const packageName = `@ackerdb/${pkg}`;
      const pack = packageByName.get(packageName)!;
      const sourcePackage = sources.get(packageName)!;
      return {
        packageName,
        file: relative(options.directory, pack.tarball),
        sha256: await sha256File(pack.tarball),
        sourceManifestSha256: sha256(sourcePackage.bytes),
        packedManifestSha256: sha256(archiveFile(pack.tarball, "package/package.json")),
      };
    })),
  };
}

export async function verifyCandidate(
  candidatePathname: string,
  options: {
    readonly repositoryRoot?: string;
    readonly checkSource?: boolean;
    /** Stable publish has already checked its demo-only working-tree exception. */
    readonly checkClean?: boolean;
  } = {},
): Promise<VerifiedCandidate> {
  const candidate = readCandidate(json(
    new Uint8Array(readFileSync(candidatePathname)),
    "candidate manifest",
  ));
  const repositoryRoot = options.repositoryRoot ?? defaultRepositoryRoot;
  const sources = sourcePackages(repositoryRoot);
  const sourceVersion = string(
    sources.get("@ackerdb/realtime")!.manifest.version,
    "@ackerdb/realtime source version",
  );
  if (candidate.version !== sourceVersion) {
    fail(`candidate version ${candidate.version} differs from checked source ${sourceVersion}`);
  }
  const sourceDigest = await nativeBindingSourceDigest();
  if (candidate.nativeBindingSourceSha256 !== sourceDigest) {
    fail("candidate source digest differs from the checked binding source");
  }
  const targets = exactCandidateTargets(candidate);
  const tarballs = exactCandidateTarballs(candidate);
  const directory = dirname(candidatePathname);
  const verifiedTarballs = new Map<string, string>();
  const packages = new Map<string, PackedPackage>();

  for (const [packageName, tarball] of tarballs) {
    const path = candidatePath(directory, string(tarball.file, `${tarball.packageName} tarball file`));
    if (await sha256File(path) !== tarball.sha256) {
      fail(`${tarball.packageName} final tarball digest differs from candidate evidence`);
    }
    const sourcePackage = sources.get(packageName)!;
    if (sha256(sourcePackage.bytes) !== tarball.sourceManifestSha256) {
      fail(`${packageName} source manifest differs from candidate evidence`);
    }
    const packed = packageFromTarball(path);
    if (sha256(archiveFile(path, "package/package.json")) !== tarball.packedManifestSha256) {
      fail(`${packageName} packed manifest differs from candidate evidence`);
    }
    assertPackedLockstepManifest(packed.manifest, packageName, candidate.version);
    assertPackedDependencyRewrite(
      sourcePackage.manifest,
      packed.manifest,
      packageName,
      candidate.version,
    );
    packages.set(packageName, packed);
    verifiedTarballs.set(packageName, path);
  }

  const root = packages.get("@ackerdb/realtime")!;
  const distribution = rootDistribution(root, candidate.source);
  assertRootPackageManifest(root.manifest, candidate.version);
  if (
    distribution.version !== candidate.version ||
    distribution.nativeAbi !== candidate.nativeAbi ||
    distribution.nativeBindingSourceSha256 !== candidate.nativeBindingSourceSha256 ||
    !Bun.deepEquals(distribution.loader, candidate.loader) ||
    !Bun.deepEquals(distribution.fork, candidate.fork) ||
    !Bun.deepEquals(distribution.targets, targets.map((target) => target.manifest))
  ) {
    fail("root distribution manifest differs from candidate evidence");
  }

  for (const target of WEBRTC_TARGETS) {
    const packed = packages.get(target.packageName)!;
    const actual = readCandidateTarget(
      packed,
      target,
      candidate.version,
      candidate.nativeBindingSourceSha256,
    );
    const expected = targets.find((entry) => entry.manifest.packageName === target.packageName)!;
    if (!Bun.deepEquals(actual, expected)) {
      fail(`${target.packageName} final evidence differs from candidate manifest`);
    }
  }

  if (options.checkSource !== false) {
    if (options.checkClean !== false) {
      const status = text(command(
        ["git", "status", "--porcelain", "--untracked-files=all"],
        repositoryRoot,
      ));
      if (status !== "") fail("checked source is not clean");
    }
    const commit = text(command(["git", "rev-parse", "HEAD"], repositoryRoot)).trim();
    if (commit !== candidate.source.commit) {
      fail(`candidate commit ${candidate.source.commit} differs from checked source ${commit}`);
    }
  }

  return Object.freeze({
    manifest: candidate,
    tarballs: new Map(verifiedTarballs),
  });
}

export function candidateSourceFromCleanCheckout(
  repositoryRoot = defaultRepositoryRoot,
): CandidateSource {
  const status = text(command(
    ["git", "status", "--porcelain", "--untracked-files=all"],
    repositoryRoot,
  ));
  if (status !== "") fail("cannot create a candidate from a dirty checkout");
  const commit = text(command(["git", "rev-parse", "HEAD"], repositoryRoot)).trim();
  return candidateSource({ commit, clean: true }, "candidate source");
}

function packPackage(directory: string, destination: string): void {
  const before = new Set(readFileNames(destination));
  const result = spawnSync(
    "bun",
    ["pm", "pack", "--destination", destination, "--ignore-scripts", "--quiet"],
    { cwd: directory, stdio: ["ignore", "pipe", "pipe"] },
  );
  if (result.status !== 0) {
    fail(`failed to pack ${directory}: ${result.stderr?.toString().trim()}`);
  }
  const created = readFileNames(destination).filter((name) => !before.has(name) && name.endsWith(".tgz"));
  if (created.length !== 1) fail(`${directory} did not produce exactly one tarball`);
}

function readFileNames(directory: string): readonly string[] {
  return readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name);
}

function runAssembly(repositoryRoot: string): void {
  const result = spawnSync(
    "bun",
    ["packages/realtime/native/webrtc/package.ts", "--candidate"],
    { cwd: repositoryRoot, stdio: "inherit" },
  );
  if (result.status !== 0) fail("could not assemble target packages for the release candidate");
}

export async function packCandidate(
  options: {
    readonly repositoryRoot?: string;
    readonly directory?: string;
  } = {},
): Promise<string> {
  const repositoryRoot = options.repositoryRoot ?? defaultRepositoryRoot;
  const source = candidateSourceFromCleanCheckout(repositoryRoot);
  runAssembly(repositoryRoot);
  const directory = options.directory ?? join(repositoryRoot, "dist", "webrtc-candidate");
  await rm(directory, { force: true, recursive: true });
  await mkdir(directory, { recursive: true });
  for (const pkg of PACKAGES) {
    // Candidate tarballs must carry the same materialized license as every
    // other packing path; a raw pack ships the package without LICENSE.md.
    await withPackageLicense(pkg, (packageRoot) => {
      packPackage(packageRoot, directory);
    });
  }
  const candidate = await createCandidateManifest({ directory, source, repositoryRoot });
  const candidatePathname = join(directory, CANDIDATE_MANIFEST_FILE);
  await writeFile(candidatePathname, `${JSON.stringify(candidate, null, 2)}\n`);
  await verifyCandidate(candidatePathname, { repositoryRoot });
  console.log(`verified WebRTC candidate ${candidatePathname}`);
  return candidatePathname;
}

if (import.meta.main) {
  const commandName = process.argv[2] ?? "pack";
  if (commandName === "pack") {
    await packCandidate();
  } else if (commandName === "verify") {
    await verifyCandidate(join(defaultRepositoryRoot, "dist", "webrtc-candidate", CANDIDATE_MANIFEST_FILE));
    console.log("verified WebRTC candidate");
  } else {
    throw new Error("usage: bun candidate.ts [pack|verify]");
  }
}

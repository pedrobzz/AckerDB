import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  mkdtemp,
  mkdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "bun:test";
import { PACKAGES, packageDirectory } from "../../../../../scripts/lib.ts";
import {
  DISTRIBUTION_MANIFEST_SCHEMA_VERSION,
  createCandidateManifest,
  isSafeCandidateArchivePath,
  verifyCandidate,
  type CandidateManifest,
} from "../candidate.ts";
import {
  TARGET_MANIFEST_SCHEMA_VERSION,
  nativeBindingSourceDigest,
  type TargetBuildManifest,
} from "../evidence.ts";
import {
  ACKERDB_LIBWEBRTC_REPOSITORY,
  ACKERDB_LIBWEBRTC_REVISION,
  LIBWEBRTC_TAG,
  LIVEKIT_NATIVE_REPOSITORY,
  LIVEKIT_UPSTREAM_REVISION,
  NATIVE_ABI,
  WEBRTC_TARGETS,
} from "../provenance.ts";

const repositoryRoot = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../../../..",
);
const realtimeManifest = JSON.parse(
  await readFile(join(repositoryRoot, "packages/realtime/package.json"), "utf8"),
) as { readonly version?: unknown };
if (typeof realtimeManifest.version !== "string") {
  throw new Error("@ackerdb/realtime has no package version");
}
const VERSION = realtimeManifest.version;
const COMMIT = "a".repeat(40);
const ROOT_CJS = "module.exports = {};\n";
const ROOT_DTS = "export {};\n";

interface Fixture {
  readonly directory: string;
  readonly candidatePath: string;
  readonly candidate: CandidateManifest;
}

type Mutable<T> = {
  -readonly [Key in keyof T]: T[Key] extends readonly (infer Item)[]
    ? Mutable<Item>[]
    : T[Key] extends object ? Mutable<T[Key]>
    : T[Key];
};

type MutableCandidate = Omit<Mutable<CandidateManifest>, "nativeAbi"> & {
  nativeAbi: number;
};

function sha256(value: Uint8Array | string): string {
  return createHash("sha256").update(value).digest("hex");
}

async function run(command: readonly string[]): Promise<void> {
  try {
    execFileSync(command[0]!, command.slice(1));
  } catch (error) {
    throw new Error(
      `command failed: ${command.join(" ")}\n${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

async function pack(directory: string, destination: string): Promise<void> {
  await mkdir(dirname(destination), { recursive: true });
  await run(["tar", "-czf", destination, "-C", directory, "package"]);
}

async function writePackage(
  directory: string,
  files: Readonly<Record<string, Uint8Array | string>>,
): Promise<void> {
  for (const [path, content] of Object.entries(files)) {
    const destination = join(directory, "package", path);
    await mkdir(dirname(destination), { recursive: true });
    await writeFile(destination, content);
  }
}

function targetManifest(
  target: (typeof WEBRTC_TARGETS)[number],
  nativeBindingSourceSha256: string,
  binary: Uint8Array,
  license: string,
  loader: { readonly cjsSha256: string; readonly dtsSha256: string },
): TargetBuildManifest {
  return {
    schemaVersion: TARGET_MANIFEST_SCHEMA_VERSION,
    version: VERSION,
    nativeAbi: NATIVE_ABI,
    host: target.host,
    rustTarget: target.rustTarget,
    platformArchABI: target.platformArchABI,
    packageName: target.packageName,
    file: `ackerdb_webrtc.${target.platformArchABI}.node`,
    sha256: sha256(binary),
    nativeBindingSourceSha256,
    loader,
    fork: {
      repository: ACKERDB_LIBWEBRTC_REPOSITORY,
      revision: ACKERDB_LIBWEBRTC_REVISION,
      upstreamRepository: LIVEKIT_NATIVE_REPOSITORY,
      upstreamRevision: LIVEKIT_UPSTREAM_REVISION,
    },
    upstream: {
      repository: LIVEKIT_NATIVE_REPOSITORY,
      libwebrtcTag: LIBWEBRTC_TAG,
      archive: target.archive,
      archiveSha256: target.archiveSha256,
      license: {
        file: "licenses/Google-WebRTC-LICENSE.md",
        sha256: sha256(license),
      },
    },
  };
}

async function packedManifest(pkg: (typeof PACKAGES)[number]): Promise<Record<string, unknown>> {
  const manifest = JSON.parse(await readFile(
    join(repositoryRoot, packageDirectory(pkg), "package.json"),
    "utf8",
  )) as Record<string, unknown>;
  for (const field of [
    "dependencies",
    "devDependencies",
    "optionalDependencies",
    "peerDependencies",
  ]) {
    const dependencies = manifest[field] as Record<string, string> | undefined;
    if (dependencies === undefined) continue;
    for (const [name, specifier] of Object.entries(dependencies)) {
      if (name.startsWith("@ackerdb/")) dependencies[name] = specifier.replace(
        `workspace:${VERSION}`,
        VERSION,
      );
    }
  }
  return manifest;
}

async function fixture(): Promise<Fixture> {
  const directory = await mkdtemp(join(tmpdir(), "ackerdb-webrtc-candidate-"));
  const nativeBindingSourceSha256 = await nativeBindingSourceDigest();
  const loader = {
    cjsSha256: sha256(ROOT_CJS),
    dtsSha256: sha256(ROOT_DTS),
  };
  const manifests = await Promise.all(WEBRTC_TARGETS.map(async (target, index) => {
    const binary = new Uint8Array([index, 1, 2, 3]);
    const license = `Google WebRTC license ${target.host}\n`;
    const manifest = targetManifest(target, nativeBindingSourceSha256, binary, license, loader);
    const source = join(directory, target.platformArchABI);
    const tarball = join(directory, `${target.platformArchABI}.tgz`);
    await writePackage(source, {
      "package.json": JSON.stringify({
        name: target.packageName,
        version: VERSION,
        main: manifest.file,
        files: [
          manifest.file,
          "manifest.json",
          "sbom.cdx.json",
          "THIRD_PARTY_NOTICES.txt",
          "PROVENANCE.md",
          "licenses",
        ],
        os: [target.host.split("-")[0]],
        cpu: [target.host.endsWith("arm64") ? "arm64" : "x64"],
        ...(target.host.startsWith("linux") ? { libc: ["glibc"] } : {}),
      }),
      [manifest.file]: binary,
      "manifest.json": JSON.stringify(manifest),
      "sbom.cdx.json": JSON.stringify({
        bomFormat: "CycloneDX",
        specVersion: "1.5",
        metadata: {
          properties: [{
            name: "cdx:rustc:sbom:target:triple",
            value: target.rustTarget,
          }],
        },
      }),
      "LICENSE.md": `fixture license for ${target.host}\n`,
      "THIRD_PARTY_NOTICES.txt": `notices for ${target.host}\n`,
      "PROVENANCE.md": `at immutable commit \`${ACKERDB_LIBWEBRTC_REVISION}\`.\n`,
      "licenses/Google-WebRTC-LICENSE.md": license,
    });
    await pack(source, tarball);
    return manifest;
  }));

  const nativePackages = new Set(WEBRTC_TARGETS.map((target) =>
    target.packageName.slice("@ackerdb/".length)
  ));
  await Promise.all(PACKAGES
    .filter((pkg) => pkg !== "realtime" && !nativePackages.has(pkg))
    .map(async (pkg) => {
      const source = join(directory, pkg);
      await writePackage(source, {
        "package.json": JSON.stringify(await packedManifest(pkg)),
      });
      await pack(source, join(directory, `${pkg}.tgz`));
    }));

  const root = join(directory, "root");
  const rootTarball = join(directory, "root.tgz");
  await writePackage(root, {
    "package.json": JSON.stringify(await packedManifest("realtime")),
    "native/webrtc/binding/index.cjs": ROOT_CJS,
    "native/webrtc/binding/index.d.cts": ROOT_DTS,
    "native/webrtc/PROVENANCE.md": `at immutable commit \`${ACKERDB_LIBWEBRTC_REVISION}\`.\n`,
    "native/webrtc/distribution/manifest.json": JSON.stringify({
      schemaVersion: DISTRIBUTION_MANIFEST_SCHEMA_VERSION,
      version: VERSION,
      nativeAbi: NATIVE_ABI,
      nativeBindingSourceSha256,
      loader,
      source: { commit: COMMIT, clean: true },
      fork: manifests[0]!.fork,
      targets: manifests,
    }),
  });
  await pack(root, rootTarball);

  const candidate = await createCandidateManifest({
    directory,
    source: { commit: COMMIT, clean: true },
  });
  const candidatePath = join(directory, "webrtc-candidate-manifest.json");
  await writeFile(candidatePath, `${JSON.stringify(candidate, null, 2)}\n`);
  return { directory, candidatePath, candidate };
}

async function withFixture(
  work: (value: Fixture) => Promise<void>,
): Promise<void> {
  const value = await fixture();
  try {
    await work(value);
  } finally {
    await rm(value.directory, { force: true, recursive: true });
  }
}

async function rewriteTarball(
  tarball: string,
  update: (packageDirectory: string) => Promise<void>,
): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "ackerdb-webrtc-repack-"));
  try {
    await run(["tar", "-xzf", tarball, "-C", directory]);
    await update(join(directory, "package"));
    await run(["tar", "-czf", tarball, "-C", directory, "package"]);
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
}

function copyCandidate(candidate: CandidateManifest): MutableCandidate {
  return JSON.parse(JSON.stringify(candidate)) as MutableCandidate;
}

async function writeCandidateTarballDigest(
  candidate: MutableCandidate,
  fixture: Fixture,
  packageName: string,
): Promise<void> {
  const record = candidate.tarballs.find((entry) => entry.packageName === packageName);
  if (record === undefined) throw new Error(`missing ${packageName} tarball record`);
  record.sha256 = sha256(await readFile(join(fixture.directory, record.file)));
  await writeFile(fixture.candidatePath, `${JSON.stringify(candidate, null, 2)}\n`);
}

async function expectVerificationFailure(
  candidatePath: string,
  message: string,
  options: Parameters<typeof verifyCandidate>[1] = { checkSource: false },
): Promise<void> {
  let failure: unknown;
  try {
    await verifyCandidate(candidatePath, options);
  } catch (error) {
    failure = error;
  }
  expect(failure).toBeInstanceOf(Error);
  expect((failure as Error).message).toContain(message);
}

describe("WebRTC release candidate evidence", () => {
  test("rejects archive traversal names and linked candidate tarballs", async () => {
    expect(isSafeCandidateArchivePath("package/src/index.ts")).toBe(true);
    expect(isSafeCandidateArchivePath("package/../../outside")).toBe(false);
    expect(isSafeCandidateArchivePath("package/src/../../../outside")).toBe(false);
    expect(isSafeCandidateArchivePath("package\\..\\outside")).toBe(false);

    await withFixture(async (value) => {
      const record = value.candidate.tarballs.find((entry) =>
        entry.packageName === "@ackerdb/core"
      )!;
      const tarball = join(value.directory, record.file);
      const outside = join(tmpdir(), `ackerdb-linked-${crypto.randomUUID()}.tgz`);
      try {
        await writeFile(outside, await readFile(tarball));
        await rm(tarball);
        await symlink(outside, tarball);
        await expectVerificationFailure(
          value.candidatePath,
          "not a regular local file",
        );
      } finally {
        await rm(outside, { force: true });
      }
    });
  });

  test("verifies every final publish tarball from its packed bytes", async () => {
    await withFixture(async ({ candidatePath, candidate, directory }) => {
      const before = await Promise.all([
        readFile(candidatePath),
        ...candidate.tarballs.map((tarball) => readFile(join(directory, tarball.file))),
      ]);
      const verified = await verifyCandidate(candidatePath, { checkSource: false });
      expect([...verified.tarballs.keys()]).toEqual(PACKAGES.map((pkg) => `@ackerdb/${pkg}`));
      expect([...verified.tarballs.values()].every((path) => path.startsWith("/"))).toBe(true);
      const after = await Promise.all([
        readFile(candidatePath),
        ...candidate.tarballs.map((tarball) => readFile(join(directory, tarball.file))),
      ]);
      expect(after).toEqual(before);
    });
  });

  test("rejects a missing target, source, fork, archive, ABI, or version change", async () => {
    await withFixture(async (value) => {
      const candidate = copyCandidate(value.candidate);
      candidate.targets.pop();
      await writeFile(value.candidatePath, JSON.stringify(candidate));
      await expectVerificationFailure(value.candidatePath, "five target packages");

      const missingPackage = copyCandidate(value.candidate);
      missingPackage.tarballs.pop();
      await writeFile(value.candidatePath, JSON.stringify(missingPackage));
      await expectVerificationFailure(value.candidatePath, "12 publish tarballs");

      const sourceManifest = copyCandidate(value.candidate);
      sourceManifest.tarballs.find((entry) => entry.packageName === "@ackerdb/core")!
        .sourceManifestSha256 = "0".repeat(64);
      await writeFile(value.candidatePath, JSON.stringify(sourceManifest));
      await expectVerificationFailure(value.candidatePath, "source manifest differs");

      candidate.nativeBindingSourceSha256 = "0".repeat(64);
      candidate.targets = copyCandidate(value.candidate).targets;
      await writeFile(value.candidatePath, JSON.stringify(candidate));
      await expectVerificationFailure(value.candidatePath, "source digest");

      const fork = copyCandidate(value.candidate);
      fork.targets[0]!.manifest.fork.revision = "0".repeat(40);
      await writeFile(value.candidatePath, JSON.stringify(fork));
      await expectVerificationFailure(value.candidatePath, "build manifest");

      const archive = copyCandidate(value.candidate);
      archive.targets[0]!.manifest.upstream.archive = "different.zip";
      await writeFile(value.candidatePath, JSON.stringify(archive));
      await expectVerificationFailure(value.candidatePath, "build manifest");

      const loader = copyCandidate(value.candidate);
      loader.targets[0]!.manifest.loader = {
        ...loader.targets[0]!.manifest.loader,
        cjsSha256: "0".repeat(64),
      };
      await writeFile(value.candidatePath, JSON.stringify(loader));
      await expectVerificationFailure(value.candidatePath, "loader differs");

      const abi = copyCandidate(value.candidate);
      abi.nativeAbi = 7;
      await writeFile(value.candidatePath, JSON.stringify(abi));
      await expectVerificationFailure(value.candidatePath, "native ABI");

      const version = copyCandidate(value.candidate);
      version.version = "0.0.0";
      await writeFile(value.candidatePath, JSON.stringify(version));
      await expectVerificationFailure(value.candidatePath, "candidate version");

      await writeFile(value.candidatePath, JSON.stringify(value.candidate));
      await expectVerificationFailure(value.candidatePath, "candidate commit", { checkClean: false });
    });
  });

  test("rejects an altered final tarball, binary, or evidence corpus", async () => {
    await withFixture(async (value) => {
      const tarball = join(value.directory, value.candidate.tarballs[0]!.file);
      const original = await readFile(tarball);
      await writeFile(tarball, new Uint8Array([...original, 0]));
      await expectVerificationFailure(value.candidatePath, "tarball digest");
      await writeFile(tarball, original);

      const target = WEBRTC_TARGETS[0]!;
      const targetTarball = value.candidate.tarballs.find((entry) => entry.packageName === target.packageName)!;
      const originalTargetTarball = await readFile(join(value.directory, targetTarball.file));
      await rewriteTarball(join(value.directory, targetTarball.file), async (directory) => {
        await writeFile(join(directory, `ackerdb_webrtc.${target.platformArchABI}.node`), "changed");
      });
      const binary = copyCandidate(value.candidate);
      await writeCandidateTarballDigest(binary, value, target.packageName);
      await expectVerificationFailure(value.candidatePath, "binary digest");
      await writeFile(join(value.directory, targetTarball.file), originalTargetTarball);
      await writeFile(value.candidatePath, `${JSON.stringify(value.candidate, null, 2)}\n`);

      await rewriteTarball(join(value.directory, targetTarball.file), async (directory) => {
        await rm(join(directory, "licenses", "Google-WebRTC-LICENSE.md"));
      });
      const license = copyCandidate(value.candidate);
      await writeCandidateTarballDigest(license, value, target.packageName);
      await expectVerificationFailure(value.candidatePath, "exact target payload");
      await writeFile(join(value.directory, targetTarball.file), originalTargetTarball);
      await writeFile(value.candidatePath, `${JSON.stringify(value.candidate, null, 2)}\n`);

      await rewriteTarball(join(value.directory, targetTarball.file), async (directory) => {
        await writeFile(join(directory, "THIRD_PARTY_NOTICES.txt"), "different notices\n");
      });
      const evidence = copyCandidate(value.candidate);
      await writeCandidateTarballDigest(evidence, value, target.packageName);
      await expectVerificationFailure(value.candidatePath, "final evidence differs");
      await writeFile(join(value.directory, targetTarball.file), originalTargetTarball);
      await writeFile(value.candidatePath, `${JSON.stringify(value.candidate, null, 2)}\n`);

      await rewriteTarball(join(value.directory, targetTarball.file), async (directory) => {
        const sbom = JSON.parse(await readFile(join(directory, "sbom.cdx.json"), "utf8")) as {
          metadata: { properties: { name: string; value: string }[] };
        };
        sbom.metadata.properties[0]!.value = "different-target";
        await writeFile(join(directory, "sbom.cdx.json"), JSON.stringify(sbom));
      });
      const targetBoundSbom = copyCandidate(value.candidate);
      await writeCandidateTarballDigest(targetBoundSbom, value, target.packageName);
      await expectVerificationFailure(value.candidatePath, "not target-bound CycloneDX evidence");
      await writeFile(join(value.directory, targetTarball.file), originalTargetTarball);
      await writeFile(value.candidatePath, `${JSON.stringify(value.candidate, null, 2)}\n`);

      const coreTarball = value.candidate.tarballs.find((entry) => entry.packageName === "@ackerdb/core")!;
      const originalCoreTarball = await readFile(join(value.directory, coreTarball.file));
      await rewriteTarball(join(value.directory, coreTarball.file), async (directory) => {
        const manifest = JSON.parse(await readFile(join(directory, "package.json"), "utf8")) as Record<string, unknown>;
        manifest.description = "repacked";
        await writeFile(join(directory, "package.json"), JSON.stringify(manifest));
      });
      const repacked = copyCandidate(value.candidate);
      await writeCandidateTarballDigest(repacked, value, "@ackerdb/core");
      await expectVerificationFailure(value.candidatePath, "packed manifest differs");
      await writeFile(join(value.directory, coreTarball.file), originalCoreTarball);
    });
  });
});

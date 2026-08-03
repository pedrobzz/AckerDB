import { mkdtempSync, rmSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import {
  assertTargetBuildManifest,
  nativeBindingSourceDigest,
  sha256File,
  targetBinaryName,
  type TargetBuildManifest,
  type WebRtcTarget,
} from "../../packages/realtime/native/webrtc/evidence.ts";
import { WEBRTC_TARGETS } from "../../packages/realtime/native/webrtc/provenance.ts";
import { fail } from "../lib.ts";

const BINDING_DIRECTORY = "packages/realtime/native/webrtc/binding";

interface RegistryPackage {
  readonly versions?: Readonly<Record<string, {
    readonly dist?: { readonly tarball?: string };
  }>>;
  readonly time?: Readonly<Record<string, string>>;
}

function artifactPaths(target: WebRtcTarget): readonly [string, string][] {
  const prefix = targetBinaryName(target).replace(/\.node$/, "");
  return [
    [targetBinaryName(target), `${prefix}.node`],
    ["manifest.json", `${prefix}.manifest.json`],
    ["sbom.cdx.json", `${prefix}.sbom.cdx.json`],
    ["THIRD_PARTY_NOTICES.txt", `${prefix}.THIRD_PARTY_NOTICES.txt`],
    ["PROVENANCE.md", `${prefix}.PROVENANCE.md`],
    ["licenses/Google-WebRTC-LICENSE.md", `${prefix}.licenses/Google-WebRTC-LICENSE.md`],
  ] as const;
}

async function validTarget(target: WebRtcTarget, sourceDigest: string): Promise<boolean> {
  const prefix = targetBinaryName(target).replace(/\.node$/, "");
  const manifestPath = join(BINDING_DIRECTORY, `${prefix}.manifest.json`);
  try {
    const manifest = JSON.parse(await Bun.file(manifestPath).text()) as TargetBuildManifest;
    assertTargetBuildManifest(manifest, target, manifest.version, sourceDigest);
    const binaryPath = join(BINDING_DIRECTORY, targetBinaryName(target));
    return manifest.sha256 === await sha256File(binaryPath);
  } catch {
    return false;
  }
}

async function complete(sourceDigest: string): Promise<boolean> {
  const valid = await Promise.all(
    WEBRTC_TARGETS.map((target) => validTarget(target, sourceDigest)),
  );
  return valid.every(Boolean);
}

async function metadata(registry: string, packageName: string): Promise<RegistryPackage | null> {
  try {
    const response = await fetch(
      `${registry.replace(/\/+$/, "")}/${encodeURIComponent(packageName)}`,
    );
    if (response.status === 404) return null;
    if (!response.ok) return null;
    return await response.json() as RegistryPackage;
  } catch {
    return null;
  }
}

function archiveFile(tarball: string, path: string): Uint8Array {
  const result = Bun.spawnSync(["tar", "-xOf", tarball, `package/${path}`], {
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode !== 0) {
    throw new Error(`cannot read package/${path}: ${result.stderr.toString().trim()}`);
  }
  return result.stdout;
}

async function extractVersion(
  version: string,
  packages: ReadonlyMap<string, RegistryPackage>,
  sourceDigest: string,
): Promise<boolean> {
  const temporary = mkdtempSync(join(tmpdir(), "ackerdb-native-artifacts-"));
  try {
    for (const target of WEBRTC_TARGETS) {
      const tarballUrl = packages.get(target.packageName)?.versions?.[version]?.dist?.tarball;
      if (typeof tarballUrl !== "string") return false;
      const response = await fetch(tarballUrl);
      if (!response.ok) return false;
      const tarball = join(temporary, `${target.host}.tgz`);
      await Bun.write(tarball, await response.arrayBuffer());
      const manifest = JSON.parse(
        new TextDecoder().decode(archiveFile(tarball, "manifest.json")),
      ) as TargetBuildManifest;
      try {
        assertTargetBuildManifest(manifest, target, version, sourceDigest);
      } catch {
        return false;
      }
      for (const [archivePath, destinationName] of artifactPaths(target)) {
        const destination = join(BINDING_DIRECTORY, destinationName);
        await mkdir(dirname(destination), { recursive: true });
        await Bun.write(destination, archiveFile(tarball, archivePath));
      }
    }
    return await complete(sourceDigest);
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}

/**
 * Ensure all five target artifacts exist for the checked-in native source.
 * CI-downloaded artifacts win; otherwise an older published package with the
 * exact same native-source digest is reused without rebuilding Rust.
 */
export async function ensureNativeArtifacts(registries: readonly string[]): Promise<void> {
  const sourceDigest = await nativeBindingSourceDigest();
  if (await complete(sourceDigest)) return;

  for (const registry of registries) {
    const entries = await Promise.all(
      WEBRTC_TARGETS.map(async (target) => [
        target.packageName,
        await metadata(registry, target.packageName),
      ] as const),
    );
    if (entries.some(([, value]) => value === null)) continue;
    const packages = new Map(entries as readonly (readonly [string, RegistryPackage])[]);
    const first = packages.get(WEBRTC_TARGETS[0].packageName)!;
    const candidates = Object.keys(first.versions ?? {}).sort((left, right) => {
      const leftTime = Date.parse(first.time?.[left] ?? "");
      const rightTime = Date.parse(first.time?.[right] ?? "");
      return (Number.isFinite(rightTime) ? rightTime : 0) -
        (Number.isFinite(leftTime) ? leftTime : 0);
    });
    for (const version of candidates) {
      if (await extractVersion(version, packages, sourceDigest)) {
        console.log(`reused WebRTC binaries from @ackerdb/realtime-* @${version}`);
        return;
      }
    }
  }

  fail(
    "no complete WebRTC artifact set matches the checked-in native source\n" +
      "  Run the Native packages workflow for this branch and download its webrtc-* artifacts into\n" +
      `  ${BINDING_DIRECTORY}, then publish again.`,
  );
}

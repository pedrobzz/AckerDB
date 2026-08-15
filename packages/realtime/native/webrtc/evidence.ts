import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import {
  ACKERDB_LIBWEBRTC_REPOSITORY,
  ACKERDB_LIBWEBRTC_REVISION,
  LIBWEBRTC_TAG,
  LIVEKIT_NATIVE_REPOSITORY,
  LIVEKIT_UPSTREAM_REVISION,
  NATIVE_ABI,
  type WEBRTC_TARGETS,
} from "./provenance.ts";

export const TARGET_MANIFEST_SCHEMA_VERSION = 4;
export const DISTRIBUTION_MANIFEST_SCHEMA_VERSION = 1;
// A candidate binds every lockstep publish tarball, not
// merely the native package set. Schema 2 added each source and packed
// package-manifest digest to make that complete release boundary explicit.
export const CANDIDATE_MANIFEST_SCHEMA_VERSION = 2;
export const TARGET_EVIDENCE_FILES = Object.freeze([
  "manifest.json",
  "THIRD_PARTY_NOTICES.txt",
  "PROVENANCE.md",
  "licenses",
] as const);

const nativeRoot = dirname(fileURLToPath(import.meta.url));
const bindingSourceEntries = [".cargo", "Cargo.lock", "Cargo.toml", "build.rs", "src"];

export type WebRtcTarget = (typeof WEBRTC_TARGETS)[number];

export interface TargetBuildManifest {
  readonly schemaVersion: typeof TARGET_MANIFEST_SCHEMA_VERSION;
  readonly version: string;
  readonly nativeAbi: typeof NATIVE_ABI;
  readonly host: string;
  readonly rustTarget: string;
  readonly platformArchABI: string;
  readonly packageName: string;
  readonly file: string;
  readonly sha256: string;
  readonly nativeBindingSourceSha256: string;
  readonly loader: {
    readonly cjsSha256: string;
    readonly dtsSha256: string;
  };
  readonly fork: {
    readonly repository: string;
    readonly revision: string;
    readonly upstreamRepository: string;
    readonly upstreamRevision: string;
  };
  readonly upstream: {
    readonly repository: string;
    readonly libwebrtcTag: string;
    readonly archive: string;
    readonly archiveSha256: string;
    readonly license: {
      readonly file: string;
      readonly sha256: string;
    };
  };
}

export function targetBinaryName(target: WebRtcTarget): string {
  return `ackerdb_webrtc.${target.platformArchABI}.node`;
}

/** Keep the human-readable target provenance bound to the immutable fork pin. */
export function assertProvenanceRevision(provenance: string): void {
  if (!provenance.includes(`at immutable commit \`${ACKERDB_LIBWEBRTC_REVISION}\`.`)) {
    throw new Error("WebRTC provenance does not name the immutable fork revision");
  }
}

export async function sha256File(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

async function filesUnder(path: string): Promise<string[]> {
  const entries = await readdir(path, { withFileTypes: true });
  const files = await Promise.all(entries.map(async (entry) => {
    const entryPath = join(path, entry.name);
    return entry.isDirectory()
      ? filesUnder(entryPath)
      : entry.isFile() ? [entryPath] : [];
  }));
  return files.flat();
}

/** Hash exactly the checked-in Rust binding inputs, never generated artifacts. */
export async function nativeBindingSourceDigest(): Promise<string> {
  const sources = (
    await Promise.all(bindingSourceEntries.map(async (entry) => {
      const path = join(nativeRoot, entry);
      const entries = await readdir(path, { withFileTypes: true }).catch(() => undefined);
      return entries === undefined ? [path] : filesUnder(path);
    }))
  ).flat().sort((left, right) => left.localeCompare(right));
  const hash = createHash("sha256");
  for (const source of sources) {
    hash.update(relative(nativeRoot, source).replaceAll("\\", "/"));
    hash.update("\0");
    hash.update(await readFile(source));
    hash.update("\0");
  }
  return hash.digest("hex");
}

export function assertTargetBuildManifest(
  manifest: TargetBuildManifest,
  target: WebRtcTarget,
  version: string,
  nativeBindingSourceSha256: string,
): void {
  const loader = manifest.loader;
  const fork = manifest.fork;
  const upstream = manifest.upstream;
  const license = upstream?.license;
  if (
    manifest.schemaVersion !== TARGET_MANIFEST_SCHEMA_VERSION ||
    manifest.version !== version ||
    manifest.nativeAbi !== NATIVE_ABI ||
    manifest.host !== target.host ||
    manifest.rustTarget !== target.rustTarget ||
    manifest.platformArchABI !== target.platformArchABI ||
    manifest.packageName !== target.packageName ||
    manifest.file !== targetBinaryName(target) ||
    manifest.nativeBindingSourceSha256 !== nativeBindingSourceSha256 ||
    loader === undefined ||
    !/^[0-9a-f]{64}$/.test(loader.cjsSha256) ||
    !/^[0-9a-f]{64}$/.test(loader.dtsSha256) ||
    fork === undefined ||
    fork.repository !== ACKERDB_LIBWEBRTC_REPOSITORY ||
    fork.revision !== ACKERDB_LIBWEBRTC_REVISION ||
    fork.upstreamRepository !== LIVEKIT_NATIVE_REPOSITORY ||
    fork.upstreamRevision !== LIVEKIT_UPSTREAM_REVISION ||
    upstream === undefined ||
    upstream.repository !== LIVEKIT_NATIVE_REPOSITORY ||
    upstream.libwebrtcTag !== LIBWEBRTC_TAG ||
    upstream.archive !== target.archive ||
    upstream.archiveSha256 !== target.archiveSha256 ||
    license === undefined ||
    license.file !== "licenses/Google-WebRTC-LICENSE.md" ||
    !/^[0-9a-f]{64}$/.test(license.sha256) ||
    !/^[0-9a-f]{64}$/.test(manifest.sha256)
  ) {
    throw new Error(`invalid WebRTC build manifest for ${target.platformArchABI}`);
  }
}

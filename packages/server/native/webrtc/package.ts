import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  LIBWEBRTC_CRATE_SHA256,
  LIBWEBRTC_CRATE_VERSION,
  LIBWEBRTC_TAG,
  LIVEKIT_REPOSITORY,
  LIVEKIT_RUST_SDKS_REVISION,
  NATIVE_ABI,
  WEBRTC_SYS_CRATE_SHA256,
  WEBRTC_SYS_CRATE_VERSION,
  WEBRTC_TARGETS,
} from "./provenance.ts";

interface TargetManifest {
  readonly schemaVersion: 1;
  readonly target: string;
  readonly file: "ackerdb_webrtc.node";
  readonly sha256: string;
  readonly upstream: {
    readonly repository: string;
    readonly libwebrtcTag: string;
    readonly archive: string;
    readonly archiveSha256: string;
  };
}

const root = dirname(fileURLToPath(import.meta.url));
const prebuilds = join(root, "prebuilds");

async function sha256(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

const targets: TargetManifest[] = [];
for (const expected of WEBRTC_TARGETS) {
  const target = expected.target;
  const directory = join(prebuilds, target);
  const entries = await readdir(directory).catch(() => []);
  if (
    !entries.includes("ackerdb_webrtc.node") ||
    !entries.includes("manifest.json")
  ) {
    throw new Error(
      `missing assembled WebRTC prebuild or target manifest for ${target}`,
    );
  }
  const manifest = JSON.parse(
    await readFile(join(directory, "manifest.json"), "utf8"),
  ) as TargetManifest;
  if (
    manifest.schemaVersion !== 1 ||
    manifest.target !== target ||
    manifest.file !== "ackerdb_webrtc.node" ||
    manifest.upstream.repository !== LIVEKIT_REPOSITORY ||
    manifest.upstream.libwebrtcTag !== LIBWEBRTC_TAG ||
    manifest.upstream.archive !== expected.archive ||
    manifest.upstream.archiveSha256 !== expected.archiveSha256
  ) {
    throw new Error(`invalid WebRTC target manifest for ${target}`);
  }
  const actual = await sha256(join(directory, manifest.file));
  if (actual !== manifest.sha256) {
    throw new Error(
      `WebRTC prebuild digest mismatch for ${target}: expected ${manifest.sha256}, received ${actual}`,
    );
  }
  targets.push(manifest);
}

const manifest = {
  schemaVersion: 1,
  nativeAbi: NATIVE_ABI,
  targets,
  build: {
    rustToolchain: "1.94.0",
    bun: "1.3.14",
    upstreamRepository: LIVEKIT_REPOSITORY,
    upstreamRevision: LIVEKIT_RUST_SDKS_REVISION,
    libwebrtcCrate: {
      version: LIBWEBRTC_CRATE_VERSION,
      sha256: LIBWEBRTC_CRATE_SHA256,
    },
    webrtcSysCrate: {
      version: WEBRTC_SYS_CRATE_VERSION,
      sha256: WEBRTC_SYS_CRATE_SHA256,
    },
    sourceProvenance:
      "packages/server/native/webrtc/PROVENANCE.md",
  },
};
await writeFile(
  join(prebuilds, "manifest.json"),
  `${JSON.stringify(manifest, null, 2)}\n`,
  "utf8",
);

const notices = `AckerDB WebRTC native package — third-party notices

LiveKit Rust WebRTC bindings and webrtc-sys
Copyright 2023–2025 LiveKit, Inc.
Licensed under the Apache License, Version 2.0.
Source: https://github.com/livekit/rust-sdks

Google WebRTC
Copyright The WebRTC project authors.
Licensed under a BSD-style license. The complete upstream license corpus is
included in each verified LiveKit libwebrtc archive named in manifest.json.

The source license and notices used to build this package are kept under
packages/server/native/webrtc/licenses.
`;
await writeFile(
  join(prebuilds, "THIRD_PARTY_NOTICES.txt"),
  notices,
  "utf8",
);

const sbom = {
  spdxVersion: "SPDX-2.3",
  dataLicense: "CC0-1.0",
  SPDXID: "SPDXRef-DOCUMENT",
  name: "ackerdb-webrtc-native",
  documentNamespace:
    `https://ackerdb.dev/sbom/webrtc/${targets[0]!.upstream.libwebrtcTag}`,
  creationInfo: {
    created: "2026-07-30T00:00:00Z",
    creators: ["Tool: packages/server/native/webrtc/package.ts"],
  },
  packages: [
    {
      SPDXID: "SPDXRef-AckerDB-WebRTC",
      name: "ackerdb-webrtc",
      versionInfo: `native-abi-${NATIVE_ABI}`,
      downloadLocation: "NOASSERTION",
      filesAnalyzed: false,
      licenseConcluded: "Apache-2.0",
      licenseDeclared: "Apache-2.0",
      supplier: "Organization: AckerDB",
    },
    {
      SPDXID: "SPDXRef-LiveKit-LibWebRTC",
      name: "livekit-libwebrtc",
      versionInfo: targets[0]!.upstream.libwebrtcTag,
      downloadLocation:
        `https://github.com/livekit/rust-sdks/releases/tag/${targets[0]!.upstream.libwebrtcTag}`,
      filesAnalyzed: false,
      licenseConcluded: "BSD-3-Clause",
      licenseDeclared: "BSD-3-Clause",
      supplier: "Organization: LiveKit",
    },
    {
      SPDXID: "SPDXRef-LiveKit-Rust-Bindings",
      name: "livekit-rust-webrtc",
      versionInfo:
        `libwebrtc-${LIBWEBRTC_CRATE_VERSION}_webrtc-sys-${WEBRTC_SYS_CRATE_VERSION}`,
      downloadLocation:
        `${LIVEKIT_REPOSITORY}/tree/${LIVEKIT_RUST_SDKS_REVISION}`,
      filesAnalyzed: false,
      licenseConcluded: "Apache-2.0",
      licenseDeclared: "Apache-2.0",
      supplier: "Organization: LiveKit",
      externalRefs: [
        {
          referenceCategory: "PACKAGE-MANAGER",
          referenceType: "purl",
          referenceLocator:
            `pkg:cargo/libwebrtc@${LIBWEBRTC_CRATE_VERSION}`,
        },
        {
          referenceCategory: "PACKAGE-MANAGER",
          referenceType: "purl",
          referenceLocator:
            `pkg:cargo/webrtc-sys@${WEBRTC_SYS_CRATE_VERSION}`,
        },
        {
          referenceCategory: "OTHER",
          referenceType: "vcs",
          referenceLocator:
            `git+${LIVEKIT_REPOSITORY}.git@${LIVEKIT_RUST_SDKS_REVISION}`,
        },
      ],
    },
  ],
  relationships: [
    {
      spdxElementId: "SPDXRef-AckerDB-WebRTC",
      relationshipType: "DEPENDS_ON",
      relatedSpdxElement: "SPDXRef-LiveKit-Rust-Bindings",
    },
    {
      spdxElementId: "SPDXRef-LiveKit-Rust-Bindings",
      relationshipType: "DEPENDS_ON",
      relatedSpdxElement: "SPDXRef-LiveKit-LibWebRTC",
    },
  ],
};
await writeFile(
  join(prebuilds, "sbom.spdx.json"),
  `${JSON.stringify(sbom, null, 2)}\n`,
  "utf8",
);

console.log(`assembled ${targets.length} verified WebRTC prebuilds`);

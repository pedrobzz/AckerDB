import { createHash } from "node:crypto";
import { NapiCli } from "@napi-rs/cli";
import {
  createReadStream,
  createWriteStream,
  existsSync,
} from "node:fs";
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import {
  TARGET_MANIFEST_SCHEMA_VERSION,
  nativeBindingSourceDigest,
  targetBinaryName,
} from "./evidence.ts";
import {
  ACKERDB_LIBWEBRTC_REPOSITORY,
  ACKERDB_LIBWEBRTC_REVISION,
  LIBWEBRTC_TAG,
  LIVEKIT_NATIVE_REPOSITORY,
  LIVEKIT_UPSTREAM_REVISION,
  NATIVE_ABI,
  webRtcTarget,
} from "./provenance.ts";

const root = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(root, "../../../..");
const targetDefinition = webRtcTarget(`${process.platform}-${process.arch}`);
const archiveName = targetDefinition.archive.replace(/^webrtc-/, "").replace(
  /\.zip$/,
  "",
);
const expectedDigest = targetDefinition.archiveSha256;

const cacheRoot = join(root, ".cache", "libwebrtc", LIBWEBRTC_TAG);
const webrtcDirectory = join(cacheRoot, archiveName);
const digestMarker = join(webrtcDirectory, ".ackerdb-sha256");

async function sha256(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

async function downloadVerified(
  url: string,
  destination: string,
  expected: string,
  label: string,
): Promise<void> {
  const response = await fetch(url);
  if (!response.ok || response.body === null) {
    throw new Error(`failed to download ${label} (${response.status})`);
  }
  await pipeline(
    response.body as unknown as NodeJS.ReadableStream,
    createWriteStream(destination, { flags: "wx" }),
  );
  const actual = await sha256(destination);
  if (actual !== expected) {
    throw new Error(
      `${label} digest mismatch: expected ${expected}, received ${actual}`,
    );
  }
}

async function extractArchive(
  archive: string,
  destination: string,
  label: string,
): Promise<void> {
  await mkdir(destination);
  const command = archive.endsWith(".zip") && process.platform !== "win32"
    ? ["unzip", "-q", archive, "-d", destination]
    : ["tar", "-xf", archive, "-C", destination];
  const unpack = Bun.spawn(command, {
    stdout: "inherit",
    stderr: "inherit",
  });
  if (await unpack.exited !== 0) {
    throw new Error(`failed to extract ${label}`);
  }
}

async function prepareLibWebRtc(): Promise<string> {
  if (
    existsSync(webrtcDirectory) &&
    await readFile(digestMarker, "utf8").catch(() => "") === expectedDigest
  ) {
    return webrtcDirectory;
  }

  await mkdir(cacheRoot, { recursive: true });
  const temporary = await mkdtemp(join(cacheRoot, `.${archiveName}-`));
  const archive = join(temporary, targetDefinition.archive);
  try {
    const url =
      `${LIVEKIT_NATIVE_REPOSITORY}/releases/download/${LIBWEBRTC_TAG}/${targetDefinition.archive}`;
    await downloadVerified(
      url,
      archive,
      expectedDigest,
      `libwebrtc archive for ${targetDefinition.host}`,
    );

    const extracted = join(temporary, "extracted");
    await extractArchive(
      archive,
      extracted,
      `libwebrtc archive for ${targetDefinition.host}`,
    );
    const extractedWebRtc = join(extracted, archiveName);
    if (
      !existsSync(join(extractedWebRtc, "webrtc.ninja")) ||
      !existsSync(join(extractedWebRtc, "LICENSE.md"))
    ) {
      throw new Error(
        `libwebrtc archive for ${targetDefinition.host} is missing its build or license evidence`,
      );
    }
    await writeFile(
      join(extractedWebRtc, ".ackerdb-sha256"),
      expectedDigest,
      "utf8",
    );
    await rm(webrtcDirectory, { recursive: true, force: true });
    await rename(extractedWebRtc, webrtcDirectory);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
  return webrtcDirectory;
}

const verifiedWebRtc = await prepareLibWebRtc();
const previousCustomWebRtc = process.env.LK_CUSTOM_WEBRTC;
process.env.LK_CUSTOM_WEBRTC = verifiedWebRtc;
try {
  const { task } = await new NapiCli().build({
    cwd: repositoryRoot,
    packageJsonPath: "packages/realtime/package.json",
    manifestPath: "packages/realtime/native/webrtc/Cargo.toml",
    targetDir: join(root, "target"),
    outputDir: "packages/realtime/native/webrtc/binding",
    target: targetDefinition.rustTarget,
    release: true,
    platform: true,
    jsBinding: "index.cjs",
    dts: "index.d.cts",
    cargoOptions: ["--locked"],
  });
  await task;
} finally {
  if (previousCustomWebRtc === undefined) {
    delete process.env.LK_CUSTOM_WEBRTC;
  } else {
    process.env.LK_CUSTOM_WEBRTC = previousCustomWebRtc;
  }
}

const packageManifest = JSON.parse(
  await readFile(join(repositoryRoot, "packages/realtime/package.json"), "utf8"),
) as { readonly version?: string };
if (typeof packageManifest.version !== "string") {
  throw new Error("@ackerdb/realtime has no package version");
}

const file = targetBinaryName(targetDefinition);
const destination = join(root, "binding", file);
const evidencePrefix = file.replace(/\.node$/, "");
const archiveLicenseDirectory = join(root, "binding", `${evidencePrefix}.licenses`);
const archiveLicense = join(archiveLicenseDirectory, "Google-WebRTC-LICENSE.md");
await rm(archiveLicenseDirectory, { force: true, recursive: true });
await mkdir(archiveLicenseDirectory, { recursive: true });
await copyFile(join(verifiedWebRtc, "LICENSE.md"), archiveLicense);
await writeFile(
  join(
    root,
    "binding",
    `ackerdb_webrtc.${targetDefinition.platformArchABI}.manifest.json`,
  ),
  `${JSON.stringify({
    schemaVersion: TARGET_MANIFEST_SCHEMA_VERSION,
    version: packageManifest.version,
    nativeAbi: NATIVE_ABI,
    host: targetDefinition.host,
    rustTarget: targetDefinition.rustTarget,
    platformArchABI: targetDefinition.platformArchABI,
    packageName: targetDefinition.packageName,
    file,
    sha256: await sha256(destination),
    nativeBindingSourceSha256: await nativeBindingSourceDigest(),
    loader: {
      cjsSha256: await sha256(join(root, "binding", "index.cjs")),
      dtsSha256: await sha256(join(root, "binding", "index.d.cts")),
    },
    fork: {
      repository: ACKERDB_LIBWEBRTC_REPOSITORY,
      revision: ACKERDB_LIBWEBRTC_REVISION,
      upstreamRepository: LIVEKIT_NATIVE_REPOSITORY,
      upstreamRevision: LIVEKIT_UPSTREAM_REVISION,
    },
    upstream: {
      repository: LIVEKIT_NATIVE_REPOSITORY,
      libwebrtcTag: LIBWEBRTC_TAG,
      archive: targetDefinition.archive,
      archiveSha256: expectedDigest,
      license: {
        file: "licenses/Google-WebRTC-LICENSE.md",
        sha256: await sha256(archiveLicense),
      },
    },
  }, null, 2)}\n`,
  "utf8",
);
const evidence = Bun.spawn(["bun", join(root, "generate-evidence.ts")], {
  cwd: repositoryRoot,
  stdout: "inherit",
  stderr: "inherit",
});
if (await evidence.exited !== 0) {
  throw new Error(
    `failed to generate Cargo evidence for ${targetDefinition.packageName}`,
  );
}
const stage = Bun.spawn(["bun", join(root, "package.ts"), "--host"], {
  cwd: repositoryRoot,
  stdout: "inherit",
  stderr: "inherit",
});
if (await stage.exited !== 0) {
  throw new Error(
    `failed to stage ${targetDefinition.packageName} after the native build`,
  );
}
console.log(destination);

import { createHash } from "node:crypto";
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
import { dirname, join } from "node:path";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import {
  LIBWEBRTC_CRATE_SHA256,
  LIBWEBRTC_CRATE_VERSION,
  LIBWEBRTC_TAG,
  LIVEKIT_REPOSITORY,
  WEBRTC_SYS_CRATE_SHA256,
  WEBRTC_SYS_CRATE_VERSION,
  webRtcTarget,
} from "./provenance.ts";

const root = dirname(fileURLToPath(import.meta.url));
const targetDefinition = webRtcTarget(`${process.platform}-${process.arch}`);
const archiveName = targetDefinition.archive.replace(/^webrtc-/, "").replace(
  /\.zip$/,
  "",
);
const expectedDigest = targetDefinition.archiveSha256;

const cacheRoot = join(root, ".cache", "libwebrtc", LIBWEBRTC_TAG);
const webrtcDirectory = join(cacheRoot, archiveName);
const digestMarker = join(webrtcDirectory, ".ackerdb-sha256");
const crateCacheRoot = join(root, ".cache", "crates");

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
  const unpack = Bun.spawn(["tar", "-xf", archive, "-C", destination], {
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
      `${LIVEKIT_REPOSITORY}/releases/download/${LIBWEBRTC_TAG}/${targetDefinition.archive}`;
    await downloadVerified(
      url,
      archive,
      expectedDigest,
      `libwebrtc archive for ${targetDefinition.target}`,
    );

    const extracted = join(temporary, "extracted");
    await extractArchive(
      archive,
      extracted,
      `libwebrtc archive for ${targetDefinition.target}`,
    );
    const extractedWebRtc = join(extracted, archiveName);
    if (!existsSync(join(extractedWebRtc, "webrtc.ninja"))) {
      throw new Error(
        `libwebrtc archive for ${targetDefinition.target} has an unexpected shape`,
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

interface CrateSource {
  readonly name: "libwebrtc" | "webrtc-sys";
  readonly version: string;
  readonly sha256: string;
}

async function prepareCrateSource(source: CrateSource): Promise<void> {
  const destination = join(crateCacheRoot, source.name);
  const patch = join(root, "patches", `${source.name}.patch`);
  const marker = `${source.sha256}:${await sha256(patch)}`;
  if (
    existsSync(destination) &&
    await readFile(join(destination, ".ackerdb-source"), "utf8").catch(() => "") ===
      marker
  ) {
    return;
  }

  await mkdir(crateCacheRoot, { recursive: true });
  const temporary = await mkdtemp(join(crateCacheRoot, `.${source.name}-`));
  try {
    const archive = join(temporary, `${source.name}.crate`);
    await downloadVerified(
      `https://static.crates.io/crates/${source.name}/${source.name}-${source.version}.crate`,
      archive,
      source.sha256,
      `${source.name} ${source.version} crate`,
    );
    const extracted = join(temporary, "extracted");
    await extractArchive(
      archive,
      extracted,
      `${source.name} ${source.version} crate`,
    );
    const crate = join(extracted, `${source.name}-${source.version}`);
    const apply = Bun.spawn(["git", "apply", "--check", patch], {
      cwd: crate,
      stdout: "inherit",
      stderr: "inherit",
    });
    if (await apply.exited !== 0) {
      throw new Error(
        `AckerDB patch does not apply to ${source.name} ${source.version}`,
      );
    }
    const patched = Bun.spawn(["git", "apply", patch], {
      cwd: crate,
      stdout: "inherit",
      stderr: "inherit",
    });
    if (await patched.exited !== 0) {
      throw new Error(`failed to patch ${source.name} ${source.version}`);
    }
    await writeFile(join(crate, ".ackerdb-source"), marker, "utf8");
    await rm(destination, { recursive: true, force: true });
    await rename(crate, destination);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

const [verifiedWebRtc] = await Promise.all([
  prepareLibWebRtc(),
  prepareCrateSource({
    name: "libwebrtc",
    version: LIBWEBRTC_CRATE_VERSION,
    sha256: LIBWEBRTC_CRATE_SHA256,
  }),
  prepareCrateSource({
    name: "webrtc-sys",
    version: WEBRTC_SYS_CRATE_VERSION,
    sha256: WEBRTC_SYS_CRATE_SHA256,
  }),
]);
const build = Bun.spawn(["cargo", "build", "--release", "--locked"], {
  cwd: root,
  env: {
    ...process.env,
    LK_CUSTOM_WEBRTC: verifiedWebRtc,
  },
  stdout: "inherit",
  stderr: "inherit",
});
const exitCode = await build.exited;
if (exitCode !== 0) process.exit(exitCode);

const library = process.platform === "darwin"
  ? "libackerdb_webrtc.dylib"
  : process.platform === "win32"
    ? "ackerdb_webrtc.dll"
    : "libackerdb_webrtc.so";
const target = `${process.platform}-${process.arch}`;
const destinationDirectory = join(root, "prebuilds", target);
const destination = join(destinationDirectory, "ackerdb_webrtc.node");
await mkdir(destinationDirectory, { recursive: true });
await copyFile(join(root, "target", "release", library), destination);
await writeFile(
  join(destinationDirectory, "manifest.json"),
  `${JSON.stringify({
    schemaVersion: 1,
    target,
    file: "ackerdb_webrtc.node",
    sha256: await sha256(destination),
    upstream: {
      repository: LIVEKIT_REPOSITORY,
      libwebrtcTag: LIBWEBRTC_TAG,
      archive: targetDefinition.archive,
      archiveSha256: expectedDigest,
    },
  }, null, 2)}\n`,
  "utf8",
);
console.log(destination);

import { existsSync } from "node:fs";
import { readFile, rename, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  assertTargetBuildManifest,
  nativeBindingSourceDigest,
  targetBinaryName,
  type TargetBuildManifest,
} from "./evidence.ts";
import { webRtcTarget } from "./provenance.ts";

const nativeRoot = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(nativeRoot, "../../../..");
const bindingDirectory = join(nativeRoot, "binding");
const target = webRtcTarget(`${process.platform}-${process.arch}`);
const manifestPath = join(
  bindingDirectory,
  `${targetBinaryName(target).replace(/\.node$/, "")}.manifest.json`,
);
const packageManifest = JSON.parse(
  await readFile(join(repositoryRoot, "packages/realtime/package.json"), "utf8"),
) as { readonly version?: string };
if (typeof packageManifest.version !== "string") {
  throw new Error("@ackerdb/realtime has no package version");
}

const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as TargetBuildManifest;
assertTargetBuildManifest(
  manifest,
  target,
  packageManifest.version,
  await nativeBindingSourceDigest(),
);

async function run(command: string[]): Promise<void> {
  const process = Bun.spawn(command, {
    cwd: repositoryRoot,
    stdout: "inherit",
    stderr: "inherit",
  });
  if (await process.exited !== 0) {
    throw new Error(`native evidence command failed: ${command.join(" ")}`);
  }
}

const prefix = `ackerdb_webrtc.${target.platformArchABI}`;
const temporarySbom = join(nativeRoot, `${prefix}.sbom.cdx.json`);
const sbom = join(bindingDirectory, `${prefix}.sbom.cdx.json`);
const notices = join(bindingDirectory, `${prefix}.THIRD_PARTY_NOTICES.txt`);
await rm(temporarySbom, { force: true });
await rm(sbom, { force: true });
await rm(notices, { force: true });

await run([
  "cargo",
  "cyclonedx",
  "--manifest-path",
  join(nativeRoot, "Cargo.toml"),
  "--format",
  "json",
  "--target",
  target.rustTarget,
  "--override-filename",
  `${prefix}.sbom.cdx`,
]);
await rename(temporarySbom, sbom);
await run([
  "cargo",
  "about",
  "generate",
  "--manifest-path",
  join(nativeRoot, "Cargo.toml"),
  "--config",
  join(nativeRoot, "about.toml"),
  "--target",
  target.rustTarget,
  "--locked",
  "--fail",
  join(nativeRoot, "THIRD_PARTY_NOTICES.hbs"),
  "--output-file",
  notices,
]);

const archiveLicense = join(
  bindingDirectory,
  `${prefix}.licenses`,
  "Google-WebRTC-LICENSE.md",
);
if (!existsSync(archiveLicense)) {
  throw new Error(`missing verified archive license for ${target.platformArchABI}`);
}

console.log(`generated Cargo evidence for ${target.packageName}`);

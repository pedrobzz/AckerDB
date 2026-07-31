// bun scripts/publish-prerelease.ts <alpha|beta> <current|next-minor> [--demo]
//
// Publishes the WORKING TREE — any branch, dirty is fine — to local Verdaccio
// as one lockstep @ackerdb/* prerelease. No stable-release gates or git tags
// apply. The registry's version list is the counter, so a partial publish is
// recovered by rerunning and taking a fresh number.
import { existsSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  PACKAGES,
  assertRegistryReachable,
  assertWebRtcDistribution,
  fail,
  packageDirectory,
  parseSemver,
  pkgJsonPath,
  registryUrl,
  syncedVersion,
} from "./lib";
import {
  WEBRTC_LOADER_DECLARATION_PATH,
  WEBRTC_LOADER_PATH,
  writeWebRtcLoader,
} from "../packages/realtime/native/webrtc/generate-loader.ts";
import {
  sha256File,
  targetBinaryName,
  type TargetBuildManifest,
} from "../packages/realtime/native/webrtc/evidence.ts";
import { WEBRTC_TARGETS } from "../packages/realtime/native/webrtc/provenance.ts";

const channel = process.argv[2];
if (channel !== "alpha" && channel !== "beta") {
  fail("prerelease channel must be alpha or beta");
}

const target = process.argv[3];
if (target !== "current" && target !== "next-minor") {
  fail("prerelease target must be current or next-minor");
}

const demoMode = process.argv.includes("--demo");
const registry = await registryUrl();
await assertRegistryReachable(registry);

const sources = new Map<string, string>();
for (const pkg of PACKAGES) {
  sources.set(pkg, await Bun.file(pkgJsonPath(pkg)).text());
}
const sourceVersion = syncedVersion((pkg) => sources.get(pkg)!);
const loaderSource = await Bun.file(WEBRTC_LOADER_PATH).text();
const loaderDeclarationSource = await Bun.file(
  WEBRTC_LOADER_DECLARATION_PATH,
).text();
const bindingDirectory = dirname(WEBRTC_LOADER_PATH);
const targetManifestSources = new Map(
  await Promise.all(WEBRTC_TARGETS.map(async (target) => {
    const path = join(
      bindingDirectory,
      targetBinaryName(target).replace(/\.node$/, ".manifest.json"),
    );
    const artifact = Bun.file(path);
    if (!(await artifact.exists())) {
      fail(
        "prerelease publication requires the matching verified CI artifacts " +
          `for all five WebRTC targets in ${bindingDirectory}; missing ${path}`,
      );
    }
    return [path, await artifact.text()] as const;
  })),
);
const [major, minor] = parseSemver(sourceVersion);
const baseVersion =
  target === "current" ? sourceVersion : `${major}.${minor + 1}.0`;

let highest = 0;
const prereleasePattern = new RegExp(
  `^${baseVersion.replaceAll(".", "\\.")}-${channel}\\.(\\d+)$`,
);
for (const pkg of PACKAGES) {
  const response = await fetch(`${registry}/@ackerdb/${pkg}`);
  if (response.status === 404) continue;
  if (!response.ok) {
    fail(`registry query for @ackerdb/${pkg} failed with ${response.status}`);
  }
  const manifest = (await response.json()) as {
    versions?: Record<string, unknown>;
  };
  for (const publishedVersion of Object.keys(manifest.versions ?? {})) {
    const match = prereleasePattern.exec(publishedVersion);
    if (match) highest = Math.max(highest, Number(match[1]));
  }
}

const version = `${baseVersion}-${channel}.${highest + 1}`;
console.log(
  `publishing the working tree as @ackerdb/*@${version} (dist-tag: ${channel}) → ${registry}`,
);

let distributionRetargeted = false;
const restore = async () => {
  for (const pkg of PACKAGES) {
    await Bun.write(pkgJsonPath(pkg), sources.get(pkg)!);
  }
  await Bun.write(WEBRTC_LOADER_PATH, loaderSource);
  await Bun.write(WEBRTC_LOADER_DECLARATION_PATH, loaderDeclarationSource);
  for (const [path, source] of targetManifestSources) {
    await Bun.write(path, source);
  }
  if (distributionRetargeted) {
    assertWebRtcDistribution();
    distributionRetargeted = false;
  }
};

try {
  for (const pkg of PACKAGES) {
    const json = JSON.parse(sources.get(pkg)!) as Record<string, any>;
    json.version = version;
    for (const field of [
      "dependencies",
      "devDependencies",
      "optionalDependencies",
      "peerDependencies",
    ]) {
      const dependencies = json[field] as Record<string, string> | undefined;
      if (!dependencies) continue;
      for (const name of Object.keys(dependencies)) {
        if (name.startsWith("@ackerdb/")) {
          dependencies[name] = `workspace:${version}`;
        }
      }
    }
    await Bun.write(pkgJsonPath(pkg), `${JSON.stringify(json, null, 2)}\n`);
  }
  await writeWebRtcLoader(version);
  const loader = {
    cjsSha256: await sha256File(WEBRTC_LOADER_PATH),
    dtsSha256: await sha256File(WEBRTC_LOADER_DECLARATION_PATH),
  };
  for (const [path, source] of targetManifestSources) {
    const manifest = JSON.parse(source) as TargetBuildManifest;
    await Bun.write(path, `${JSON.stringify({
      ...manifest,
      version,
      loader,
    }, null, 2)}\n`);
  }
  distributionRetargeted = true;
  assertWebRtcDistribution();

  for (const pkg of PACKAGES) {
    console.log(`\npublishing @ackerdb/${pkg}@${version}`);
    const result = Bun.spawnSync(["bun", "publish", "--tag", channel], {
      cwd: packageDirectory(pkg),
      stdout: "inherit",
      stderr: "inherit",
    });
    if (result.exitCode !== 0) {
      throw new Error(
        `publishing @ackerdb/${pkg}@${version} failed — fix the cause and rerun; the next run takes a fresh ${channel} number.`,
      );
    }
  }
} catch (error) {
  await restore();
  fail(error instanceof Error ? error.message : String(error));
}
await restore();
console.log(
  `\n✔ published ${PACKAGES.map((pkg) => `@ackerdb/${pkg}`).join(", ")} at ${version}`,
);

if (!demoMode) process.exit(0);

const demoManifests = ["demo/package.json"];
const demoRoot = JSON.parse(await Bun.file("demo/package.json").text()) as {
  workspaces?: string[];
};
for (const workspace of demoRoot.workspaces ?? []) {
  const baseDirectory = `demo/${workspace.replace(/\/\*$/, "")}`;
  for (const entry of readdirSync(baseDirectory, { withFileTypes: true })) {
    const manifest = `${baseDirectory}/${entry.name}/package.json`;
    if (entry.isDirectory() && existsSync(manifest)) {
      demoManifests.push(manifest);
    }
  }
}

const repinned: string[] = [];
const leftAlone: string[] = [];
for (const path of demoManifests) {
  const json = JSON.parse(await Bun.file(path).text()) as Record<string, any>;
  let changed = false;
  for (const field of [
    "dependencies",
    "devDependencies",
    "optionalDependencies",
    "peerDependencies",
  ]) {
    const dependencies = json[field] as Record<string, string> | undefined;
    if (!dependencies) continue;
    for (const [name, specifier] of Object.entries(dependencies)) {
      if (!name.startsWith("@ackerdb/")) continue;
      if (
        specifier === sourceVersion ||
        prereleasePattern.test(specifier)
      ) {
        if (specifier !== version) {
          dependencies[name] = version;
          changed = true;
        }
      } else {
        leftAlone.push(`${path}: ${name}@${specifier}`);
      }
    }
  }
  if (changed) {
    await Bun.write(path, `${JSON.stringify(json, null, 2)}\n`);
    repinned.push(path);
  }
}

const install = Bun.spawnSync(["bun", "install", "--no-cache"], {
  cwd: "demo",
  stdout: "inherit",
  stderr: "inherit",
});
if (install.exitCode !== 0) {
  fail(
    `demo bun install failed — the pins are already at ${version}; fix the cause and rerun bun install in demo/`,
  );
}

console.log(
  `\n✔ demo repinned to ${version} (${repinned.join(", ")}) and reinstalled`,
);
if (leftAlone.length > 0) {
  console.log(
    `left alone:\n${leftAlone.map((line) => `  ${line}`).join("\n")}`,
  );
}
console.log(
  "restore the demo pins when done testing (they are ordinary tracked edits).",
);

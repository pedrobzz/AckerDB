// bun run release:prepare <patch|minor|major>
//
// Declares the stable version targeted by one topic branch. Every package moves
// in lockstep and the declaration is committed with the branch so GitHub can
// enforce it before the branch reaches canary.
import {
  PACKAGES,
  assertWorkspaceLock,
  fail,
  git,
  parseSemver,
  pkgJsonPath,
  readBunLock,
  syncedVersion,
  tryGit,
} from "../lib.ts";
import {
  WEBRTC_LOADER_REPOSITORY_PATH,
  writeWebRtcLoader,
} from "../../packages/realtime/native/webrtc/generate-loader.ts";

const LEVELS = ["patch", "minor", "major"] as const;
const level = process.argv[2] as (typeof LEVELS)[number] | undefined;
if (!level || !LEVELS.includes(level)) {
  fail("usage: bun run release:prepare <patch|minor|major>");
}

const branch = tryGit("symbolic-ref", "--short", "HEAD");
if (branch === null || branch === "main" || branch === "canary") {
  fail("prepare a release version on a topic branch, never on main or canary");
}
if (tryGit("rev-parse", "-q", "--verify", "MERGE_HEAD")) {
  fail("a merge is in progress — conclude or abort it before preparing a version");
}

const sources = new Map<string, string>();
for (const pkg of PACKAGES) sources.set(pkg, await Bun.file(pkgJsonPath(pkg)).text());

const current = syncedVersion((pkg) => sources.get(pkg)!);
const [major, minor, patch] = parseSemver(current);
const next =
  level === "major" ? `${major + 1}.0.0`
  : level === "minor" ? `${major}.${minor + 1}.0`
  : `${major}.${minor}.${patch + 1}`;

const updatedSources = new Map<string, string>();
for (const pkg of PACKAGES) {
  const manifest = JSON.parse(sources.get(pkg)!) as Record<string, any>;
  manifest.version = next;
  for (const field of [
    "dependencies",
    "devDependencies",
    "optionalDependencies",
    "peerDependencies",
  ]) {
    const dependencies = manifest[field] as Record<string, string> | undefined;
    if (!dependencies) continue;
    for (const name of Object.keys(dependencies)) {
      if (name.startsWith("@ackerdb/")) dependencies[name] = `workspace:${next}`;
    }
  }
  const source = `${JSON.stringify(manifest, null, 2)}\n`;
  updatedSources.set(pkg, source);
  await Bun.write(pkgJsonPath(pkg), source);
}
await writeWebRtcLoader(next);

// Bun does not always refresh version-only workspace snapshots. Updating the
// dependency-free core workspace rebuilds them without changing third-party
// resolutions.
const before = await readBunLock();
const refresh = Bun.spawnSync(
  [
    "bun",
    "update",
    "--filter",
    "@ackerdb/core",
    "--no-save",
    "--lockfile-only",
    "--registry=https://registry.npmjs.org",
  ],
  { stdout: "pipe", stderr: "pipe" },
);
if (refresh.exitCode !== 0) {
  fail(`bun.lock workspace refresh failed:\n${refresh.stderr.toString().trim()}`);
}
const after = await readBunLock();
if (!Bun.deepEquals(before.packages, after.packages)) {
  fail("bun.lock workspace refresh changed the third-party package graph");
}
assertWorkspaceLock(after, (pkg) => updatedSources.get(pkg)!);

const install = Bun.spawnSync(["bun", "install", "--force", "--frozen-lockfile"], {
  stdout: "pipe",
  stderr: "pipe",
});
if (install.exitCode !== 0) {
  fail(`bun install failed after version preparation:\n${install.stderr.toString().trim()}`);
}

git(
  "commit",
  "-m",
  `chore(release): target v${next}`,
  "--",
  ...PACKAGES.map(pkgJsonPath),
  WEBRTC_LOADER_REPOSITORY_PATH,
  "bun.lock",
);

console.log(`prepared ${current} → ${next} across all @ackerdb packages`);
console.log(`publish another local test build at any time with: bun run publish:beta`);
console.log("open the pull request against canary when the branch is ready");

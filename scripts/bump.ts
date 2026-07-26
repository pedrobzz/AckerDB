// bun run bump <patch|minor|major>
// Bumps every published package to the same next version and commits the bump.
// Run it on your feature branch — the merge guard on main requires the bump
// to arrive together with the feat/fix commits it covers.
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
} from "./lib";

const LEVELS = ["patch", "minor", "major"] as const;
const level = process.argv[2] as (typeof LEVELS)[number] | undefined;
if (!level || !LEVELS.includes(level)) fail("usage: bun run bump <patch|minor|major>");

const branch = tryGit("symbolic-ref", "--short", "HEAD");
if (branch === "main" && process.env.ACKERDB_ALLOW_MAIN !== "1") {
  fail("bump on your feature branch, not on main — the bump merges in with the feature.");
}
// git refuses pathspec commits mid-merge; bail before touching any files.
if (tryGit("rev-parse", "-q", "--verify", "MERGE_HEAD")) {
  fail("a merge is in progress — conclude it (git commit) or abort it (git merge --abort) before bumping.");
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
  const json = JSON.parse(sources.get(pkg)!);
  json.version = next;
  // inter-deps are pinned workspace:<version> — bun publish rewrites that to
  // the literal version at pack time (see syncedVersion in lib.ts for why)
  for (const field of ["dependencies", "devDependencies", "peerDependencies"]) {
    const deps = json[field];
    if (!deps) continue;
    for (const name of Object.keys(deps)) {
      if (name.startsWith("@ackerdb/")) deps[name] = `workspace:${next}`;
    }
  }
  const source = JSON.stringify(json, null, 2) + "\n";
  updatedSources.set(pkg, source);
  await Bun.write(pkgJsonPath(pkg), source);
}

// Bun 1.3 does not invalidate workspace snapshots for version-only manifest
// edits. Updating the dependency-free core workspace rebuilds those snapshots
// without updating the resolved package graph. The registry override prevents
// the local Verdaccio proxy URL from being recorded for third-party packages.
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
if (refresh.exitCode !== 0) fail(`bun.lock workspace refresh failed:\n${refresh.stderr.toString().trim()}`);
const after = await readBunLock();
if (!Bun.deepEquals(before.packages, after.packages)) {
  fail("bun.lock workspace refresh changed the resolved third-party package graph");
}
assertWorkspaceLock(after, (pkg) => updatedSources.get(pkg)!);

const install = Bun.spawnSync(["bun", "install", "--force", "--frozen-lockfile"], {
  stdout: "pipe",
  stderr: "pipe",
});
if (install.exitCode !== 0) fail(`bun install failed after bump:\n${install.stderr.toString().trim()}`);

git("commit", "-m", `chore(release): v${next}`, "--", ...PACKAGES.map(pkgJsonPath), "bun.lock");
console.log(`bumped ${current} → ${next} across ${PACKAGES.map((p) => `@ackerdb/${p}`).join(", ")}`);
console.log(`committed as: chore(release): v${next}`);
console.log(`dispatch bun run bench:hetzner in a background worker for v${next}; merge is blocked until its final Hetzner result is committed.`);

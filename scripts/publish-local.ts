// bun run publish:local
// Publishes every package at its synced pinned version to the local
// Verdaccio registry, then tags the release commit as v<version>.
import {
  PACKAGES,
  assertWorkspaceLock,
  fail,
  git,
  pkgJsonPath,
  readBunLock,
  registryUrl,
  syncedVersion,
  tryGit,
} from "./lib";

const REGISTRY = await registryUrl();
const branch = tryGit("symbolic-ref", "--short", "HEAD");
if (branch !== "main") fail("publish from main only — merge your branch first.");
if (git("status", "--porcelain") !== "") fail("working tree is dirty — commit or stash before publishing.");

const sources = new Map<string, string>();
for (const pkg of PACKAGES) sources.set(pkg, await Bun.file(pkgJsonPath(pkg)).text());
const version = syncedVersion((pkg) => sources.get(pkg)!);
assertWorkspaceLock(await readBunLock(), (pkg) => sources.get(pkg)!);

// Publishing from an existing checkout must not inherit Bun's pre-bump
// installed workspace graph. The frozen lock keeps this a reinstall, never an
// opportunistic dependency update.
const install = Bun.spawnSync(["bun", "install", "--force", "--frozen-lockfile"], {
  stdout: "pipe",
  stderr: "pipe",
});
if (install.exitCode !== 0) fail(`bun install failed before publish:\n${install.stderr.toString().trim()}`);
const tag = `v${version}`;

const tagCommit = tryGit("rev-parse", "-q", "--verify", `refs/tags/${tag}^{commit}`);
const head = git("rev-parse", "HEAD");
if (tagCommit && tagCommit !== head) {
  fail(`${tag} is already tagged at ${tagCommit.slice(0, 7)} but HEAD is ${head.slice(0, 7)} — bump before publishing.`);
}

try {
  const ping = await fetch(`${REGISTRY}/-/ping`);
  if (!ping.ok) throw new Error(`ping returned ${ping.status}`);
} catch {
  fail(`registry ${REGISTRY} is not reachable — start it in another terminal: bun run registry`);
}

// A previous run may have been interrupted mid-publish: skip packages that
// already have this version so a re-run resumes instead of dead-ending.
async function isPublished(pkg: string): Promise<boolean> {
  const res = await fetch(`${REGISTRY}/@dbzz/${pkg}`);
  if (res.status === 404) return false;
  if (!res.ok) fail(`registry query for @dbzz/${pkg} failed with ${res.status}`);
  return Boolean((await res.json()).versions?.[version]);
}
const alreadyPublished = new Set<string>();
for (const pkg of PACKAGES) if (await isPublished(pkg)) alreadyPublished.add(pkg);

if (alreadyPublished.size === PACKAGES.length && tagCommit) {
  fail(`@dbzz/*@${version} is already published to ${REGISTRY} — bump before publishing.`);
}

const published: string[] = [];
for (const pkg of PACKAGES) {
  const name = `@dbzz/${pkg}`;
  if (alreadyPublished.has(pkg)) {
    console.log(`skipping ${name}@${version} — already in the registry (resuming an interrupted publish)`);
    published.push(name);
    continue;
  }
  console.log(`\npublishing ${name}@${version} → ${REGISTRY}`);
  // no --registry flag: it would bypass .npmrc and lose the auth token.
  // bun publish resolves the @dbzz scope from the repo-root .npmrc instead.
  const res = Bun.spawnSync(["bun", "publish"], {
    cwd: `packages/${pkg}`,
    stdout: "inherit",
    stderr: "inherit",
  });
  if (res.exitCode !== 0) {
    fail(
      `publishing ${name}@${version} failed.\n` +
        `  Fix the cause and re-run bun run publish:local — it resumes, skipping already-published packages.\n` +
        (published.length > 0
          ? `  Or roll back the partial publish (${published.join(", ")}) with:\n` +
            published.map((p) => `    bunx npm unpublish --force ${p}@${version} --registry ${REGISTRY}`).join("\n") + "\n"
          : "") +
        `  If it was a 401/403: create a registry user once with\n` +
        `    bunx npm adduser --registry ${REGISTRY}`,
    );
  }
  published.push(name);
}

if (!tagCommit) git("tag", tag);
console.log(`\n✔ published ${published.join(", ")} at ${version} and tagged ${tag}`);
console.log(`\nUse it in a project (with @dbzz scoped to ${REGISTRY} in its .npmrc):`);
console.log(`  bun add --exact @dbzz/server@${version} @dbzz/client-react@${version}`);

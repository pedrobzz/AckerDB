// bun run publish:local
// Publishes every package at its synced pinned version to the local
// Verdaccio registry, then tags the release commit as v<version>.
import { readdirSync } from "node:fs";
import {
  PACKAGES,
  assertRegistryReachable,
  assertWorkspaceLock,
  fail,
  git,
  pkgJsonPath,
  readBunLock,
  registryUrl,
  semverGt,
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

const evidencePath = `bench/results/v${version}.json`;
const evidenceFile = Bun.file(evidencePath);
if (!(await evidenceFile.exists())) {
  fail(`cannot publish v${version} without final Hetzner benchmark evidence (${evidencePath})`);
}
const evidence = await evidenceFile.json() as {
  schemaVersion?: unknown;
  release?: { version?: unknown; previousVersion?: unknown; host?: unknown };
  validation?: { dbzzStatus?: unknown };
  performanceAcceptance?: { status?: unknown };
};
// A baseline record (previousVersion null) stands only where no comparison was
// possible: no earlier final evidence exists.
const priorFinals = readdirSync("bench/results").filter((name) => {
  const match = /^v(\d+\.\d+\.\d+)\.json$/.exec(name);
  return match !== null && semverGt(version, match[1]!);
});
const previousOk =
  typeof evidence.release?.previousVersion === "string" ||
  (evidence.release?.previousVersion === null && priorFinals.length === 0);
if (
  evidence.schemaVersion !== 9 ||
  evidence.release?.version !== version ||
  !previousOk ||
  evidence.release?.host !== "hetzner" ||
  // The gate judges DBZZ itself; comparative-leg failures ride in the record.
  evidence.validation?.dbzzStatus !== "passed" ||
  evidence.performanceAcceptance?.status !== "passed"
) {
  fail(`cannot publish v${version}: ${evidencePath} is not a final approved Hetzner release comparison (or baseline)`);
}

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

await assertRegistryReachable(REGISTRY);

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

// bun run publish:local
// Publishes the exact CI-built release candidate to local Verdaccio, then tags
// the release commit. Stable publishing never assembles, packs, or rebuilds.
import { readdirSync } from "node:fs";
import { resolve } from "node:path";
import {
  CANDIDATE_MANIFEST_FILE,
  verifyCandidate,
  type VerifiedCandidate,
} from "../packages/realtime/native/webrtc/candidate.ts";
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
} from "./lib.ts";
import { assertReleaseEvidence } from "./release-evidence.ts";

function candidatePathFromEnvironment(): string {
  const path = process.env.ACKERDB_RELEASE_CANDIDATE;
  if (path === undefined || path === "") {
    fail(
      "stable publication requires ACKERDB_RELEASE_CANDIDATE=/absolute/path/to/" +
        CANDIDATE_MANIFEST_FILE +
        " from the exact-HEAD CI artifact; it never builds a local fallback.",
    );
  }
  return resolve(path);
}

/** The only stable-publish invocation: Bun uploads the candidate's exact bytes. */
export function exactPublishCommand(
  candidate: VerifiedCandidate,
  pkg: string,
): ["bun", "publish", string] {
  const packageName = `@ackerdb/${pkg}`;
  const tarball = candidate.tarballs.get(packageName);
  if (tarball === undefined) {
    throw new Error(`verified release candidate has no tarball for ${packageName}`);
  }
  return ["bun", "publish", tarball];
}

export function matchesVerifiedTarball(
  candidate: VerifiedCandidate,
  packageName: string,
  bytes: ArrayBuffer | Uint8Array,
): boolean {
  const expected = candidate.manifest.tarballs.find(
    (entry) => entry.packageName === packageName,
  )?.sha256;
  if (expected === undefined) {
    throw new Error(`verified release candidate has no digest for ${packageName}`);
  }
  return new Bun.CryptoHasher("sha256").update(bytes).digest("hex") === expected;
}

async function main(): Promise<void> {
  const branch = tryGit("symbolic-ref", "--short", "HEAD");
  if (branch !== "main") fail("publish from main only — merge your branch first.");
  // The gate protects what gets published and tagged. demo/ is a consumer
  // fixture, so its temporary beta pins cannot change a stable candidate.
  if (git("status", "--porcelain", "--", ".", ":!demo") !== "") {
    fail("working tree is dirty outside demo/ — commit or stash before publishing.");
  }

  const sources = new Map<string, string>();
  for (const pkg of PACKAGES) sources.set(pkg, await Bun.file(pkgJsonPath(pkg)).text());
  const version = syncedVersion((pkg) => sources.get(pkg)!);
  assertWorkspaceLock(await readBunLock(), (pkg) => sources.get(pkg)!);

  let candidate: VerifiedCandidate;
  try {
    candidate = await verifyCandidate(candidatePathFromEnvironment(), { checkClean: false });
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }
  if (candidate.manifest.version !== version) {
    fail(`candidate version ${candidate.manifest.version} differs from release version ${version}`);
  }

  const evidencePath = `bench/results/v${version}.json`;
  const evidenceFile = Bun.file(evidencePath);
  if (!(await evidenceFile.exists())) {
    fail(`cannot publish v${version} without final Hetzner benchmark evidence (${evidencePath})`);
  }
  const priorFinals = readdirSync("bench/results").flatMap((name) => {
    const match = /^v(\d+\.\d+\.\d+)\.json$/.exec(name);
    return match !== null && semverGt(version, match[1]!) ? [match[1]!] : [];
  });
  const previousVersion = priorFinals.sort((a, b) => semverGt(a, b) ? -1 : semverGt(b, a) ? 1 : 0)[0] ?? null;
  try {
    assertReleaseEvidence(await evidenceFile.text(), {
      path: evidencePath,
      version,
      previousVersion,
      productRef: "HEAD",
    });
  } catch (error) {
    fail(`cannot publish v${version}: ${error instanceof Error ? error.message : String(error)}`);
  }

  const tag = `v${version}`;
  const tagCommit = tryGit("rev-parse", "-q", "--verify", `refs/tags/${tag}^{commit}`);
  const head = git("rev-parse", "HEAD");
  if (tagCommit && tagCommit !== head) {
    fail(`${tag} is already tagged at ${tagCommit.slice(0, 7)} but HEAD is ${head.slice(0, 7)} — bump before publishing.`);
  }

  // Candidate verification above completed before either of these calls can
  // touch Verdaccio. A bad artifact therefore cannot partially publish.
  const registry = await registryUrl();
  await assertRegistryReachable(registry);

  async function isPublished(pkg: string): Promise<boolean> {
    const response = await fetch(`${registry}/@ackerdb/${pkg}`);
    if (response.status === 404) return false;
    if (!response.ok) fail(`registry query for @ackerdb/${pkg} failed with ${response.status}`);
    const metadata = await response.json() as {
      readonly versions?: Readonly<Record<
        string,
        { readonly dist?: { readonly tarball?: unknown } }
      >>;
    };
    const published = metadata.versions?.[version];
    if (published === undefined) return false;
    const tarballUrl = published.dist?.tarball;
    if (typeof tarballUrl !== "string") {
      fail(`registry metadata for @ackerdb/${pkg}@${version} has no tarball URL`);
    }
    const tarballResponse = await fetch(tarballUrl);
    if (!tarballResponse.ok) {
      fail(
        `registry tarball for @ackerdb/${pkg}@${version} returned ${tarballResponse.status}`,
      );
    }
    if (!matchesVerifiedTarball(
      candidate,
      `@ackerdb/${pkg}`,
      await tarballResponse.arrayBuffer(),
    )) {
      fail(
        `@ackerdb/${pkg}@${version} already exists with bytes that differ from the verified candidate`,
      );
    }
    return true;
  }

  const alreadyPublished = new Set<string>();
  for (const pkg of PACKAGES) if (await isPublished(pkg)) alreadyPublished.add(pkg);

  if (alreadyPublished.size === PACKAGES.length && tagCommit) {
    fail(`@ackerdb/*@${version} is already published to ${registry} — bump before publishing.`);
  }

  const published: string[] = [];
  for (const pkg of PACKAGES) {
    const name = `@ackerdb/${pkg}`;
    if (alreadyPublished.has(pkg)) {
      console.log(`skipping ${name}@${version} — already in the registry (resuming an interrupted publish)`);
      published.push(name);
      continue;
    }
    console.log(`\npublishing ${name}@${version} → ${registry}`);
    // No --registry flag: it would bypass the scoped auth in .npmrc. The
    // positional tarball is the already-verified CI artifact, not a pack step.
    const result = Bun.spawnSync(exactPublishCommand(candidate, pkg), {
      cwd: ".",
      stdout: "inherit",
      stderr: "inherit",
    });
    if (result.exitCode !== 0) {
      fail(
        `publishing ${name}@${version} failed.\n` +
          `  Fix the cause and re-run bun run publish:local — it resumes, skipping already-published packages.\n` +
          (published.length > 0
            ? `  Or roll back the partial publish (${published.join(", ")}) with:\n` +
              published.map((publishedName) => `    bunx npm unpublish --force ${publishedName}@${version} --registry ${registry}`).join("\n") + "\n"
            : "") +
          "  If it was a 401/403: create a registry user once with\n" +
          `    bunx npm adduser --registry ${registry}`,
      );
    }
    published.push(name);
  }

  if (!tagCommit) git("tag", tag);
  console.log(`\n✔ published ${published.join(", ")} at ${version} and tagged ${tag}`);
  console.log(`\nUse it in a project (with @ackerdb scoped to ${registry} in its .npmrc):`);
  console.log(`  bun add --exact @ackerdb/server@${version} @ackerdb/client-react@${version}`);
}

if (import.meta.main) await main();

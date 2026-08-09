import {
  PACKAGES,
  fail,
  pkgJsonPath,
  tryGit,
} from "../lib.ts";

type Version = readonly [major: number, minor: number, patch: number];

function parseVersion(value: string): Version {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(value);
  if (!match) throw new Error(`${value} is not a stable x.y.z version`);
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

export type ReleaseLevel = "major" | "minor" | "patch";

export function exactNextLevel(base: string, head: string): ReleaseLevel | null {
  const [baseMajor, baseMinor, basePatch] = parseVersion(base);
  const [headMajor, headMinor, headPatch] = parseVersion(head);
  if (headMajor === baseMajor + 1 && headMinor === 0 && headPatch === 0) return "major";
  if (headMajor === baseMajor && headMinor === baseMinor + 1 && headPatch === 0) return "minor";
  if (headMajor === baseMajor && headMinor === baseMinor && headPatch === basePatch + 1) return "patch";
  return null;
}

export function accumulatedLevel(base: string, head: string): ReleaseLevel | null {
  const [baseMajor, baseMinor, basePatch] = parseVersion(base);
  const [headMajor, headMinor, headPatch] = parseVersion(head);
  if (headMajor > baseMajor) return "major";
  if (headMajor < baseMajor) return null;
  if (headMinor > baseMinor) return "minor";
  if (headMinor < baseMinor) return null;
  return headPatch > basePatch ? "patch" : null;
}

/**
 * Every lockstep manifest that exists at `ref`.
 *
 * A package the pull request *introduces* has no manifest at the base, and that
 * is not a violation — it is what adding a package to the set looks like. The
 * lockstep rule is about the packages that are there: at the head every one of
 * them exists, so nothing the invariant covers goes unchecked, while reading
 * the head's package list against an older tree would make the very commit
 * that adds a package the one commit that cannot pass.
 */
function manifestsAt(ref: string): ReadonlyMap<string, Record<string, any>> {
  const found = new Map<string, Record<string, any>>();
  for (const pkg of PACKAGES) {
    const manifest = tryGit("show", `${ref}:${pkgJsonPath(pkg)}`);
    if (manifest !== null) found.set(pkg, JSON.parse(manifest) as Record<string, any>);
  }
  return found;
}

export function releaseVersionAt(ref: string): string {
  const manifests = manifestsAt(ref);
  const versions = new Set(
    [...manifests.values()].map((manifest) => manifest.version as unknown),
  );
  if (versions.size !== 1 || typeof [...versions][0] !== "string") {
    // The count is read off what was found rather than spelled, so adding a
    // lockstep package cannot leave this message asserting a number that is no
    // longer true — it is the one an operator reads when the check fails.
    throw new Error(`all ${manifests.size} packages at ${ref} must share one version`);
  }
  const version = [...versions][0] as string;
  parseVersion(version);
  for (const [pkg, manifest] of manifests) {
    for (const field of [
      "dependencies",
      "devDependencies",
      "optionalDependencies",
      "peerDependencies",
    ]) {
      for (const [name, specifier] of Object.entries(manifest[field] ?? {})) {
        if (name.startsWith("@ackerdb/") && specifier !== `workspace:${version}`) {
          throw new Error(
            `${pkgJsonPath(pkg)} at ${ref} has ${field}.${name}=${String(specifier)}, expected workspace:${version}`,
          );
        }
      }
    }
  }
  return version;
}

async function assertCanaryPublished(version: string): Promise<void> {
  const pattern = new RegExp(`^${version.replaceAll(".", "\\.")}-canary\\.\\d+$`);
  for (const pkg of PACKAGES) {
    const response = await fetch(
      `https://registry.npmjs.org/${encodeURIComponent(`@ackerdb/${pkg}`)}`,
    );
    if (!response.ok) {
      throw new Error(`@ackerdb/${pkg} has no public npm canary for v${version}`);
    }
    const metadata = await response.json() as {
      readonly versions?: Readonly<Record<string, unknown>>;
    };
    if (!Object.keys(metadata.versions ?? {}).some((candidate) => pattern.test(candidate))) {
      throw new Error(`@ackerdb/${pkg} has no public npm canary for v${version}`);
    }
  }
}

export async function assertReleasePolicy(input: {
  readonly baseBranch: string;
  readonly headBranch: string;
  readonly baseSha: string;
  readonly headSha: string;
  readonly author: string;
  readonly urgent: boolean;
  readonly requirePublishedCanary?: boolean;
}): Promise<{ readonly version: string; readonly level: ReleaseLevel | null }> {
  if (input.baseBranch !== "canary" && input.baseBranch !== "main") {
    throw new Error("release pull requests may target only canary or main");
  }
  if (input.baseBranch === "main" && input.headBranch !== "canary") {
    if (
      !input.headBranch.startsWith("hotfix/") ||
      input.author.toLowerCase() !== "pedrobzz" ||
      !input.urgent
    ) {
      throw new Error(
        "main accepts only canary, or a Pedro-authored hotfix/* PR labeled release:urgent",
      );
    }
  }

  const baseVersion = releaseVersionAt(input.baseSha);
  const version = releaseVersionAt(input.headSha);
  if (input.baseBranch === "canary" && version === baseVersion) {
    return { version, level: null };
  }
  const promotesCanary = input.baseBranch === "main" && input.headBranch === "canary";
  const level = promotesCanary
    ? accumulatedLevel(baseVersion, version)
    : exactNextLevel(baseVersion, version);
  if (level === null) {
    throw new Error(
      promotesCanary
        ? `canary v${version} must be newer than main v${baseVersion}`
        : input.baseBranch === "canary"
          ? `v${version} must equal canary v${baseVersion} for a canary.N iteration, ` +
            "or declare exactly one step with bun run release:prepare <level>"
          : `v${version} is not exactly one major, minor, or patch step after base v${baseVersion}; ` +
            "rebase and run bun run release:prepare <level> again",
    );
  }
  if (
    input.baseBranch === "main" &&
    input.headBranch === "canary" &&
    input.requirePublishedCanary !== false
  ) {
    await assertCanaryPublished(version);
  }
  return { version, level };
}

if (import.meta.main) {
  const [baseBranch, headBranch, baseSha, headSha, author, urgentValue] = process.argv.slice(2);
  if (!baseBranch || !headBranch || !baseSha || !headSha || !author || !urgentValue) {
    fail(
      "usage: bun scripts/ci/release-policy.ts <base-branch> <head-branch> <base-sha> <head-sha> <author> <true|false>",
    );
  }
  try {
    const result = await assertReleasePolicy({
      baseBranch,
      headBranch,
      baseSha,
      headSha,
      author,
      urgent: urgentValue === "true",
    });
    console.log(
      result.level === null
        ? `release policy: canary iteration → v${result.version}-canary.N`
        : `release policy: ${result.level} → v${result.version}`,
    );
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }
}

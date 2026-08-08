// bun scripts/ci/test-affected.ts
//
// Runs the affected-package test suites Fast CI selected. `changes.ts` decides
// *which* packages are affected; this decides what running them means. Both
// read the package set from `lib.ts`, so the workflow no longer restates it —
// a package added there is picked up by classification and execution together,
// instead of passing classification and then failing an allow-list in YAML.
import { join } from "node:path";
import { PUBLIC_PACKAGES, packageDirectory } from "../lib.ts";

/** The repository root, resolved from this file rather than the caller's cwd. */
const REPOSITORY_ROOT = join(import.meta.dir, "../..");

export type PublicPackage = typeof PUBLIC_PACKAGES[number];

/**
 * Read the `test_packages` output back into a checked list.
 *
 * The classifier only ever emits public packages, so an unknown name means the
 * workflow expression did not carry what we think it did. That fails the job:
 * silently running no tests is the one outcome a selective CI must never have.
 */
export function affectedPackages(raw: string | undefined): readonly PublicPackage[] {
  if (raw === undefined || raw.trim() === "") {
    throw new Error("TEST_PACKAGES is required");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`TEST_PACKAGES is not valid JSON: ${raw}`);
  }
  if (!Array.isArray(parsed)) {
    throw new Error("TEST_PACKAGES must be a JSON array");
  }
  const known = new Set<string>(PUBLIC_PACKAGES);
  if (parsed.some((name) => typeof name !== "string" || !known.has(name))) {
    throw new Error("affected package output contains an unknown package");
  }
  return parsed as readonly PublicPackage[];
}

/**
 * The test path for one package, so the runner and its test agree on it.
 *
 * Absolute, always: `bun test` treats a bare relative path as a *filter* and
 * crawls the whole working tree to resolve it, holding a descriptor per
 * directory until pipe-backed child spawns start failing silently. A checkout
 * carrying agent worktrees or a vendored source mirror is enough to trigger
 * it, so the path may never be relative to wherever the runner was invoked.
 */
export function testPath(pkg: PublicPackage): string {
  return join(REPOSITORY_ROOT, packageDirectory(pkg), "test");
}

if (import.meta.main) {
  for (const pkg of affectedPackages(process.env.TEST_PACKAGES)) {
    const result = Bun.spawnSync(["bun", "test", testPath(pkg)], {
      stdout: "inherit",
      stderr: "inherit",
    });
    if (result.exitCode !== 0) process.exit(result.exitCode);
  }
}

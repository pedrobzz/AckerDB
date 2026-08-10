import { appendFileSync } from "node:fs";
import {
  PACKAGES,
  PUBLIC_PACKAGES,
  git,
  packageDirectory,
  pkgJsonPath,
} from "../lib.ts";

interface ChangeSet {
  readonly files: readonly string[];
  readonly testPackages: readonly string[];
  readonly code: boolean;
  readonly native: boolean;
  readonly performance: boolean;
  readonly verifyPackages: boolean;
  readonly mcp: boolean;
  readonly workflows: boolean;
}

function sourcePackage(file: string): string | undefined {
  for (const pkg of PUBLIC_PACKAGES) {
    const directory = `${packageDirectory(pkg)}/`;
    if (
      file.startsWith(directory) &&
      file !== pkgJsonPath(pkg) &&
      (file.includes("/src/") || file.includes("/test/"))
    ) {
      return pkg;
    }
  }
  return undefined;
}

function packageGraph(ref: string): ReadonlyMap<string, ReadonlySet<string>> {
  const dependents = new Map<string, Set<string>>(
    PUBLIC_PACKAGES.map((pkg) => [pkg, new Set<string>()]),
  );
  const byName = new Map(PUBLIC_PACKAGES.map((pkg) => [`@ackerdb/${pkg}`, pkg]));
  for (const pkg of PUBLIC_PACKAGES) {
    const manifest = JSON.parse(git("show", `${ref}:${pkgJsonPath(pkg)}`)) as Record<string, any>;
    for (const field of [
      "dependencies",
      "devDependencies",
      "optionalDependencies",
      "peerDependencies",
    ]) {
      for (const name of Object.keys(manifest[field] ?? {})) {
        const dependency = byName.get(name);
        if (dependency !== undefined) dependents.get(dependency)!.add(pkg);
      }
    }
  }
  return dependents;
}

function dependentClosure(
  changed: ReadonlySet<string>,
  dependents: ReadonlyMap<string, ReadonlySet<string>>,
): Set<string> {
  const result = new Set(changed);
  const queue = [...changed];
  while (queue.length > 0) {
    for (const dependent of dependents.get(queue.shift()!) ?? []) {
      if (result.has(dependent)) continue;
      result.add(dependent);
      queue.push(dependent);
    }
  }
  return result;
}

export function classifyChanges(base: string, head: string): ChangeSet {
  const files = git("diff", "--name-only", `${base}...${head}`)
    .split("\n")
    .filter(Boolean);
  const directlyChanged = new Set(files.flatMap((file) => {
    const pkg = sourcePackage(file);
    return pkg === undefined ? [] : [pkg];
  }));
  const packageOrder = new Map<string, number>(PACKAGES.map((pkg, index) => [pkg, index]));
  const testPackages = [...dependentClosure(directlyChanged, packageGraph(head))]
    .sort((left, right) => packageOrder.get(left)! - packageOrder.get(right)!);

  const native = nativeInputsChanged(files);
  const performance = performanceInputsChanged(files) || measuredDependenciesChanged(base, head);
  const verifyPackages = verifyPackagesInputsChanged(files);
  const mcp = testPackages.some((pkg) => pkg === "core" || pkg === "server" || pkg === "cli") ||
    files.some((file) => file.startsWith("scripts/mcp-conformance"));
  const workflows = files.some((file) => file.startsWith(".github/workflows/"));
  const code = codeInputsChanged(files);
  return { files, testPackages, code, native, performance, verifyPackages, mcp, workflows };
}

/** The packages whose code the benchmark workload actually executes. */
const MEASURED_PACKAGES = Object.freeze(["core", "client", "server", "cli"]);

const DEPENDENCY_FIELDS = Object.freeze([
  "dependencies",
  "peerDependencies",
  "optionalDependencies",
]);

/**
 * Whether a measured package's third-party dependencies moved. A dependency
 * update changes the executable product without touching a single line of
 * source, so a path list alone would report a successful no-op for it.
 *
 * Workspace `@ackerdb/*` entries are excluded deliberately: every release step
 * rewrites all twelve of them in lockstep, and a version bump that ships the
 * same code is exactly the case the benchmark must not spend a runner on.
 */
export function measuredDependenciesChanged(base: string, head: string): boolean {
  const externals = (ref: string): string =>
    JSON.stringify(MEASURED_PACKAGES.map((pkg) => {
      const manifest = JSON.parse(git("show", `${ref}:${pkgJsonPath(pkg)}`)) as Record<string, unknown>;
      return DEPENDENCY_FIELDS.map((field) => {
        const entries = Object.entries((manifest[field] ?? {}) as Record<string, string>);
        return entries.filter(([name]) => !name.startsWith("@ackerdb/")).sort();
      });
    }));
  return externals(base) !== externals(head);
}

export function codeInputsChanged(files: readonly string[]): boolean {
  return files.some((file) =>
    !file.endsWith(".md") && !file.startsWith("docs/") && !file.startsWith("wiki/")
  );
}

/**
 * What changes the tarballs a release would produce, and therefore needs the
 * packed-package gate.
 *
 * The native directories are here because those packages publish built
 * binaries.
 */
export function verifyPackagesInputsChanged(files: readonly string[]): boolean {
  return files.some((file) =>
    file === "package.json" ||
    file === "bun.lock" ||
    file.endsWith("/package.json") ||
    file.startsWith("scripts/release/") ||
    file.startsWith("scripts/verify-packages") ||
    file.startsWith("scripts/packed-consumer") ||
    file.startsWith("packages/realtime/native/") ||
    file.startsWith("packages/realtime-native/")
  );
}

export function performanceInputsChanged(files: readonly string[]): boolean {
  return files.some((file) =>
    file.startsWith("packages/core/src/") ||
    file.startsWith("packages/client/src/") ||
    file.startsWith("packages/server/src/") ||
    file === "packages/cli/src/app/codegen.ts" ||
    file === "packages/cli/src/app/config.ts" ||
    file === "packages/cli/src/app/manifest.ts" ||
    (file.startsWith("bench/") && !file.endsWith(".md") && !file.startsWith("bench/results/")) ||
    file === ".github/workflows/ci.yml" ||
    file === "scripts/ci/changes.ts"
  );
}

export function nativeInputsChanged(files: readonly string[]): boolean {
  return files.some((file) =>
    file === ".github/workflows/native.yml" ||
    /^packages\/realtime\/native\/webrtc\/(?:\.cargo\/|src\/|test\/|Cargo\.(?:lock|toml)$|about\.toml$|build\.(?:rs|ts)$|candidate\.ts$|deny\.toml$|evidence\.ts$|generate-evidence\.ts$|package\.ts$|provenance\.ts$|THIRD_PARTY_NOTICES\.hbs$)/.test(file)
  );
}

if (import.meta.main) {
  const [base, head] = process.argv.slice(2);
  if (!base || !head) throw new Error("usage: bun scripts/ci/changes.ts <base-sha> <head-sha>");
  const changes = classifyChanges(base, head);
  const output = process.env.GITHUB_OUTPUT;
  if (output) {
    appendFileSync(output, [
      `test_packages=${JSON.stringify(changes.testPackages)}`,
      `code=${changes.code}`,
      `native=${changes.native}`,
      `performance=${changes.performance}`,
      `verify_packages=${changes.verifyPackages}`,
      `mcp=${changes.mcp}`,
      `workflows=${changes.workflows}`,
      "",
    ].join("\n"));
  }
  console.log(JSON.stringify(changes, null, 2));
}

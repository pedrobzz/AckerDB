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
  readonly telemetry: boolean;
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
  const performance = performanceInputsChanged(files);
  const telemetry = files.some((file) => file.startsWith("packages/server/src/telemetry/")) ||
    Bun.spawnSync(
      ["git", "diff", "--quiet", "-G", "(telemetry|Telemetry)", `${base}...${head}`, "--", "packages/*/src", "bench"],
      { stdout: "ignore", stderr: "ignore" },
    ).exitCode === 1;
  const verifyPackages = verifyPackagesInputsChanged(files);
  const mcp = testPackages.some((pkg) => pkg === "core" || pkg === "server" || pkg === "cli") ||
    files.some((file) => file.startsWith("scripts/mcp-conformance"));
  const workflows = files.some((file) => file.startsWith(".github/workflows/"));
  const code = codeInputsChanged(files);
  return { files, testPackages, code, native, performance, telemetry, verifyPackages, mcp, workflows };
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
 * binaries; `packages/studio/` is here for the same reason, and it is the
 * stronger case: nothing else in the pipeline builds its bundle, so without
 * this a pull request touching only the SPA would skip the one check that
 * proves it compiles, packs, and opens.
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
    file.startsWith("packages/realtime-native/") ||
    file.startsWith("packages/studio/")
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
      `telemetry=${changes.telemetry}`,
      `verify_packages=${changes.verifyPackages}`,
      `mcp=${changes.mcp}`,
      `workflows=${changes.workflows}`,
      "",
    ].join("\n"));
  }
  console.log(JSON.stringify(changes, null, 2));
}

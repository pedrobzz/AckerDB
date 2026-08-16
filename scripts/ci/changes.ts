import { appendFileSync } from "node:fs";
import {
  PACKAGES,
  git,
  packageDirectory,
  pkgJsonPath,
} from "../lib.ts";

interface ChangeSet {
  readonly files: readonly string[];
  readonly testPackages: readonly string[];
  readonly code: boolean;
  readonly verifyPackages: boolean;
  readonly workflows: boolean;
}

function sourcePackage(file: string): string | undefined {
  for (const pkg of PACKAGES) {
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
    PACKAGES.map((pkg) => [pkg, new Set<string>()]),
  );
  const byName = new Map(PACKAGES.map((pkg) => [`@ackerdb/${pkg}`, pkg]));
  for (const pkg of PACKAGES) {
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

  const verifyPackages = verifyPackagesInputsChanged(files);
  const workflows = files.some((file) => file.startsWith(".github/workflows/"));
  const code = codeInputsChanged(files);
  return {
    files,
    testPackages,
    code,
    verifyPackages,
    workflows,
  };
}

export function codeInputsChanged(files: readonly string[]): boolean {
  return files.some((file) =>
    !file.endsWith(".md") && !file.startsWith("docs/") && !file.startsWith("wiki/")
  );
}

/**
 * What changes the tarballs a release would produce, and therefore needs the
 * packed-package gate.
 */
export function verifyPackagesInputsChanged(files: readonly string[]): boolean {
  return files.some((file) =>
    file === "package.json" ||
    file === "bun.lock" ||
    file.endsWith("/package.json") ||
    file.startsWith("scripts/release/") ||
    file.startsWith("scripts/verify-packages") ||
    file.startsWith("scripts/packed-consumer")
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
      `verify_packages=${changes.verifyPackages}`,
      `workflows=${changes.workflows}`,
      "",
    ].join("\n"));
  }
  console.log(JSON.stringify(changes, null, 2));
}

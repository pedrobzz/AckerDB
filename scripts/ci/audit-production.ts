/**
 * The production dependency audit.
 *
 * `bun audit` audits the whole workspace: every dependency of every member,
 * development and production alike. That is the wrong question for a release
 * gate. An advisory in the Expo fixture's transitive tree, or in the native
 * build toolchain, describes a machine that builds AckerDB — never a machine
 * that runs it — and a gate that cannot tell those apart is a gate the repo
 * learns to ignore.
 *
 * So the audit is asked its question somewhere the answer means something: a
 * throwaway project holding exactly what the published packages declare as
 * runtime dependencies, resolved under the same overrides the workspace pins.
 * Nothing a developer installs reaches it, and an advisory it reports is one
 * that reaches a user.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PUBLIC_PACKAGES } from "../lib.ts";

const ROOT = join(import.meta.dir, "..", "..");

interface Manifest {
  readonly dependencies?: Readonly<Record<string, string>>;
  readonly optionalDependencies?: Readonly<Record<string, string>>;
  readonly overrides?: Readonly<Record<string, string>>;
}

/**
 * What the published packages ship, keyed by name. Workspace siblings are
 * dropped: each is audited through its own entry, and a `workspace:` range
 * means nothing outside this repository.
 *
 * Optional dependencies count. An optional install is still an install, and
 * the platform tarballs are how the native code reaches a user's machine.
 */
export function productionDependencies(
  manifestOf: (pkg: string) => Manifest,
): Readonly<Record<string, string>> {
  const shipped: Record<string, string> = {};
  for (const pkg of PUBLIC_PACKAGES) {
    const manifest = manifestOf(pkg);
    const declared = {
      ...manifest.dependencies,
      ...manifest.optionalDependencies,
    };
    for (const [name, range] of Object.entries(declared)) {
      if (range.startsWith("workspace:")) continue;
      const existing = shipped[name];
      if (existing !== undefined && existing !== range) {
        throw new Error(
          `@ackerdb packages disagree on "${name}": "${existing}" and "${range}".` +
            " One published dependency, one version.",
        );
      }
      shipped[name] = range;
    }
  }
  return shipped;
}

if (import.meta.main) {
  const root = await Bun.file(join(ROOT, "package.json")).json() as Manifest;
  const dependencies = productionDependencies((pkg) =>
    require(join(ROOT, "packages", pkg, "package.json")) as Manifest);

  const directory = mkdtempSync(join(tmpdir(), "ackerdb-production-audit-"));
  try {
    writeFileSync(
      join(directory, "package.json"),
      // The overrides travel with the dependencies. They are how this repo
      // pins a transitive version an advisory forced, so auditing without
      // them audits a tree nobody ships.
      `${JSON.stringify({
        name: "ackerdb-production-audit",
        private: true,
        dependencies,
        ...(root.overrides === undefined ? {} : { overrides: root.overrides }),
      }, null, 2)}\n`,
    );
    const install = Bun.spawnSync(["bun", "install", "--silent"], {
      cwd: directory,
      stdout: "inherit",
      stderr: "inherit",
    });
    if (install.exitCode !== 0) {
      throw new Error(`resolving the published dependency tree failed (${install.exitCode})`);
    }
    console.log(
      `Auditing ${Object.keys(dependencies).length} published runtime dependencies` +
        ` across ${PUBLIC_PACKAGES.length} packages.`,
    );
    const audit = Bun.spawnSync(["bun", "audit"], {
      cwd: directory,
      stdout: "inherit",
      stderr: "inherit",
    });
    process.exit(audit.exitCode ?? 1);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

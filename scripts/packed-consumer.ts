import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  PACKAGES,
  pkgJsonPath,
  syncedVersion,
} from "./lib.ts";
import { withPackageLicense } from "./release/package-license.ts";

export interface PackageManifest {
  readonly name?: string;
  readonly version?: string;
  readonly license?: string;
  readonly main?: string;
  readonly files?: readonly string[];
  readonly cpu?: readonly string[];
  readonly os?: readonly string[];
  readonly libc?: readonly string[];
  readonly exports?: Record<string, unknown>;
  readonly dependencies?: Record<string, string>;
  readonly devDependencies?: Record<string, string>;
  readonly optionalDependencies?: Record<string, string>;
  readonly peerDependencies?: Record<string, string>;
}

export interface PackedConsumer {
  readonly root: string;
  readonly directory: string;
  readonly consumerDir: string;
  readonly version: string;
  cleanup(): void;
}

export async function runCommand(
  args: string[],
  cwd: string,
  env: Readonly<Record<string, string | undefined>> = process.env,
): Promise<string> {
  const child = Bun.spawn(args, { cwd, env, stdout: "pipe", stderr: "pipe" });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  if (exitCode !== 0) {
    throw new Error(
      `${args.join(" ")} failed in ${cwd} (exit ${exitCode})\n${stdout}${stderr}`,
    );
  }
  return stdout.trim();
}

export function readManifest(path: string): PackageManifest {
  return JSON.parse(readFileSync(path, "utf8")) as PackageManifest;
}

export async function createPackedConsumer(name: string): Promise<PackedConsumer> {
  const root = resolve(import.meta.dir, "..");
  const version = syncedVersion((pkg) =>
    readFileSync(join(root, pkgJsonPath(pkg)), "utf8")
  );
  const bunTypesVersion = readManifest(
    join(root, "node_modules/@types/bun/package.json"),
  ).version;
  if (bunTypesVersion === undefined) throw new Error("root @types/bun version is unavailable");
  const directory = mkdtempSync(join(tmpdir(), `${name}-`));
  const packDir = join(directory, "packs");
  const consumerDir = join(directory, "consumer");
  mkdirSync(packDir);
  mkdirSync(consumerDir);

  try {
    const tarballs: Record<string, string> = {};
    for (const pkg of PACKAGES) {
      const packageName = `@ackerdb/${pkg}`;
      const output = await withPackageLicense(pkg, (packageRoot) => runCommand([
        process.execPath,
        "pm",
        "pack",
        "--destination",
        packDir,
        "--ignore-scripts",
        "--quiet",
      ], packageRoot));
      const packedTarball = output.split("\n").at(-1)?.trim();
      if (packedTarball === undefined || packedTarball === "") {
        throw new Error(`bun pm pack did not report a tarball for ${packageName}`);
      }
      tarballs[packageName] = `file:${packedTarball}`;
    }

    const dependencies = Object.fromEntries(
      PACKAGES.map((pkg) => [
        `@ackerdb/${pkg}`,
        tarballs[`@ackerdb/${pkg}`]!,
      ]),
    );
    writeFileSync(join(consumerDir, "package.json"), JSON.stringify({
      name,
      private: true,
      type: "module",
      dependencies,
      devDependencies: { "@types/bun": bunTypesVersion },
      // The release is intentionally unpublished: force transitive @ackerdb exact
      // versions to the same public tarballs while preserving packed manifests.
      overrides: dependencies,
    }, null, 2));
    // A clean consumer resolves open transitive ranges at install time, so a
    // registry package published hours ago could reach this gate before anyone
    // reviewed it. Quarantine consumer resolution to day-old releases; the
    // workspace's advisory-floored excludes (bunfig.toml) carry over so each
    // audited pin stays installable. File-path @ackerdb tarballs are unaffected.
    const workspaceInstall = (Bun.TOML.parse(
      readFileSync(join(root, "bunfig.toml"), "utf8"),
    ) as { install?: { minimumReleaseAgeExcludes?: readonly string[] } }).install;
    writeFileSync(join(consumerDir, "bunfig.toml"), [
      "[install]",
      "minimumReleaseAge = 86400",
      `minimumReleaseAgeExcludes = ${JSON.stringify(workspaceInstall?.minimumReleaseAgeExcludes ?? [])}`,
      "",
    ].join("\n"));
    // The consumer must be installed from the freshly packed tarballs alone. A
    // shared bun cache can satisfy name@version lookups with stale contents and
    // make this gate verify a cache entry instead of the release artifacts.
    await runCommand([
      process.execPath,
      "install",
      "--ignore-scripts",
      "--registry=https://registry.npmjs.org",
    ], consumerDir, {
      ...process.env,
      BUN_INSTALL_CACHE_DIR: join(directory, "bun-install-cache"),
    });

    let active = true;
    return Object.freeze({
      root,
      directory,
      consumerDir,
      version,
      cleanup: () => {
        if (!active) return;
        active = false;
        rmSync(directory, { recursive: true, force: true });
      },
    });
  } catch (error) {
    rmSync(directory, { recursive: true, force: true });
    throw error;
  }
}

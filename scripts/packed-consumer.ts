import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { PACKAGES, pkgJsonPath, syncedVersion } from "./lib.ts";

export interface PackageManifest {
  readonly name?: string;
  readonly version?: string;
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
    const dependencies: Record<string, string> = {};
    for (const pkg of PACKAGES) {
      const output = await runCommand([
        process.execPath,
        "pm",
        "pack",
        "--destination",
        packDir,
        "--ignore-scripts",
        "--quiet",
      ], join(root, "packages", pkg));
      const tarball = output.split("\n").at(-1)?.trim();
      if (tarball === undefined || tarball === "") {
        throw new Error(`bun pm pack did not report a tarball for @ackerdb/${pkg}`);
      }
      dependencies[`@ackerdb/${pkg}`] = `file:${tarball}`;
    }

    writeFileSync(join(consumerDir, "package.json"), JSON.stringify({
      name,
      private: true,
      type: "module",
      dependencies,
      devDependencies: { "@types/bun": bunTypesVersion },
      // The release is intentionally unpublished: force transitive @ackerdb exact
      // versions to the same six tarballs while preserving packed manifests.
      overrides: dependencies,
    }, null, 2));
    await runCommand([
      process.execPath,
      "install",
      "--ignore-scripts",
      "--registry=https://registry.npmjs.org",
    ], consumerDir);

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

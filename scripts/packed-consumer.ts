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
  NATIVE_PACKAGES,
  PACKAGES,
  PUBLIC_PACKAGES,
  pkgJsonPath,
  syncedVersion,
} from "./lib.ts";
import { verifyCandidate } from "../packages/realtime/native/webrtc/candidate.ts";
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
  const candidatePath = process.env.ACKERDB_RELEASE_CANDIDATE;
  const candidate = candidatePath === undefined
    ? undefined
    : await verifyCandidate(resolve(candidatePath), { checkClean: false });
  const version = candidate?.manifest.version ?? syncedVersion((pkg) =>
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
      if (candidate !== undefined) {
        const tarball = candidate.tarballs.get(packageName);
        if (tarball === undefined) {
          throw new Error(`verified release candidate has no tarball for ${packageName}`);
        }
        tarballs[packageName] = `file:${tarball}`;
        continue;
      }
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
      PUBLIC_PACKAGES.map((pkg) => [
        `@ackerdb/${pkg}`,
        tarballs[`@ackerdb/${pkg}`]!,
      ]),
    );
    const optionalDependencies = Object.fromEntries(
      NATIVE_PACKAGES.map((pkg) => [
        `@ackerdb/${pkg}`,
        tarballs[`@ackerdb/${pkg}`]!,
      ]),
    );

    writeFileSync(join(consumerDir, "package.json"), JSON.stringify({
      name,
      private: true,
      type: "module",
      dependencies,
      optionalDependencies,
      devDependencies: { "@types/bun": bunTypesVersion },
      // The release is intentionally unpublished: force transitive @ackerdb exact
      // versions to the same public tarballs while preserving packed manifests.
      // The native tarballs stay optional. Bun materializes every local-file
      // optional package, so the gate verifies their host metadata separately
      // and proves that the generated loader resolves the current host.
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

import { copyFileSync, existsSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { packageDirectory } from "../lib.ts";

const repositoryRoot = resolve(import.meta.dir, "../..");

export const FSL_LICENSE = "FSL-1.1-ALv2";

export async function withPackageLicense<T>(
  pkg: string,
  operation: (directory: string) => T | Promise<T>,
): Promise<T> {
  const directory = join(repositoryRoot, packageDirectory(pkg));
  const packagedLicense = join(directory, "LICENSE.md");
  if (existsSync(packagedLicense)) {
    throw new Error(`${packageDirectory(pkg)}/LICENSE.md must be materialized only while packing`);
  }
  copyFileSync(join(repositoryRoot, "LICENSE.md"), packagedLicense);
  try {
    return await operation(directory);
  } finally {
    rmSync(packagedLicense, { force: true });
  }
}

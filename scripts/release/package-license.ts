import { copyFileSync, existsSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { NATIVE_PACKAGES, packageDirectory } from "../lib.ts";

const repositoryRoot = resolve(import.meta.dir, "../..");
const nativePackages = new Set<string>(NATIVE_PACKAGES);

export const FSL_LICENSE = "FSL-1.1-ALv2";
export const NATIVE_LICENSE = "Apache-2.0";

function sourceLicense(pkg: string): string {
  return nativePackages.has(pkg)
    ? join(repositoryRoot, "packages/realtime-native/LICENSE")
    : join(repositoryRoot, "LICENSE.md");
}

export async function withPackageLicense<T>(
  pkg: string,
  operation: (directory: string) => T | Promise<T>,
): Promise<T> {
  const directory = join(repositoryRoot, packageDirectory(pkg));
  const packagedLicense = join(directory, "LICENSE.md");
  if (existsSync(packagedLicense)) {
    throw new Error(`${packageDirectory(pkg)}/LICENSE.md must be materialized only while packing`);
  }
  copyFileSync(sourceLicense(pkg), packagedLicense);
  try {
    return await operation(directory);
  } finally {
    rmSync(packagedLicense, { force: true });
  }
}

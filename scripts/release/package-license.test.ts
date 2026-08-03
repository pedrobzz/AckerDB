import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { NATIVE_PACKAGES, PACKAGES } from "../lib.ts";
import {
  FSL_LICENSE,
  NATIVE_LICENSE,
  withPackageLicense,
} from "./package-license.ts";

describe("published package licenses", () => {
  test("materializes the declared license in every package tarball input", async () => {
    const nativePackages = new Set<string>(NATIVE_PACKAGES);
    for (const pkg of PACKAGES) {
      let packagedLicense = "";
      await withPackageLicense(pkg, async (directory) => {
        const manifest = await Bun.file(join(directory, "package.json")).json();
        const expected = nativePackages.has(pkg) ? NATIVE_LICENSE : FSL_LICENSE;
        expect(manifest.license).toBe(expected);
        packagedLicense = join(directory, "LICENSE.md");
        const source = await Bun.file(packagedLicense).text();
        expect(source).toContain(
          nativePackages.has(pkg)
            ? "Apache License\n                           Version 2.0"
            : "Functional Source License, Version 1.1, Apache 2.0 Future License",
        );
      });
      expect(existsSync(packagedLicense)).toBe(false);
    }
  });
});

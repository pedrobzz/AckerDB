import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { PACKAGES } from "../lib.ts";
import { FSL_LICENSE, withPackageLicense } from "./package-license.ts";

describe("published package licenses", () => {
  test("materializes the declared license in every package tarball input", async () => {
    for (const pkg of PACKAGES) {
      let packagedLicense = "";
      await withPackageLicense(pkg, async (directory) => {
        const manifest = await Bun.file(join(directory, "package.json")).json();
        expect(manifest.license).toBe(FSL_LICENSE);
        packagedLicense = join(directory, "LICENSE.md");
        const source = await Bun.file(packagedLicense).text();
        expect(source).toContain(
          "Functional Source License, Version 1.1, Apache 2.0 Future License",
        );
      });
      expect(existsSync(packagedLicense)).toBe(false);
    }
  });
});

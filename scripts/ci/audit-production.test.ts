import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { PUBLIC_PACKAGES } from "../lib.ts";
import { productionDependencies } from "./audit-production.ts";

const ROOT = join(import.meta.dir, "..", "..");
const realManifest = (pkg: string) =>
  require(join(ROOT, "packages", pkg, "package.json"));

describe("production dependency audit", () => {
  test("the audited set is what the published packages ship", () => {
    const shipped = productionDependencies(realManifest);
    // A gate auditing nothing passes for the wrong reason, so the shape of
    // the real workspace is asserted rather than assumed: something ships,
    // and every entry is a resolvable range.
    expect(Object.keys(shipped).length).toBeGreaterThan(0);
    for (const range of Object.values(shipped)) {
      expect(range).not.toStartWith("workspace:");
    }
  });

  test("workspace siblings are audited through their own entry, not twice", () => {
    const shipped = productionDependencies(realManifest);
    for (const pkg of PUBLIC_PACKAGES) {
      expect(shipped).not.toHaveProperty(`@ackerdb/${pkg}`);
    }
  });

  test("optional dependencies ship, so they are audited", () => {
    const shipped = productionDependencies((pkg) =>
      pkg === PUBLIC_PACKAGES[0]
        ? { optionalDependencies: { "some-native-binding": "1.2.3" } }
        : {});
    expect(shipped).toEqual({ "some-native-binding": "1.2.3" });
  });

  test("two packages cannot ship one dependency at two versions", () => {
    expect(() =>
      productionDependencies((pkg) => ({
        dependencies: { jose: pkg === PUBLIC_PACKAGES[0] ? "6.2.3" : "6.3.0" },
      }))
    ).toThrow(/disagree on "jose"/);
  });
});

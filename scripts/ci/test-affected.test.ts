import { describe, expect, test } from "bun:test";
import { PUBLIC_PACKAGES } from "../lib.ts";
import { affectedPackages, testPath } from "./test-affected.ts";

describe("affected package selection", () => {
  test("accepts every package the classifier can emit, in the order given", () => {
    const every = JSON.stringify(PUBLIC_PACKAGES);
    expect(affectedPackages(every)).toEqual([...PUBLIC_PACKAGES]);
    expect(affectedPackages('["server","cli"]')).toEqual(["server", "cli"]);
    expect(affectedPackages("[]")).toEqual([]);
  });

  test("refuses anything the classifier could not have produced", () => {
    expect(() => affectedPackages('["core","bench"]')).toThrow(
      "affected package output contains an unknown package",
    );
    // Native packages are never test targets: they carry no test directory.
    expect(() => affectedPackages('["realtime-darwin-arm64"]')).toThrow(
      "affected package output contains an unknown package",
    );
    expect(() => affectedPackages('[1]')).toThrow(
      "affected package output contains an unknown package",
    );
    expect(() => affectedPackages('{"core":true}')).toThrow(
      "TEST_PACKAGES must be a JSON array",
    );
    expect(() => affectedPackages("not json")).toThrow("TEST_PACKAGES is not valid JSON");
    // An empty value means the workflow expression did not expand; running
    // nothing quietly is exactly the failure a selective CI must not have.
    expect(() => affectedPackages(undefined)).toThrow("TEST_PACKAGES is required");
    expect(() => affectedPackages("")).toThrow("TEST_PACKAGES is required");
  });

  test("resolves the same suite paths the workflow used to inline", () => {
    for (const pkg of PUBLIC_PACKAGES) {
      expect(testPath(pkg)).toBe(`./packages/${pkg}/test`);
    }
  });
});

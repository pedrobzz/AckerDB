import { describe, expect, test } from "bun:test";
import {
  codeInputsChanged,
  verifyPackagesInputsChanged,
} from "./changes.ts";

describe("repository check selection", () => {
  test("skips typechecks and boundary checks when only documentation changed", () => {
    expect(codeInputsChanged([
      "README.md",
      "docs/releases.md",
      "wiki/bun.md",
      ".github/pull_request_template.md",
    ])).toBe(false);
  });

  test("keeps typechecks for any code or configuration change", () => {
    expect(codeInputsChanged(["packages/core/src/protocol.ts"])).toBe(true);
    expect(codeInputsChanged(["bun.lock"])).toBe(true);
    expect(codeInputsChanged([".github/workflows/ci.yml"])).toBe(true);
    expect(codeInputsChanged(["README.md", "scripts/lib.ts"])).toBe(true);
  });

  test("packs and verifies whenever a published package's built contents could change", () => {
    expect(verifyPackagesInputsChanged(["bun.lock"])).toBe(true);
    expect(verifyPackagesInputsChanged(["packages/client/package.json"])).toBe(true);
    expect(verifyPackagesInputsChanged(["scripts/release/publish.ts"])).toBe(true);
    expect(verifyPackagesInputsChanged(["packages/server/src/app/registry.ts"])).toBe(false);
  });
});

import { describe, expect, test } from "bun:test";
import {
  codeInputsChanged,
  nativeBuildInputsChanged,
  nativeTestInputsChanged,
  performanceInputsChanged,
  verifyPackagesInputsChanged,
  websiteInputsChanged,
} from "./changes.ts";

describe("website CI selection", () => {
  test("selects the independent website for every file it owns", () => {
    expect(websiteInputsChanged([
      "website/src/router.tsx",
      "website/content/docs/get-started.mdx",
      "website/bun.lock",
    ])).toBe(true);
    expect(websiteInputsChanged(["packages/core/package.json"])).toBe(true);
    expect(websiteInputsChanged([".bun-version"])).toBe(true);
    expect(websiteInputsChanged([
      "docs/releases.md",
      "packages/core/src/protocol.ts",
    ])).toBe(false);
  });

  test("does not route website code through repository package checks", () => {
    expect(codeInputsChanged([
      "website/src/router.tsx",
      "website/vite.config.ts",
    ])).toBe(false);
  });

  test("keeps the private website manifest outside package publication verification", () => {
    expect(verifyPackagesInputsChanged(["website/package.json"])).toBe(false);
    expect(verifyPackagesInputsChanged(["packages/server/package.json"])).toBe(true);
  });
});

describe("native CI selection", () => {
  test("does not compile Rust for routine release or realtime TypeScript work", () => {
    expect(nativeBuildInputsChanged([
      "packages/realtime-native/darwin-arm64/package.json",
      "packages/realtime/native/webrtc/binding/index.cjs",
      "packages/realtime/native/webrtc/test/public-session-fixture.ts",
      "packages/realtime/src/session.ts",
      "scripts/release/publish.ts",
    ])).toBe(false);
  });

  test("compiles every target when a real native input changes", () => {
    expect(nativeBuildInputsChanged(["packages/realtime/native/webrtc/src/peer.rs"]))
      .toBe(true);
    expect(nativeBuildInputsChanged(["packages/realtime/native/webrtc/Cargo.lock"]))
      .toBe(true);
    expect(nativeBuildInputsChanged(["packages/realtime/native/webrtc/evidence.ts"]))
      .toBe(true);
    expect(nativeBuildInputsChanged([".github/workflows/native.yml"]))
      .toBe(true);
    expect(nativeBuildInputsChanged([
      "packages/realtime/native/webrtc/test/candidate.test.ts",
    ])).toBe(true);
    expect(nativeBuildInputsChanged([
      "packages/realtime/native/webrtc/test/distribution.test.ts",
    ])).toBe(true);
  });

  test("runs native tests without rebuilding unchanged binaries", () => {
    expect(nativeTestInputsChanged([
      "packages/realtime/native/webrtc/test/public-session-fixture.ts",
    ])).toBe(true);
    expect(nativeTestInputsChanged([
      "packages/realtime/native/webrtc/src/peer.rs",
    ])).toBe(false);
    expect(nativeTestInputsChanged([
      "packages/realtime/native/webrtc/test/native-engine.test.ts",
    ])).toBe(true);
    expect(nativeTestInputsChanged([
      "packages/realtime/native/webrtc/test/public-session.test.ts",
    ])).toBe(true);
    expect(nativeTestInputsChanged([
      "packages/realtime/native/webrtc/test/candidate.test.ts",
      "packages/realtime/native/webrtc/test/distribution.test.ts",
    ])).toBe(false);
  });
});

describe("benchmark selection", () => {
  test("runs only for code and harness inputs exercised by the benchmark", () => {
    expect(performanceInputsChanged([
      "packages/core/src/protocol.ts",
    ])).toBe(true);
    expect(performanceInputsChanged([
      "packages/client/src/client.ts",
    ])).toBe(true);
    expect(performanceInputsChanged([
      "packages/server/src/runtime/runtime.ts",
    ])).toBe(true);
    expect(performanceInputsChanged([
      "packages/cli/src/app/manifest.ts",
    ])).toBe(true);
    expect(performanceInputsChanged([
      "bench/workload.ts",
    ])).toBe(true);
    expect(performanceInputsChanged([
      ".github/workflows/ci.yml",
    ])).toBe(true);
  });

  test("does not spend benchmark time on non-performance changes", () => {
    expect(performanceInputsChanged([
      "README.md",
      "docs/releases.md",
      "packages/core/test/protocol.test.ts",
      "packages/cache/src/storage/store.ts",
      "packages/client-react/src/provider.tsx",
      "packages/realtime/src/session.ts",
      "packages/realtime/native/webrtc/src/peer.rs",
      "packages/server/package.json",
      "bun.lock",
      ".github/workflows/native.yml",
    ])).toBe(false);
  });
});

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
    expect(verifyPackagesInputsChanged(["packages/realtime-native/darwin-arm64/README.md"]))
      .toBe(true);
    expect(verifyPackagesInputsChanged([
      "packages/realtime/native/webrtc/test/public-session-fixture.ts",
    ])).toBe(false);
    expect(verifyPackagesInputsChanged(["packages/server/src/app/registry.ts"])).toBe(false);
  });
});

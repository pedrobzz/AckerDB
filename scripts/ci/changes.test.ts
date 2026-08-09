import { describe, expect, test } from "bun:test";
import {
  codeInputsChanged,
  nativeInputsChanged,
  performanceInputsChanged,
  telemetryInputsChanged,
  verifyPackagesInputsChanged,
} from "./changes.ts";

describe("native CI selection", () => {
  test("does not compile Rust for routine release or realtime TypeScript work", () => {
    expect(nativeInputsChanged([
      "packages/realtime-native/darwin-arm64/package.json",
      "packages/realtime/native/webrtc/binding/index.cjs",
      "packages/realtime/src/session.ts",
      "scripts/release/publish.ts",
    ])).toBe(false);
  });

  test("compiles every target when a real native input changes", () => {
    expect(nativeInputsChanged(["packages/realtime/native/webrtc/src/peer.rs"])).toBe(true);
    expect(nativeInputsChanged(["packages/realtime/native/webrtc/Cargo.lock"])).toBe(true);
    expect(nativeInputsChanged(["packages/realtime/native/webrtc/evidence.ts"])).toBe(true);
    expect(nativeInputsChanged([".github/workflows/native.yml"])).toBe(true);
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

describe("telemetry profile selection", () => {
  const unreachable = "0000000000000000000000000000000000000000";

  test("selects the profiles from the telemetry directories without consulting git", () => {
    // No commit range is valid here: a path under either telemetry directory is
    // enough on its own, so the probe below must never run.
    expect(telemetryInputsChanged(unreachable, unreachable, [
      "packages/server/src/telemetry/storage/store.ts",
    ])).toBe(true);
    expect(telemetryInputsChanged(unreachable, unreachable, [
      "packages/server/src/runtime/telemetry/sampler.ts",
    ])).toBe(true);
  });

  test("fails loudly when git cannot classify the range", () => {
    // The old classifier read any non-matching exit code as "no telemetry
    // changed", which would silently drop the only profiles that make a
    // telemetry regression visible.
    expect(() => telemetryInputsChanged(unreachable, unreachable, ["README.md"]))
      .toThrow(/could not classify telemetry changes/);
  });

  test("reads a real range and finds the telemetry work in it", () => {
    expect(telemetryInputsChanged("HEAD", "HEAD", ["README.md"])).toBe(false);
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
    // The Studio bundle is built by the packing gate and by nothing else, so a
    // pull request touching only the SPA must still reach it.
    expect(verifyPackagesInputsChanged(["packages/studio/src/app/connect.tsx"])).toBe(true);
    expect(verifyPackagesInputsChanged(["packages/studio/vite.config.ts"])).toBe(true);
    expect(verifyPackagesInputsChanged(["bun.lock"])).toBe(true);
    expect(verifyPackagesInputsChanged(["packages/realtime-native/darwin-arm64/README.md"]))
      .toBe(true);
    expect(verifyPackagesInputsChanged(["packages/server/src/app/registry.ts"])).toBe(false);
    expect(verifyPackagesInputsChanged(["docs/studio.md"])).toBe(false);
  });
});

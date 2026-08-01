import { describe, expect, test } from "bun:test";
import { nativeInputsChanged } from "./changes.ts";

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

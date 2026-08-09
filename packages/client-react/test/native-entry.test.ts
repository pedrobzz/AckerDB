import { describe, expect, mock, test } from "bun:test";
// Registers happy-dom before any React module loads — every test file in this
// suite must do this first (see ackerdb-test-support/dom) because `bun test` shares
// one process and React initializes against the globals it first sees.
import "ackerdb-test-support/dom";

// The real Expo and React Native modules only run inside a React Native app,
// so the native entry is exercised here with module mocks standing in for the
// three platform imports. What matters — and is asserted — is the composition
// seam: which module the capabilities call, what they forward, and that the
// native entry exposes exactly the shared public surface.

import { FakeAppState } from "./support/app-state.ts";

const expoFetchCalls: unknown[][] = [];
const expoFetchResponse = { ok: true };
mock.module("expo/fetch", () => ({
  fetch: (...args: unknown[]) => {
    expoFetchCalls.push(args);
    return Promise.resolve(expoFetchResponse);
  },
}));
mock.module("expo-crypto", () => ({
  getRandomValues: (array: Uint32Array) => {
    array[0] = 0x8000_0000; // deterministic: maps to exactly 0.5
    return array;
  },
}));
mock.module("react-native", () => ({ AppState: FakeAppState }));

const nativeEntry = await import("../src/index.native.ts");
const browserEntry = await import("../src/index.ts");
const { withExpoCapabilities } = await import("../src/native/capabilities.ts");

const config = { url: "http://127.0.0.1:9", credential: { kind: "anonymous" } } as const;

describe("index.native entry", () => {
  test("exposes exactly the shared runtime surface", () => {
    expect(Object.keys(nativeEntry).sort()).toEqual(Object.keys(browserEntry).sort());
  });

  test("shadows only AckerDBProvider; every other export is the shared object", () => {
    expect(nativeEntry.AckerDBProvider).not.toBe(browserEntry.AckerDBProvider);
    expect(nativeEntry.useFileUpload).toBe(browserEntry.useFileUpload);
    for (const key of Object.keys(browserEntry)) {
      if (key === "AckerDBProvider") continue;
      expect(nativeEntry[key as keyof typeof nativeEntry]).toBe(
        browserEntry[key as keyof typeof browserEntry],
      );
    }
  });
});

describe("withExpoCapabilities", () => {
  test("defaults fetch to the named expo/fetch export and forwards call shape", async () => {
    const composed = withExpoCapabilities(config);
    const init = { method: "POST", headers: { a: "b" }, body: "x" };
    const response = await composed.fetch!("http://127.0.0.1:9/api/stream/ticks", init);
    expect(response).toBe(expoFetchResponse as unknown as Response);
    expect(expoFetchCalls.at(-1)).toEqual(["http://127.0.0.1:9/api/stream/ticks", init]);
  });

  test("defaults randomness to Expo Crypto with the client's [0, 1) construction", () => {
    const composed = withExpoCapabilities(config);
    expect(composed.random!()).toBe(0.5);
  });

  test("injects a WebSocket factory", () => {
    expect(typeof withExpoCapabilities(config).createWebSocket).toBe("function");
  });

  test("defaults the lifecycle source to the AppState observer", () => {
    expect(typeof withExpoCapabilities(config).lifecycle).toBe("function");
  });

  test("explicitly configured capabilities win over the Expo defaults", () => {
    const explicitFetch = (() => Promise.reject(new Error("unused"))) as never;
    const explicitRandom = () => 0.25;
    const explicitLifecycle = () => () => {};
    const composed = withExpoCapabilities({
      ...config,
      fetch: explicitFetch,
      random: explicitRandom,
      lifecycle: explicitLifecycle,
    });
    expect(composed.fetch).toBe(explicitFetch);
    expect(composed.random).toBe(explicitRandom);
    expect(composed.lifecycle).toBe(explicitLifecycle);
  });

  test("own properties holding undefined still receive the Expo defaults", () => {
    const composed = withExpoCapabilities({
      ...config,
      fetch: undefined,
      random: undefined,
      createWebSocket: undefined,
      lifecycle: undefined,
    });
    expect(typeof composed.fetch).toBe("function");
    expect(composed.random!()).toBe(0.5);
    expect(typeof composed.createWebSocket).toBe("function");
    expect(typeof composed.lifecycle).toBe("function");
  });

  test("does not disturb the configuration values that key the provider lifetime", () => {
    const composed = withExpoCapabilities(config);
    expect(composed.url).toBe(config.url);
    expect(composed.credential).toBe(config.credential);
  });
});

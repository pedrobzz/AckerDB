import { fetch as expoFetch, type FetchRequestInit } from "expo/fetch";
import { getRandomValues } from "expo-crypto";
import type { AckerDBFetch, AckerDBWebSocket, AckerDBWebSocketFactory } from "@ackerdb/client";
import type { AckerDBProviderConfig } from "../provider.tsx";
import { appStateLifecycle } from "./lifecycle.ts";

/**
 * Expo implementations for the ackerdb client capability seams. This module
 * (with ./lifecycle.ts) is the only place that imports Expo or React Native
 * packages, and it is reachable only from the `react-native` conditional
 * entry — browser bundles never resolve it.
 *
 * `expo` and `expo-crypto` are optional peers at the manifest level (npm
 * cannot express a platform-conditional requirement), but they are mandatory
 * on native: when they are missing, Metro fails this module's imports at
 * bundle time — a clear resolution error, never a late transport failure.
 */

// The named `expo/fetch` export, not the React Native global: it is the
// implementation with true byte `ReadableStream` response bodies, which ackerdb
// procedures and SSE acknowledgement depend on (stock RN fetch only buffers
// whole responses). Importing it by name stays correct even when the
// application opts its global fetch back to the stock implementation. The
// client only ever passes `method`/`headers`/`body`/`signal` — all inside
// Expo's accepted init shape — and consumes the WHATWG response subset
// (`ok`, `status`, `body` streaming, `json`) that `FetchResponse` implements,
// so the two narrowing casts below are sound.
const nativeFetch: AckerDBFetch = (url, init) =>
  expoFetch(url, init as FetchRequestInit) as unknown as Promise<Response>;

// UUIDv7 session and mutation identities need cryptographic randomness, and
// Hermes has no Web Crypto global. Expo Crypto is the platform source; the
// [0, 1) construction matches the client's own SYSTEM_RANDOM exactly. Never
// Math.random — mutation replay identity must not be guessable or collide.
const nativeRandom = (): number => {
  const value = new Uint32Array(1);
  getRandomValues(value);
  return value[0]! / 0x1_0000_0000;
};

// React Native's global WebSocket is the platform transport (a documented RN
// networking API backed by native sockets); Expo has no separate named
// WebSocket module. It is injected explicitly so the native choice is pinned
// here rather than inherited from the client's browser-oriented default.
const nativeCreateWebSocket: AckerDBWebSocketFactory = (url) =>
  new WebSocket(url) as unknown as AckerDBWebSocket;

/**
 * Default the capability seams to the Expo implementations, mirroring the
 * base client's `options.x ?? SYSTEM_X` defaulting: an explicitly configured
 * capability wins, but an own property holding `undefined` (a common
 * config-builder shape) still receives the Expo default — the client's
 * browser-oriented system fallbacks must never engage on native.
 */
export function withExpoCapabilities(config: AckerDBProviderConfig): AckerDBProviderConfig {
  return {
    ...config,
    fetch: config.fetch ?? nativeFetch,
    random: config.random ?? nativeRandom,
    createWebSocket: config.createWebSocket ?? nativeCreateWebSocket,
    lifecycle: config.lifecycle ?? appStateLifecycle,
  };
}

import { test } from "bun:test";
import { createBundledRealtimeEngine } from "../../../src/realtime/native/engine.ts";
import {
  PUBLIC_SESSION_TIMEOUT_MS,
  verifyPublicRealtimeSession,
  type PublicSessionEngine,
} from "./public-session-fixture.ts";

test(
  "public AckerDB client exchanges typed events, tracks, procedures, and transactions through bundled libwebrtc",
  () => verifyPublicRealtimeSession(
    () => createBundledRealtimeEngine() as PublicSessionEngine,
  ),
  PUBLIC_SESSION_TIMEOUT_MS * 2,
);

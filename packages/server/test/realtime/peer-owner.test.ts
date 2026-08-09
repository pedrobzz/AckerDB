import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  Engine,
  PRODUCTION_LIMITS,
  Registry,
  Runtime,
  defineSchema,
  realtime,
  reconcile,
  serve,
  type AckerDBServer,
} from "@ackerdb/server";
import {
  ACKERDB_VERSION,
  decode,
  encode,
  parseRealtimeOfferResponse,
  parseRealtimePrepareResponse,
} from "@ackerdb/core";
import type { RealtimeRuntimeModule } from "../../src/realtime/host.ts";
import {
  REALTIME_HUB_DEFAULTS,
  RealtimeHub,
} from "../../../realtime/src/hub.ts";
import { createTurnConfiguration } from "../../../realtime/src/turn.ts";
import {
  TestPeerConnection,
  testRealtimeEngine,
} from "../../../realtime/test/support.ts";

const schema = defineSchema({});
const assistant = realtime({
  args: {},
  clientEvents: {},
  serverEvents: {},
  access: "public",
  handler: () => {},
});

interface Fixture {
  readonly base: string;
  readonly directory: string;
  readonly engine: Engine;
  readonly runtime: Runtime;
  readonly server: AckerDBServer;
}

const fixtures: Fixture[] = [];

afterEach(async () => {
  await Promise.all(fixtures.splice(0).map(async ({ directory, engine, runtime, server }) => {
    await server.drain().catch(() => {});
    await runtime.drain().catch(() => {});
    engine.close("clean");
    rmSync(directory, { recursive: true, force: true });
  }));
});

function fixture(trustedProxy?: string | readonly string[]): Fixture {
  const directory = mkdtempSync(join(tmpdir(), "ackerdb-realtime-peer-owner-"));
  const engine = new Engine(schema, join(directory, "data.db"));
  reconcile(engine);
  const realtimeRuntime: RealtimeRuntimeModule = {
    create: (host) => new RealtimeHub({
      ...REALTIME_HUB_DEFAULTS,
      definition: host.definition,
      application: host.application,
      engine: testRealtimeEngine(
        () => new TestPeerConnection() as unknown as RTCPeerConnection,
      ),
      configuration: createTurnConfiguration({
        urls: "turn:relay.example.test:3478?transport=udp",
        secret: "deployment-only-secret-32-bytes!!",
      }, () => 1_700_000_000_000),
      now: () => 1_700_000_000_000,
    }),
  };
  const runtime = new Runtime({
    engine,
    registry: new Registry({ assistant: { live: assistant } }),
    limits: PRODUCTION_LIMITS,
    telemetry: false,
    realtime: realtimeRuntime,
  });
  const server = serve({
    runtime,
    port: 0,
    ...(trustedProxy === undefined ? {} : { trustedProxy }),
  });
  const value: Fixture = {
    base: `http://127.0.0.1:${server.port}`,
    directory,
    engine,
    runtime,
    server,
  };
  fixtures.push(value);
  return value;
}

async function prepare(
  value: Fixture,
  forwarded: string,
): Promise<{ readonly owner: string; readonly ticket: string }> {
  const response = await fetch(`${value.base}/_realtime/prepare`, {
    method: "POST",
    headers: { "x-forwarded-for": forwarded },
    body: encode({
      v: ACKERDB_VERSION,
      t: "realtime_prepare",
      ref: "api.assistant.live",
      args: {},
    }),
  });
  expect(response.status).toBe(200);
  const message = parseRealtimePrepareResponse(decode(await response.text()));
  if (message.t !== "realtime_prepared") {
    throw new Error("expected a prepared realtime session");
  }
  const username = message.configuration.iceServers?.[0]?.username;
  if (typeof username !== "string") throw new Error("expected a TURN username");
  const separator = username.indexOf(":");
  if (separator === -1) throw new Error("expected a coturn REST username");
  return Object.freeze({ owner: username.slice(separator + 1), ticket: message.ticket });
}

async function offer(value: Fixture, forwarded: string): Promise<string> {
  const prepared = await prepare(value, forwarded);
  const response = await fetch(`${value.base}/_realtime`, {
    method: "POST",
    headers: { "x-forwarded-for": forwarded },
    body: encode({
      v: ACKERDB_VERSION,
      t: "realtime_offer",
      ticket: prepared.ticket,
      offer: { type: "offer", sdp: "v=0\r\noffer" },
    }),
  });
  expect(response.status).toBe(200);
  const answer = parseRealtimeOfferResponse(decode(await response.text()));
  if (answer.t !== "realtime_answer") throw new Error("expected a realtime answer");
  return answer.sessionId;
}

function sessionRequest(
  value: Fixture,
  sessionId: string,
  method: "PATCH" | "DELETE",
  forwarded: string,
): Promise<Response> {
  return fetch(`${value.base}/_realtime/${sessionId}`, {
    method,
    headers: { "x-forwarded-for": forwarded },
    ...(method === "PATCH"
      ? {
          body: encode({
            v: ACKERDB_VERSION,
            t: "realtime_candidates",
            candidates: [],
            complete: true,
          }),
        }
      : {}),
  });
}

describe("realtime peer ownership at HTTP ingress", () => {
  test("ignores spoofed forwarded addresses when no proxy is trusted", async () => {
    const value = fixture();
    const first = "198.51.100.10";
    const spoofed = "203.0.113.20";

    expect((await prepare(value, spoofed)).owner).toBe((await prepare(value, first)).owner);
    const sessionId = await offer(value, first);
    expect((await sessionRequest(value, sessionId, "DELETE", spoofed)).status).toBe(204);
  });

  test("uses a configured trusted proxy address as the forwarded-client boundary", async () => {
    const value = fixture("127.0.0.1");
    const first = "198.51.100.10";
    const other = "203.0.113.20";
    const owner = (await prepare(value, first)).owner;

    expect(owner).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect((await prepare(value, other)).owner).not.toBe(owner);
    const sessionId = await offer(value, first);
    expect((await sessionRequest(value, sessionId, "PATCH", other)).status).toBe(404);
    expect((await sessionRequest(value, sessionId, "PATCH", first)).status).toBe(200);
    await expect(value.runtime.realtimeDiagnostic(sessionId, owner)).resolves.toMatchObject({
      connectionState: "new",
    });
    await expect(value.runtime.realtimeDiagnostic(
      sessionId,
      (await prepare(value, other)).owner,
    )).rejects.toMatchObject({ code: "not_found" });
    expect((await sessionRequest(value, sessionId, "DELETE", first)).status).toBe(204);
  });

  test("falls back to the socket source when a trusted proxy forwards an invalid client address", async () => {
    const value = fixture("127.0.0.1");

    expect((await prepare(value, "not-an-ip-address")).owner)
      .toBe((await prepare(value, "also-not-an-ip-address")).owner);
  });

  test("follows every configured CIDR hop before selecting the forwarded client", async () => {
    const value = fixture(["127.0.0.0/8", "10.0.0.0/8"]);
    const first = "198.51.100.10, 10.1.2.3";
    const other = "203.0.113.20, 10.1.2.3";

    expect((await prepare(value, other)).owner).not.toBe((await prepare(value, first)).owner);
    const sessionId = await offer(value, first);
    expect((await sessionRequest(value, sessionId, "DELETE", other)).status).toBe(404);
    expect((await sessionRequest(value, sessionId, "DELETE", first)).status).toBe(204);
  });
});

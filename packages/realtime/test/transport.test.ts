import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  Engine,
  PRODUCTION_LIMITS,
  Registry,
  Runtime,
  defineSchema,
  defineTable,
  procedure,
  realtime,
  reconcile,
  serve,
  v,
  type AckerDBServer,
  type ProcedureBuilder,
  type RealtimeBuilder,
  type TelemetryMetricRecord,
  type TelemetryRecord,
} from "@ackerdb/server";
import {
  PROTOCOL_VERSION,
  RealtimeDataPlane,
  decode,
  encode,
  parseRealtimeConfigurationMessage,
  parseRealtimeOfferResponse,
  parseRealtimePatchResponse,
} from "@ackerdb/core";
import {
  TestDataChannel as FakeDataChannel,
  TestPeerConnection as FakePeerConnection,
  testRealtimeEngine,
  testRealtimeRuntime,
} from "./support.ts";

const schema = defineSchema({
  calls: defineTable({
    id: v.primaryKey(),
    value: v.string(),
  }),
});
const typedProcedure = procedure as ProcedureBuilder<typeof schema>;
const typedRealtime = realtime as RealtimeBuilder<typeof schema>;
const externalEcho = typedProcedure({
  args: { value: v.string() },
  access: "public",
  handler: async (ctx, { value }) => {
    const response = await fetch(
      `data:text/plain,${encodeURIComponent(value)}`,
      { signal: ctx.abortSignal },
    );
    return response.text();
  },
});
let directory: string;
let engine: Engine;
let runtime: Runtime;
let server: AckerDBServer;
let peer: FakePeerConnection;
let clientChannel: FakeDataChannel;
let handlerRuns: number;
let base: string;
let telemetryRecords: TelemetryRecord[];
let authorizationGate: Promise<never> | null;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "ackerdb-realtime-transport-"));
  engine = new Engine(schema, join(directory, "data.db"));
  reconcile(engine);
  peer = new FakePeerConnection();
  clientChannel = new FakeDataChannel();
  peer.channel.peer = clientChannel;
  clientChannel.peer = peer.channel;
  handlerRuns = 0;
  telemetryRecords = [];
  authorizationGate = null;
  const assistant = typedRealtime({
    args: {},
    clientEvents: {
      invoke: v.object({ value: v.string() }),
    },
    serverEvents: {
      completed: v.object({ id: v.bigint(), value: v.string() }),
    },
    access: "public",
    authorize: async () => {
      if (authorizationGate !== null) await authorizationGate;
    },
    handler: (ctx) => {
      handlerRuns++;
      ctx.on("invoke", async ({ value }) => {
        const response = await externalEcho(ctx, { value });
        const inserted = await ctx.tx((tx) =>
          tx.db.calls.insert({ value: response.data })
        );
        if (!ctx.send("completed", {
          id: inserted.data,
          value: response.data,
        })) {
          throw new Error("realtime response was backpressured");
        }
      });
    },
  });
  runtime = new Runtime({
    engine,
    registry: new Registry({
      assistant: { live: assistant },
      procedures: { externalEcho },
    }),
    limits: PRODUCTION_LIMITS,
    telemetry: {
      localSink: false,
      exporter: {
        export: (records) => void telemetryRecords.push(...records),
      },
      limits: {
        batchIntervalMs: 5,
        sampleIntervalMs: 10,
        slowOperationMs: 0,
      },
    },
    realtime: testRealtimeRuntime(
      testRealtimeEngine(
        () => peer as unknown as RTCPeerConnection,
      ),
      {
        configuration: () => ({
          iceServers: [{ urls: "turn:relay.example.test" }],
        }),
        authorizationTimeoutMs: 10,
      },
    ),
  });
  server = serve({ runtime, port: 0 });
  base = `http://127.0.0.1:${server.port}`;
});

afterEach(async () => {
  await server.drain().catch(() => {});
  await runtime.drain().catch(() => {});
  engine.close("clean");
  rmSync(directory, { recursive: true, force: true });
});

describe("realtime HTTP signaling", () => {
  test("cancels timed-out authorization and releases runtime admission", async () => {
    authorizationGate = new Promise(() => {});
    const response = await fetch(`${base}/api/realtime`, {
      method: "POST",
      body: encode({
        v: PROTOCOL_VERSION,
        t: "realtime_offer",
        ref: "assistant.live",
        args: {},
        offer: { type: "offer", sdp: "v=0\r\noffer" },
      }),
    });

    expect(response.status).toBe(503);
    expect(decode(await response.text())).toMatchObject({
      outcome: {
        code: "unavailable",
        message: "realtime authorization timed out",
      },
    });
    expect(runtime.status()).toMatchObject({
      activeOperations: 0,
      activeOperationCallers: 0,
      realtime: {
        activeSessions: 0,
        reservedSessions: 0,
      },
    });
  });

  test("exports bounded setup, recovery, path, media, and cleanup telemetry", async () => {
    const offered = await fetch(`${base}/api/realtime`, {
      method: "POST",
      body: encode({
        v: PROTOCOL_VERSION,
        t: "realtime_offer",
        ref: "assistant.live",
        args: {},
        offer: { type: "offer", sdp: "v=0\r\noffer" },
        recovery: true,
      }),
    });
    const answer = parseRealtimeOfferResponse(decode(await offered.text()));
    if (answer.t !== "realtime_answer") throw new Error("expected answer");

    peer.iceConnectionState = "connected";
    peer.connectionState = "connected";
    peer.dispatchEvent(new Event("iceconnectionstatechange"));
    peer.dispatchEvent(new Event("connectionstatechange"));
    await runtime.realtime!.sampleHealth(1);

    expect(runtime.status().realtime).toMatchObject({
      activeSessions: 1,
      recoveryAttempts: 1,
      recoveryAccepted: 1,
      health: {
        directPaths: 1,
        relayPaths: 0,
        udpPaths: 1,
        roundTripTimeAverageMs: 20,
        jitterMaxMs: 4,
        packets: 5,
        packetsLost: 1,
        frames: 1,
        framesDropped: 2,
      },
    });

    await expectMetric((metric) =>
      metric.name === "runtime.realtime_direct_paths" && metric.value === 1
    );
    await expectMetric((metric) =>
      metric.name === "runtime.realtime_frames_dropped" && metric.value === 2
    );
    await expectMetric((metric) =>
      metric.name === "runtime.realtime_recovery_accepted" &&
      metric.value === 1
    );

    const closed = await fetch(`${base}/api/realtime/${answer.sessionId}`, {
      method: "DELETE",
    });
    expect(closed.status).toBe(204);
    expect(runtime.status().realtime?.health).toMatchObject({
      sampledPeers: 0,
      directPaths: 0,
      relayPaths: 0,
      udpPaths: 0,
      tcpPaths: 0,
      roundTripTimeAverageMs: 0,
      packets: 0,
      frames: 0,
      dataChannelBufferedAmountMax: 0,
    });
    await expectMetric((metric) =>
      metric.name === "runtime.realtime_closed_client" && metric.value === 1
    );
    await expectMetric((metric) =>
      metric.name === "runtime.realtime_sessions" && metric.value === 0
    );
  });

  test("configures, creates, trickles, and closes one authenticated generation", async () => {
    const configured = await fetch(`${base}/api/realtime/config`);
    expect(configured.status).toBe(200);
    expect(parseRealtimeConfigurationMessage(
      decode(await configured.text()),
    )).toEqual({
      v: PROTOCOL_VERSION,
      t: "realtime_config",
      configuration: {
        iceServers: [{ urls: "turn:relay.example.test" }],
      },
    });

    const offered = await fetch(`${base}/api/realtime`, {
      method: "POST",
      body: encode({
        v: PROTOCOL_VERSION,
        t: "realtime_offer",
        ref: "assistant.live",
        args: {},
        offer: { type: "offer", sdp: "v=0\r\noffer" },
      }),
    });
    expect(offered.status).toBe(200);
    const answer = parseRealtimeOfferResponse(decode(await offered.text()));
    expect(answer.t).toBe("realtime_answer");
    if (answer.t !== "realtime_answer") throw new Error("expected answer");
    expect(answer.streamLimits).toEqual({ client: {}, server: {} });
    expect(handlerRuns).toBe(1);
    expect(runtime.status().realtime?.activeSessions).toBe(1);

    const patched = await fetch(`${base}/api/realtime/${answer.sessionId}`, {
      method: "PATCH",
      body: encode({
        v: PROTOCOL_VERSION,
        t: "realtime_candidates",
        candidates: [],
        complete: true,
      }),
    });
    expect(patched.status).toBe(200);
    expect(parseRealtimePatchResponse(decode(await patched.text()))).toMatchObject({
      t: "realtime_candidates",
    });

    const closed = await fetch(`${base}/api/realtime/${answer.sessionId}`, {
      method: "DELETE",
    });
    expect(closed.status).toBe(204);
    expect(peer.closed).toBe(true);
    expect(runtime.status().realtime?.activeSessions).toBe(0);
  });

  test("reserves malformed session paths without exposing an application route", async () => {
    const response = await fetch(`${base}/api/realtime/not-a-session`, {
      method: "PATCH",
      body: encode({
        v: PROTOCOL_VERSION,
        t: "realtime_candidates",
        candidates: [],
        complete: true,
      }),
    });
    expect(response.status).toBe(404);
  });

  test("calls HTTP, a registered procedure, and a committed transaction from a realtime event", async () => {
    const offered = await fetch(`${base}/api/realtime`, {
      method: "POST",
      body: encode({
        v: PROTOCOL_VERSION,
        t: "realtime_offer",
        ref: "assistant.live",
        args: {},
        offer: { type: "offer", sdp: "v=0\r\noffer" },
      }),
    });
    const answer = parseRealtimeOfferResponse(decode(await offered.text()));
    if (answer.t !== "realtime_answer") throw new Error("expected answer");

    let resolveCompleted!: (value: unknown) => void;
    let rejectCompleted!: (reason: unknown) => void;
    const completed = new Promise<unknown>((resolve, reject) => {
      resolveCompleted = resolve;
      rejectCompleted = reject;
    });
    const client = new RealtimeDataPlane({
      channel: clientChannel as unknown as RTCDataChannel,
      localPrefix: "c",
      maxBufferedAmount: 64 * 1024,
      maxConcurrentStreams: 4,
      maxIncomingBufferedBytes: 64 * 1024,
      streamIdleMs: 30_000,
      onEvent: (event, payload) => resolveCompleted({ event, payload }),
      onIncomingStream: () => undefined,
      onSessionError: rejectCompleted,
      onSignal: () => {},
      onFatalError: rejectCompleted,
    });

    expect(client.send("invoke", { value: "from realtime" })).toBe(true);
    expect(await completed).toEqual({
      event: "completed",
      payload: { id: 1n, value: "from realtime" },
    });
    expect(
      engine.reader.query('SELECT "value" FROM "calls"').all(),
    ).toEqual([{ value: "from realtime" }]);

    client.close();
    const closed = await fetch(`${base}/api/realtime/${answer.sessionId}`, {
      method: "DELETE",
    });
    expect(closed.status).toBe(204);
  });
});

async function expectMetric(
  predicate: (metric: TelemetryMetricRecord) => boolean,
): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt++) {
    await runtime.telemetry.flush();
    if (
      telemetryRecords.some(
        (record): record is TelemetryMetricRecord =>
          record.kind === "metric" && predicate(record),
      )
    ) {
      return;
    }
    await Bun.sleep(10);
  }
  throw new Error("Runtime did not export the expected realtime metric");
}

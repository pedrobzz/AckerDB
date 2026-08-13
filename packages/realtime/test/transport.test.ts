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
} from "@ackerdb/server";
import {
  ACKERDB_VERSION,
  RealtimeDataPlane,
  decode,
  encode,
  parseRealtimeOfferResponse,
  parseRealtimePatchResponse,
  parseRealtimePrepareResponse,
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

async function prepare(recovery = false) {
  const response = await fetch(`${base}/_realtime/prepare`, {
    method: "POST",
    body: encode({
      v: ACKERDB_VERSION,
      t: "realtime_prepare",
      ref: "api.assistant.live",
      args: {},
      ...(recovery ? { recovery: true as const } : {}),
    }),
  });
  const prepared = parseRealtimePrepareResponse(decode(await response.text()));
  if (!response.ok || prepared.t !== "realtime_prepared") {
    throw new Error("expected a prepared realtime session");
  }
  return prepared;
}

async function offer(ticket: string) {
  const response = await fetch(`${base}/_realtime`, {
    method: "POST",
    body: encode({
      v: ACKERDB_VERSION,
      t: "realtime_offer",
      ticket,
      offer: { type: "offer", sdp: "v=0\r\noffer" },
    }),
  });
  const answer = parseRealtimeOfferResponse(decode(await response.text()));
  if (!response.ok || answer.t !== "realtime_answer") {
    throw new Error("expected a realtime answer");
  }
  return answer;
}

async function establish(recovery = false) {
  const prepared = await prepare(recovery);
  return offer(prepared.ticket);
}

describe("realtime HTTP signaling", () => {
  test("cancels timed-out authorization and releases runtime admission", async () => {
    authorizationGate = new Promise(() => {});
    const response = await fetch(`${base}/_realtime/prepare`, {
      method: "POST",
      body: encode({
        v: ACKERDB_VERSION,
        t: "realtime_prepare",
        ref: "api.assistant.live",
        args: {},
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


  test("prepares, creates, trickles, and closes one authenticated generation", async () => {
    const legacy = await fetch(`${base}/_realtime/config`);
    expect(legacy.status).toBe(404);

    const preparedResponse = await fetch(`${base}/_realtime/prepare`, {
      method: "POST",
      body: encode({
        v: ACKERDB_VERSION,
        t: "realtime_prepare",
        ref: "api.assistant.live",
        args: {},
      }),
    });
    expect(preparedResponse.status).toBe(200);
    expect(preparedResponse.headers.get("cache-control")).toBe("no-store");
    const prepared = parseRealtimePrepareResponse(
      decode(await preparedResponse.text()),
    );
    expect(prepared).toMatchObject({
      v: ACKERDB_VERSION,
      t: "realtime_prepared",
      configuration: {
        iceServers: [{ urls: "turn:relay.example.test" }],
      },
    });
    if (prepared.t !== "realtime_prepared") {
      throw new Error("expected a prepared realtime session");
    }
    expect(handlerRuns).toBe(0);
    expect(runtime.status().realtime).toMatchObject({
      activeSessions: 0,
      reservedSessions: 1,
    });

    const answer = await offer(prepared.ticket);
    expect(answer.streamLimits).toEqual({ client: {}, server: {} });
    expect(handlerRuns).toBe(1);
    expect(runtime.status().realtime?.activeSessions).toBe(1);

    const patched = await fetch(`${base}/_realtime/${answer.sessionId}`, {
      method: "PATCH",
      body: encode({
        v: ACKERDB_VERSION,
        t: "realtime_candidates",
        candidates: [],
        complete: true,
      }),
    });
    expect(patched.status).toBe(200);
    expect(parseRealtimePatchResponse(decode(await patched.text()))).toMatchObject({
      t: "realtime_candidates",
    });

    const closed = await fetch(`${base}/_realtime/${answer.sessionId}`, {
      method: "DELETE",
    });
    expect(closed.status).toBe(204);
    expect(peer.closed).toBe(true);
    expect(runtime.status().realtime?.activeSessions).toBe(0);
  });

  test("returns a typed terminal outcome before a forbidden HTTP trickle reaches native", async () => {
    const answer = await establish();

    const patched = await fetch(`${base}/_realtime/${answer.sessionId}`, {
      method: "PATCH",
      body: encode({
        v: ACKERDB_VERSION,
        t: "realtime_candidates",
        candidates: [{
          candidate: "candidate:1 1 UDP 1 127.0.0.1 9 typ srflx",
          sdpMid: "0",
          sdpMLineIndex: 0,
        }],
        complete: false,
      }),
    });

    expect(patched.status).toBe(400);
    expect(parseRealtimePatchResponse(decode(await patched.text()))).toMatchObject({
      t: "realtime_ended",
      outcome: { code: "malformed", retryable: false },
    });
    expect(peer.candidates).toEqual([]);
    expect(peer.closed).toBe(true);
    expect(runtime.status().realtime?.activeSessions).toBe(0);
  });

  test("reserves malformed session paths without exposing an application route", async () => {
    const response = await fetch(`${base}/_realtime/not-a-session`, {
      method: "PATCH",
      body: encode({
        v: ACKERDB_VERSION,
        t: "realtime_candidates",
        candidates: [],
        complete: true,
      }),
    });
    expect(response.status).toBe(404);
  });

  test("calls HTTP, a registered procedure, and a committed transaction from a realtime event", async () => {
    const answer = await establish();

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
    const closed = await fetch(`${base}/_realtime/${answer.sessionId}`, {
      method: "DELETE",
    });
    expect(closed.status).toBe(204);
  });
});

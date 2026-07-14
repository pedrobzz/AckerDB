import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  PROTOCOL_VERSION,
  decode,
  encode,
  parseCallResponse,
  type ServerMessage,
} from "@dbzz/core";
import {
  ANONYMOUS_PRINCIPAL,
  DbzzError,
  Engine,
  OutboundBudget,
  PRODUCTION_LIMITS,
  Registry,
  Runtime,
  Session,
  WebSocketSessionSink,
  dbz,
  defineSchema,
  defineTable,
  mutation,
  procedure,
  query,
  reconcile,
  serve,
  type RuntimeProcedureRequest,
  type RuntimeProcedureResponse,
  type RuntimePublication,
  type SessionRuntimeContext,
  type TelemetryRecord,
  type TelemetrySpanRecord,
  type WebSocketDeliverySocket,
} from "@dbzz/server";

const encoder = new TextEncoder();
const TEST_SOURCE = Object.freeze({ family: "test", address: "telemetry-delivery" });

const schema = defineSchema({
  notes: defineTable({
    id: dbz.primaryKey(),
    body: dbz.string(),
  }),
});

// This test owns the transport boundary, not generated application types.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Ctx = any;

const functions = {
  notes: {
    list: query({
      access: "public",
      args: {},
      handler: (ctx: Ctx) => ctx.db.notes.scan().collect(),
    }),
    large: query({
      access: "public",
      args: { size: dbz.number() },
      handler: (_ctx: Ctx, args: Ctx) => "x".repeat(args.size),
    }),
    add: mutation({
      access: "public",
      args: { body: dbz.string() },
      handler: (ctx: Ctx, args: Ctx) => ctx.db.notes.insert(args),
    }),
  },
  ops: {
    echo: procedure({
      access: "public",
      args: { body: dbz.string() },
      handler: (_ctx: Ctx, args: Ctx) => args.body,
    }),
    fail: procedure({
      access: "public",
      args: {},
      handler: () => {
        throw new DbzzError("conflict", "already exists");
      },
    }),
    failLarge: procedure({
      access: "public",
      args: {},
      handler: () => {
        throw new DbzzError("overloaded", "safe detail ".repeat(100), {
          retryable: true,
          retryAfterMs: 125,
          resource: "operation",
        });
      },
    }),
  },
};

function uuidV7(now: number, sequence: number): string {
  const timestamp = now.toString(16).padStart(12, "0");
  return `${timestamp.slice(0, 8)}-${timestamp.slice(8)}-7000-8000-${sequence.toString(16).padStart(12, "0")}`;
}

async function settle(): Promise<void> {
  for (let turn = 0; turn < 12; turn++) await Promise.resolve();
}

class BufferedSocket implements WebSocketDeliverySocket {
  readonly frames: string[] = [];
  readonly activeOperationsAtApplicationSend = new Map<number, number>();
  bufferedAmount = 0;
  private bufferNextFrame = false;

  constructor(private readonly runtime: Runtime) {}

  bufferNext(): void {
    this.bufferNextFrame = true;
  }

  send(text: string): number {
    this.frames.push(text);
    const frame = decode(text) as ServerMessage;
    if ((frame.t === "ok" || frame.t === "err") && frame.id !== null) {
      this.activeOperationsAtApplicationSend.set(frame.id, this.runtime.status().activeOperations);
    }
    const bytes = encoder.encode(text).byteLength;
    if (!this.bufferNextFrame) return bytes;
    this.bufferNextFrame = false;
    this.bufferedAmount = bytes;
    return -1;
  }

  getBufferedAmount(): number {
    return this.bufferedAmount;
  }

  close(): void {}
}

interface CapturedProcedureHandoff extends RuntimeProcedureResponse {
  readonly activeOperations: number;
}

class ProcedureObservingRuntime extends Runtime {
  readonly procedureHandoffs = new Map<number, CapturedProcedureHandoff>();
  failedResponderId: number | null = null;

  override runProcedure(request: RuntimeProcedureRequest): Promise<Response> {
    return super.runProcedure({
      ...request,
      respond: (response) => {
        this.procedureHandoffs.set(request.id, {
          ...response,
          activeOperations: this.status().activeOperations,
        });
        if (request.id === this.failedResponderId) {
          throw new Error("private responder failure");
        }
        return request.respond(response);
      },
    });
  }
}

function spans(records: readonly TelemetryRecord[]): TelemetrySpanRecord[] {
  return records.filter((record): record is TelemetrySpanRecord => record.kind === "span");
}

function admission(
  records: readonly TelemetrySpanRecord[],
  operation: "query" | "mutation" | "procedure",
  requestId: string,
): TelemetrySpanRecord {
  const record = records.find((candidate) =>
    candidate.operation === operation &&
    candidate.stage === "admission" &&
    candidate.requestId === requestId
  );
  expect(record).toBeDefined();
  return record!;
}

function delivery(
  records: readonly TelemetrySpanRecord[],
  operation: TelemetrySpanRecord["operation"],
  traceId: string,
): TelemetrySpanRecord[] {
  return records.filter((record) =>
    record.operation === operation &&
    record.resource === "outbound" &&
    record.traceId === traceId &&
    (record.stage === "encoding" || record.stage === "queue" || record.stage === "delivery")
  );
}

test("Runtime prepares one canonical query frame for WebSocket delivery", async () => {
  const directory = mkdtempSync(join(tmpdir(), "dbzz-query-publication-"));
  const engine = new Engine(schema, join(directory, "data.db"));
  reconcile(engine);
  const payload = {
    bigint: 7n,
    bytes: new Uint8Array([0, 255]),
    literal: { $: "literal" },
  };
  let reads = 0;
  const value = Object.defineProperty({}, "payload", {
    enumerable: true,
    get() {
      reads++;
      return payload;
    },
  });
  const runtime = new Runtime({
    engine,
    registry: new Registry({
      probe: {
        once: query({
          access: "public",
          args: {},
          handler: () => value,
        }),
      },
    }),
  });
  const socket = new BufferedSocket(runtime);
  const sink = new WebSocketSessionSink({
    socket,
    budget: new OutboundBudget(
      runtime.limits.webSocket.maxBytes,
      runtime.limits.maxFrameBytes,
    ),
    limits: runtime.limits,
  });
  const controller = new AbortController();
  const context: SessionRuntimeContext = Object.freeze({
    clientSessionId: "query-publication",
    principal: ANONYMOUS_PRINCIPAL,
    fairnessKey: "query-publication",
    authEpoch: 0,
    signal: controller.signal,
    publish: async (publication: RuntimePublication) => {
      await sink.sendApplication(0, publication);
      return true;
    },
  });

  try {
    await runtime.openSession(context);
    const result = await runtime.query(context, {
      v: PROTOCOL_VERSION,
      t: "q",
      id: 1,
      ref: "probe.once",
      args: {},
    });

    expect(result).toBe(value);
    expect(reads).toBe(1);
    expect(socket.frames).toEqual([encode({
      v: PROTOCOL_VERSION,
      t: "ok",
      id: 1,
      kind: "query",
      value: { payload },
    })]);
  } finally {
    controller.abort();
    await runtime.drain(Date.now() + 2_000).catch(() => {});
    engine.close("clean");
    rmSync(directory, { recursive: true, force: true });
  }
});

test("Runtime owns correlated WebSocket outcomes through delayed physical delivery", async () => {
  const directory = mkdtempSync(join(tmpdir(), "dbzz-telemetry-delivery-"));
  const engine = new Engine(schema, join(directory, "data.db"));
  reconcile(engine);
  const exported: TelemetryRecord[] = [];
  const runtime = new Runtime({
    engine,
    registry: new Registry(functions),
    telemetry: {
      enabled: true,
      exporter: {
        export(batch) {
          exported.push(...batch);
        },
      },
      localSink: false,
      limits: {
        maxRecords: 512,
        maxBytes: 1_024 * 1_024,
        maxMetricSeries: 128,
        maxBatchRecords: 512,
        batchIntervalMs: 60_000,
        exportTimeoutMs: 100,
        retentionMs: 60_000,
        slowOperationMs: 0,
        sampleIntervalMs: 60_000,
      },
    },
  });
  const socket = new BufferedSocket(runtime);
  const budget = new OutboundBudget(
    runtime.limits.webSocket.maxBytes,
    runtime.limits.maxFrameBytes,
  );
  let session!: Session;
  const sink = new WebSocketSessionSink({
    socket,
    budget,
    limits: runtime.limits,
    captureObserver: (lane) => runtime.captureDeliveryObserver(
      lane,
      session.snapshot().clientSessionId ?? undefined,
    ),
  });
  session = new Session({ runtime, sink, source: TEST_SOURCE });

  try {
    await session.handle({
      v: PROTOCOL_VERSION,
      t: "hello",
      clientSessionId: "telemetry-delivery-session",
      credential: { kind: "anonymous" },
    });

    socket.bufferNext();
    await session.handle({
      v: PROTOCOL_VERSION,
      t: "q",
      id: 41,
      ref: "notes.list",
      args: {},
    });
    await settle();
    socket.bufferedAmount = 0;
    sink.onDrain();

    const issuedAt = Date.now();
    const mutationId = uuidV7(issuedAt, 42);
    socket.bufferNext();
    await session.handle({
      v: PROTOCOL_VERSION,
      t: "m",
      id: 42,
      ref: "notes.add",
      args: { body: "safe" },
      mutationRequestId: mutationId,
      issuedAt,
    });
    await settle();
    socket.bufferedAmount = 0;
    sink.onDrain();

    socket.bufferNext();
    await session.handle({
      v: PROTOCOL_VERSION,
      t: "q",
      id: 43,
      ref: "notes.missing",
      args: {},
    });
    await settle();
    socket.bufferedAmount = 0;
    sink.onDrain();

    await session.handle({
      v: PROTOCOL_VERSION,
      t: "q",
      id: 44,
      ref: "notes.large",
      args: { size: runtime.limits.maxFrameBytes + 1 },
    });
    await settle();

    await session.handle({ v: PROTOCOL_VERSION, t: "ping" });
    await settle();
    await runtime.telemetry.flush();

    expect([...socket.activeOperationsAtApplicationSend.entries()]).toEqual([
      [41, 0],
      [42, 0],
      [43, 0],
      [44, 0],
    ]);
    const errorFrames = socket.frames
      .map((text) => decode(text) as ServerMessage)
      .filter((frame) => frame.t === "err" && frame.id === 43);
    expect(errorFrames).toHaveLength(1);
    expect(errorFrames[0]).toMatchObject({ outcome: { code: "not_found" } });
    const oversizedFrames = socket.frames
      .map((text) => decode(text) as ServerMessage)
      .filter((frame) => frame.t === "err" && frame.id === 44);
    expect(oversizedFrames).toHaveLength(1);
    expect(oversizedFrames[0]).toMatchObject({ outcome: { code: "overloaded" } });

    const retained = spans(exported);
    const queryAdmission = admission(retained, "query", "41");
    const mutationAdmission = admission(retained, "mutation", "42");
    const failureAdmission = admission(retained, "query", "43");
    const oversizedAdmission = admission(retained, "query", "44");
    const queryDelivery = delivery(retained, "query", queryAdmission.traceId!);
    const mutationDelivery = delivery(retained, "mutation", mutationAdmission.traceId!);
    const failureDelivery = delivery(retained, "query", failureAdmission.traceId!);
    const oversizedDelivery = delivery(retained, "query", oversizedAdmission.traceId!);

    for (const [records, owner] of [
      [queryDelivery, queryAdmission],
      [mutationDelivery, mutationAdmission],
      [failureDelivery, failureAdmission],
    ] as const) {
      expect(records.map((record) => record.stage).sort()).toEqual([
        "delivery",
        "encoding",
        "queue",
      ]);
      expect(records.every((record) => record.requestId === owner.requestId)).toBe(true);
      expect(records.every((record) => record.connectionId === owner.connectionId)).toBe(true);
    }
    expect(mutationDelivery.every((record) => record.mutationId === mutationId)).toBe(true);
    const oversizedEncoding = oversizedDelivery.filter((record) =>
      record.stage === "encoding" && record.outcome === "overloaded"
    );
    expect(oversizedEncoding).toHaveLength(1);
    expect(oversizedEncoding[0]!.sizeBytes).toBeGreaterThan(runtime.limits.maxFrameBytes);
    const boundedDelivery = oversizedDelivery.filter((record) => record.outcome === "ok");
    expect(boundedDelivery.map((record) => record.stage).sort()).toEqual([
      "delivery",
      "encoding",
      "queue",
    ]);
    expect(new Set(boundedDelivery.map((record) => record.sizeBytes)).size).toBe(1);
    expect(boundedDelivery[0]!.sizeBytes).toBeLessThanOrEqual(runtime.limits.maxFrameBytes);

    const controlDelivery = retained.filter((record) =>
      record.operation === "lifecycle" &&
      record.resource === "outbound" &&
      record.connectionId === queryAdmission.connectionId
    );
    const pongTrace = controlDelivery.at(-1)?.traceId;
    expect(pongTrace).toBeDefined();
    expect(pongTrace).not.toBe(queryAdmission.traceId);
    expect(pongTrace).not.toBe(mutationAdmission.traceId);
    expect(controlDelivery.filter((record) => record.traceId === pongTrace)
      .map((record) => record.stage).sort()).toEqual(["delivery", "encoding", "queue"]);
  } finally {
    await session.close();
    await runtime.drain(Date.now() + 2_000).catch(() => {});
    engine.close("clean");
    rmSync(directory, { recursive: true, force: true });
  }
});

test("DbzzServer correlates bounded procedure encoding and Response handoff after operation release", async () => {
  const directory = mkdtempSync(join(tmpdir(), "dbzz-telemetry-procedure-delivery-"));
  const engine = new Engine(schema, join(directory, "data.db"));
  reconcile(engine);
  const exported: TelemetryRecord[] = [];
  const runtime = new ProcedureObservingRuntime({
    engine,
    registry: new Registry(functions),
    limits: { ...PRODUCTION_LIMITS, maxFrameBytes: 256 },
    telemetry: {
      enabled: true,
      exporter: {
        export(batch) {
          exported.push(...batch);
        },
      },
      localSink: false,
      limits: {
        maxRecords: 256,
        maxBytes: 512 * 1_024,
        maxMetricSeries: 64,
        maxBatchRecords: 256,
        batchIntervalMs: 60_000,
        exportTimeoutMs: 100,
        retentionMs: 60_000,
        slowOperationMs: 0,
        sampleIntervalMs: 60_000,
      },
    },
  });
  runtime.failedResponderId = 54;
  const server = serve({ runtime, port: 0 });
  const base = `http://127.0.0.1:${server.port}`;
  const call = async (id: number, ref: string, args: unknown) => {
    const response = await fetch(`${base}/api/call`, {
      method: "POST",
      body: encode({ v: PROTOCOL_VERSION, t: "call", id, ref, args }),
    });
    const body = await response.text();
    return { body, frame: parseCallResponse(decode(body)), status: response.status };
  };

  try {
    const success = await call(51, "ops.echo", { body: "hello" });
    const failure = await call(52, "ops.fail", {});
    const boundedFailure = await call(53, "ops.failLarge", {});
    const responderFailure = await call(54, "ops.echo", { body: "handoff" });

    expect(success).toMatchObject({
      status: 200,
      frame: {
        v: PROTOCOL_VERSION,
        t: "ok",
        id: 51,
        kind: "procedure",
        value: "hello",
      },
    });
    expect(failure).toMatchObject({
      status: 409,
      frame: {
        v: PROTOCOL_VERSION,
        t: "err",
        id: 52,
        outcome: { code: "conflict", retryable: false, message: "already exists" },
      },
    });
    expect(boundedFailure.status).toBe(429);
    expect(boundedFailure.frame).toMatchObject({
      v: PROTOCOL_VERSION,
      t: "err",
      id: 53,
      outcome: {
        code: "overloaded",
        retryable: true,
        retryAfterMs: 125,
        resource: "operation",
      },
    });
    expect(boundedFailure.frame.t).toBe("err");
    if (boundedFailure.frame.t !== "err") throw new Error("expected bounded error response");
    expect(boundedFailure.frame.outcome.message).toEndWith("…");
    expect(encoder.encode(boundedFailure.body).byteLength).toBeLessThanOrEqual(
      runtime.limits.maxFrameBytes,
    );
    expect(responderFailure).toMatchObject({
      status: 500,
      frame: {
        v: PROTOCOL_VERSION,
        t: "err",
        id: 54,
        outcome: { code: "internal", retryable: false, message: "HTTP response handoff failed" },
      },
    });
    expect(responderFailure.body).not.toContain("private responder failure");

    for (const [id, publicResponse] of [
      [51, success],
      [52, failure],
      [53, boundedFailure],
    ] as const) {
      const handoff = runtime.procedureHandoffs.get(id);
      expect(handoff).toBeDefined();
      expect(handoff!.activeOperations).toBe(0);
      expect(handoff!.body).toBe(publicResponse.body);
      expect(handoff!.bytes).toBe(encoder.encode(publicResponse.body).byteLength);
      expect(handoff!.bytes).toBeLessThanOrEqual(runtime.limits.maxFrameBytes);
      expect(handoff!.status).toBe(publicResponse.status);
    }
    const failedHandoff = runtime.procedureHandoffs.get(54);
    expect(failedHandoff).toMatchObject({ activeOperations: 0, status: 200 });
    expect(failedHandoff!.bytes).toBe(encoder.encode(failedHandoff!.body).byteLength);
    expect(runtime.status().activeOperations).toBe(0);

    await runtime.telemetry.flush();
    const retained = spans(exported);
    for (const [id, address] of [
      [51, "ops.echo"],
      [52, "ops.fail"],
      [53, "ops.failLarge"],
    ] as const) {
      const owner = admission(retained, "procedure", String(id));
      const handoff = runtime.procedureHandoffs.get(id)!;
      const responseSpans = retained.filter((record) =>
        record.operation === "procedure" &&
        record.resource === "operation" &&
        record.traceId === owner.traceId &&
        (record.stage === "encoding" || record.stage === "delivery")
      );
      expect(responseSpans.map((record) => record.stage).sort()).toEqual([
        "delivery",
        "encoding",
      ]);
      expect(responseSpans.every((record) => record.requestId === String(id))).toBe(true);
      expect(responseSpans.every((record) => record.function === address)).toBe(true);
      expect(responseSpans.every((record) => record.sizeBytes === handoff.bytes)).toBe(true);
    }

    const responderAdmission = admission(retained, "procedure", "54");
    const responderSpans = retained.filter((record) =>
      record.operation === "procedure" &&
      record.resource === "operation" &&
      record.traceId === responderAdmission.traceId &&
      (record.stage === "encoding" || record.stage === "delivery")
    );
    expect(responderSpans.map(({ stage, outcome }) => ({ stage, outcome }))).toEqual([
      { stage: "encoding", outcome: "ok" },
      { stage: "delivery", outcome: "internal" },
    ]);
    expect(responderSpans.every((record) =>
      record.requestId === "54" && record.function === "ops.echo"
    )).toBe(true);
    expect(responderSpans.every((record) => record.sizeBytes === failedHandoff!.bytes)).toBe(true);
  } finally {
    await server.drain().catch(() => {});
    await runtime.drain(Date.now() + 2_000).catch(() => {});
    engine.close("clean");
    rmSync(directory, { recursive: true, force: true });
  }
});

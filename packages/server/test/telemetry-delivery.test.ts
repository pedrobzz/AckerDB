import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  PROTOCOL_VERSION,
  decode,
  type ServerMessage,
} from "@dbzz/core";
import {
  Engine,
  OutboundBudget,
  Registry,
  Runtime,
  Session,
  WebSocketSessionSink,
  dbz,
  defineSchema,
  defineTable,
  mutation,
  query,
  reconcile,
  type TelemetryRecord,
  type TelemetrySpanRecord,
  type WebSocketDeliverySocket,
} from "@dbzz/server";

const encoder = new TextEncoder();

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
    add: mutation({
      access: "public",
      args: { body: dbz.string() },
      handler: (ctx: Ctx, args: Ctx) => ctx.db.notes.insert(args),
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

function spans(records: readonly TelemetryRecord[]): TelemetrySpanRecord[] {
  return records.filter((record): record is TelemetrySpanRecord => record.kind === "span");
}

function admission(
  records: readonly TelemetrySpanRecord[],
  operation: "query" | "mutation",
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
  session = new Session({ runtime, sink });

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

    await session.handle({ v: PROTOCOL_VERSION, t: "ping" });
    await settle();
    await runtime.telemetry.flush();

    expect([...socket.activeOperationsAtApplicationSend.entries()]).toEqual([
      [41, 0],
      [42, 0],
      [43, 0],
    ]);
    const errorFrames = socket.frames
      .map((text) => decode(text) as ServerMessage)
      .filter((frame) => frame.t === "err" && frame.id === 43);
    expect(errorFrames).toHaveLength(1);
    expect(errorFrames[0]).toMatchObject({ outcome: { code: "not_found" } });

    const retained = spans(exported);
    const queryAdmission = admission(retained, "query", "41");
    const mutationAdmission = admission(retained, "mutation", "42");
    const failureAdmission = admission(retained, "query", "43");
    const queryDelivery = delivery(retained, "query", queryAdmission.traceId!);
    const mutationDelivery = delivery(retained, "mutation", mutationAdmission.traceId!);
    const failureDelivery = delivery(retained, "query", failureAdmission.traceId!);

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
    engine.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

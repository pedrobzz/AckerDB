import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  PROTOCOL_VERSION,
  decode,
  encode,
  parseSseMessage,
  type MutationMessage,
} from "@dbzz/core";
import {
  ANONYMOUS_PRINCIPAL,
  Engine,
  PRODUCTION_LIMITS,
  Registry,
  Runtime,
  dbz,
  defineEventTable,
  defineSchema,
  defineTable,
  mutation,
  procedure,
  query,
  reconcile,
  sseProcedure,
  type RuntimeOptions,
  type RuntimePublication,
  type RuntimeRequest,
  type SessionApplicationMessage,
  type SessionRuntimeContext,
  type TelemetryEventRecord,
  type TelemetryExporter,
  type TelemetryMetricRecord,
  type TelemetryRecord,
  type TelemetrySpanRecord,
} from "@dbzz/server";
import { callerFairnessKey } from "../src/caller.ts";

const PRIMARY_SESSION = "telemetry-acceptance-primary-session";
const FAILING_SESSION = "telemetry-acceptance-failing-session";
const PRIVATE_BODY = "private-body-canary-4d95d2";
const PRIVATE_FETCH = "private-fetch-canary-f31183";
const PRIVATE_STREAM = "private-stream-canary-82fca5";
const PRIVATE_FAILURE = "private-failure-canary-747d96";
const PRIVATE_DELIVERY = "private-delivery-canary-b25ea3";

const QUERY_SUBSCRIPTION_ID = 810_000_001;
const MATCHING_EVENT_SUBSCRIPTION_ID = 810_000_002;
const NONMATCHING_EVENT_SUBSCRIPTION_ID = 810_000_003;
const FAILING_SUBSCRIPTION_ID = 810_000_004;
const TEST_SOURCE = Object.freeze({ family: "test", address: "telemetry-runtime" });

function request<Message>(message: Message, bytes = Buffer.byteLength(encode(message))): RuntimeRequest<Message> {
  return { message, bytes };
}

const schema = defineSchema({
  items: defineTable({
    id: dbz.primaryKey(),
    room: dbz.bigint(),
    body: dbz.string(),
  }).index("by_room", ["room"]),
  signals: defineEventTable({
    id: dbz.primaryKey(),
    room: dbz.bigint(),
  }, {
    args: { room: dbz.bigint() },
    access: "public",
    matches: (row, args) => row.room === args.room,
  }),
  audit: defineTable({
    id: dbz.primaryKey(),
    line: dbz.string(),
  }),
  jobs: defineTable({
    id: dbz.primaryKey(),
    label: dbz.string(),
    at: dbz.scheduleAt(),
  }).scheduled("jobs.run"),
});

// This test owns the Runtime boundary, not generated application types.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Ctx = any;

let operatorReadGate: Promise<void> | null = null;
let operatorReadEntered: (() => void) | null = null;
let operatorReadCount = 0;
let operatorSseGate: Promise<void> | null = null;
let operatorSseEntered: (() => void) | null = null;

const addItem = mutation({
  access: "public",
  args: { room: dbz.bigint(), body: dbz.string() },
  handler: async (ctx: Ctx, args: Ctx) => {
    const id = await ctx.db.items.insert(args);
    await ctx.db.signals.insert({ room: args.room });
    return id;
  },
});

const functions = {
  items: {
    list: query({
      access: "public",
      args: { room: dbz.bigint() },
      handler: (ctx: Ctx, args: Ctx) =>
        ctx.db.items.byRoom((builder: Ctx) => builder.eq("room", args.room)).collect(),
    }),
    hold: query({
      access: "public",
      args: {},
      handler: async () => {
        if (operatorReadGate !== null) {
          operatorReadCount++;
          if (operatorReadCount === PRODUCTION_LIMITS.revalidationConcurrency) {
            operatorReadEntered?.();
          }
          await operatorReadGate;
        }
        return "released";
      },
    }),
    add: addItem,
    touch: mutation({
      access: "public",
      args: { id: dbz.bigint() },
      handler: async (ctx: Ctx, args: Ctx) => {
        const row = await ctx.db.items.get(args.id);
        await ctx.db.items.patch(args.id, { body: row.body });
      },
    }),
    fail: mutation({
      access: "public",
      args: { room: dbz.bigint(), body: dbz.string() },
      handler: async (ctx: Ctx, args: Ctx) => {
        await ctx.db.items.insert(args);
        throw new Error(`${PRIVATE_FAILURE}:${args.body}`);
      },
    }),
  },
  audit: {
    list: query({
      access: "public",
      args: {},
      handler: (ctx: Ctx) => ctx.db.audit.scan().collect(),
    }),
  },
  jobs: {
    schedule: mutation({
      access: "public",
      args: { label: dbz.string(), at: dbz.number() },
      handler: (ctx: Ctx, args: Ctx) => ctx.db.jobs.insert(args),
    }),
    run: mutation({
      access: "system",
      args: { id: dbz.bigint(), label: dbz.string(), at: dbz.number() },
      handler: (ctx: Ctx, args: Ctx) => ctx.db.audit.insert({ line: `scheduled:${args.label}` }),
    }),
  },
  ops: {
    pipeline: procedure({
      access: "public",
      args: { room: dbz.bigint(), payload: dbz.string() },
      handler: async (ctx: Ctx, args: Ctx) => {
        const external = await (await fetch(
          `data:text/plain,${encodeURIComponent(args.payload)}`,
        )).text();
        return ctx.tx(async (tx: Ctx) => {
          const id = await addItem(tx, { room: args.room, body: external });
          const row = await tx.db.items.get(id);
          return { id, body: row.body };
        });
      },
    }),
    stream: sseProcedure({
      access: "public",
      args: { payload: dbz.string() },
      handler: async (ctx: Ctx, args: Ctx) => {
        ctx.stream.write({ payload: args.payload });
        if (operatorSseGate !== null) {
          operatorSseEntered?.();
          await operatorSseGate;
        }
        await ctx.tx((tx: Ctx) => tx.db.audit.insert({ line: "sse:complete" }));
      },
    }),
  },
};

interface TestSession {
  readonly context: SessionRuntimeContext;
  readonly publications: SessionApplicationMessage[];
  readonly abort: () => void;
}

class RuntimeHarness {
  readonly directory = mkdtempSync(join(tmpdir(), "dbzz-telemetry-runtime-"));
  readonly engine = new Engine(schema, join(this.directory, "data.db"));
  readonly runtime: Runtime;
  private readonly sessions: TestSession[] = [];
  private closed = false;

  constructor(telemetry: RuntimeOptions["telemetry"]) {
    reconcile(this.engine);
    this.runtime = new Runtime({
      engine: this.engine,
      registry: new Registry(functions),
      telemetry,
    });
  }

  async openSession(
    clientSessionId: string,
    publish?: (frame: RuntimePublication) => Promise<boolean> | boolean,
  ): Promise<TestSession> {
    const controller = new AbortController();
    const publications: SessionApplicationMessage[] = [];
    const context: SessionRuntimeContext = Object.freeze({
      clientSessionId,
      principal: ANONYMOUS_PRINCIPAL,
      fairnessKey: callerFairnessKey(ANONYMOUS_PRINCIPAL, TEST_SOURCE),
      authEpoch: 0,
      signal: controller.signal,
      publish: async (frame: RuntimePublication) => {
        publications.push(frame.message);
        return publish === undefined ? true : publish(frame);
      },
    });
    await this.runtime.openSession(context);
    const session = Object.freeze({
      context,
      publications,
      abort: () => controller.abort(),
    });
    this.sessions.push(session);
    return session;
  }

  mutation(
    context: SessionRuntimeContext,
    id: number,
    ref: string,
    args: unknown,
    mutationRequestId = uuidV7(Date.now(), id),
    issuedAt = Date.now(),
  ) {
    const message: MutationMessage = {
      v: PROTOCOL_VERSION,
      t: "m",
      id,
      ref,
      args,
      mutationRequestId,
      issuedAt,
    };
    return this.runtime.mutation(context, request(message));
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    for (const session of this.sessions) session.abort();
    await this.runtime.drain(Date.now() + 2_000).catch(() => {});
    this.engine.close("clean");
    rmSync(this.directory, { recursive: true, force: true });
  }
}

const harnesses = new Set<RuntimeHarness>();

function harness(telemetry: RuntimeOptions["telemetry"]): RuntimeHarness {
  const created = new RuntimeHarness(telemetry);
  harnesses.add(created);
  return created;
}

afterEach(async () => {
  await Promise.all([...harnesses].map((created) => created.close()));
  harnesses.clear();
  operatorReadGate = null;
  operatorReadEntered = null;
  operatorReadCount = 0;
  operatorSseGate = null;
  operatorSseEntered = null;
});

function uuidV7(now: number, sequence: number): string {
  const timestamp = now.toString(16).padStart(12, "0");
  return `${timestamp.slice(0, 8)}-${timestamp.slice(8)}-7000-8000-${sequence.toString(16).padStart(12, "0")}`;
}

async function collectSse(
  runtime: Runtime,
  response: Awaited<ReturnType<Runtime["runSse"]>>,
): Promise<string> {
  const decoder = new TextDecoder();
  let body = "";
  let buffered = "";
  for await (const chunk of response.stream as unknown as AsyncIterable<Uint8Array>) {
    const text = decoder.decode(chunk, { stream: true });
    body += text;
    buffered += text;
    for (;;) {
      const boundary = buffered.indexOf("\n\n");
      if (boundary === -1) break;
      const block = buffered.slice(0, boundary);
      buffered = buffered.slice(boundary + 2);
      const payload = block.split("\n")
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).replace(/^ /, ""))
        .join("\n");
      const frame = parseSseMessage(decode(payload));
      runtime.ackSse({
        v: PROTOCOL_VERSION,
        t: "sse_ack",
        stream: response.streamId,
        seq: frame.seq,
        proof: frame.proof,
      });
    }
  }
  body += decoder.decode();
  expect(buffered).toBe("");
  return body;
}

function spans(records: readonly TelemetryRecord[]): TelemetrySpanRecord[] {
  return records.filter((record): record is TelemetrySpanRecord => record.kind === "span");
}

function events(records: readonly TelemetryRecord[]): TelemetryEventRecord[] {
  return records.filter((record): record is TelemetryEventRecord => record.kind === "event");
}

function metrics(records: readonly TelemetryRecord[]): TelemetryMetricRecord[] {
  return records.filter((record): record is TelemetryMetricRecord => record.kind === "metric");
}

function requiredSpan(
  records: readonly TelemetrySpanRecord[],
  predicate: (record: TelemetrySpanRecord) => boolean,
): TelemetrySpanRecord {
  const record = records.find(predicate);
  expect(record).toBeDefined();
  return record!;
}

function expectRetainedParentage(
  records: readonly TelemetrySpanRecord[],
  admission: TelemetrySpanRecord,
): void {
  expect(hasRetainedParentage(records, admission)).toBe(true);
}

function hasRetainedParentage(
  records: readonly TelemetrySpanRecord[],
  admission: TelemetrySpanRecord,
): boolean {
  const trace = records.filter((record) => record.traceId === admission.traceId);
  const retainedSpanIds = new Set(trace.map((record) => record.spanId));
  return admission.parentSpanId === undefined && trace.every((record) =>
    record.spanId === admission.spanId ||
    (record.parentSpanId !== undefined && retainedSpanIds.has(record.parentSpanId))
  );
}

const telemetryLimits = Object.freeze({
  maxRecords: 4_096,
  maxBytes: 8 * 1_024 * 1_024,
  maxMetricSeries: 512,
  maxBatchRecords: 4_096,
  batchIntervalMs: 60_000,
  exportTimeoutMs: 25,
  retentionMs: 60_000,
  slowOperationMs: 0,
  sampleIntervalMs: 60_000,
});

const operatorMetricUnits = Object.freeze({
  "runtime.connections": "gauge",
  "runtime.operations": "gauge",
  "runtime.operation_callers": "gauge",
  "runtime.sse_streams": "gauge",
  "runtime.subscriptions": "gauge",
  "runtime.subscription_entries": "gauge",
  "runtime.subscription_result_bytes": "bytes",
  "runtime.subscription_history_items": "gauge",
  "runtime.subscription_history_bytes": "bytes",
  "runtime.read_queue_items": "gauge",
  "runtime.read_queue_bytes": "bytes",
  "runtime.read_queue_age": "milliseconds",
  "runtime.write_queue_items": "gauge",
  "runtime.write_queue_bytes": "bytes",
  "runtime.write_queue_age": "milliseconds",
  "runtime.revalidation_active": "gauge",
  "runtime.revalidation_queue_items": "gauge",
  "runtime.revalidation_queue_bytes": "bytes",
  "runtime.revalidation_queue_age": "milliseconds",
  "runtime.publication_items": "gauge",
  "runtime.publication_bytes": "bytes",
  "runtime.publication_age": "milliseconds",
  "runtime.auth_capture_bytes": "bytes",
  "runtime.sse_outbound_bytes": "bytes",
  "runtime.database_bytes": "bytes",
  "runtime.wal_bytes": "bytes",
  "runtime.checkpoint_completed": "gauge",
  "runtime.checkpoint_age": "milliseconds",
  "runtime.recovered_from_crash": "gauge",
  "runtime.mutation_replay_records": "gauge",
  "runtime.mutation_replay_bytes": "bytes",
  "runtime.telemetry_queue_records": "gauge",
  "runtime.telemetry_queue_bytes": "bytes",
  "runtime.telemetry_queue_age": "milliseconds",
  "runtime.telemetry_local_queue_records": "gauge",
  "runtime.telemetry_local_queue_bytes": "bytes",
  "runtime.telemetry_export_attempts": "count",
  "runtime.telemetry_export_failures": "count",
  "runtime.telemetry_export_timeouts": "count",
  "runtime.telemetry_export_duration": "milliseconds",
  "runtime.telemetry_drops": "count",
  "runtime.rss_bytes": "bytes",
  "runtime.cpu_cores": "gauge",
  "runtime.event_loop_drift": "milliseconds",
} as const);

describe("Runtime telemetry acceptance", () => {
  test("closes whole-operation tail decisions after final response work", async () => {
    const exported: TelemetryRecord[] = [];
    const app = harness({
      enabled: true,
      exporter: { export: (batch) => void exported.push(...batch) },
      localSink: false,
      limits: { ...telemetryLimits, slowOperationMs: 10_000 },
    });
    const session = await app.openSession("telemetry-tail-runtime");

    await app.runtime.query(session.context, request({
      v: PROTOCOL_VERSION,
      t: "q",
      id: 740_000_001,
      ref: "items.list",
      args: { room: 1n },
    }));
    await expect(app.mutation(
      session.context,
      740_000_002,
      "items.fail",
      { room: 1n, body: PRIVATE_FAILURE },
    )).rejects.toBeDefined();

    expect(app.runtime.telemetry.snapshot()).toMatchObject({
      traceRetention: {
        activeTraces: 0,
        completedDecisions: 2,
        promotedTraces: 1,
      },
    });
    await app.runtime.telemetry.flush();
    const retained = spans(exported);
    expect(retained.some((span) => span.requestId === "740000001")).toBe(false);
    const failed = retained.filter((span) => span.requestId === "740000002");
    expect(failed.some((span) => span.stage === "admission")).toBe(true);
    expect(failed.some((span) => span.stage === "handler" && span.outcome !== "ok")).toBe(true);
    expect(app.runtime.telemetry.aggregateSnapshot().series).toContainEqual(
      expect.objectContaining({ operation: "query", outcome: "ok" }),
    );
  });

  test("uses canonical bytes for untrusted direct Runtime telemetry", async () => {
    const exported: TelemetryRecord[] = [];
    const app = harness({
      enabled: true,
      exporter: { export: (batch) => void exported.push(...batch) },
      localSink: false,
      limits: { ...telemetryLimits, slowOperationMs: 0 },
    });
    const session = await app.openSession("telemetry-request-bytes");
    const message = {
      v: PROTOCOL_VERSION,
      t: "q",
      id: 740_000_010,
      ref: "items.list",
      args: { room: 1n },
    } as const;
    const bytes = Buffer.byteLength(encode(message));

    await app.runtime.query(session.context, request(message, Number.MAX_SAFE_INTEGER));
    await app.runtime.telemetry.flush();

    const querySpans = spans(exported).filter((span) => span.requestId === "740000010");
    expect(requiredSpan(querySpans, (span) => span.stage === "admission").sizeBytes).toBe(bytes);
    expect(requiredSpan(querySpans, (span) => span.stage === "queue").sizeBytes).toBe(bytes);
  });

  test("keeps an SSE tail lifecycle active through terminal stream delivery", async () => {
    const app = harness({
      enabled: true,
      localSink: false,
      limits: { ...telemetryLimits, slowOperationMs: 10_000 },
    });
    let releaseSse!: () => void;
    operatorSseGate = new Promise<void>((resolve) => {
      releaseSse = resolve;
    });
    const entered = new Promise<void>((resolve) => {
      operatorSseEntered = resolve;
    });
    const stream = await app.runtime.runSse({
      id: 740_000_003,
      address: "ops.stream",
      args: { payload: PRIVATE_STREAM },
      principal: ANONYMOUS_PRINCIPAL,
    });
    await entered;
    expect(app.runtime.telemetry.snapshot().traceRetention.activeTraces).toBe(1);

    const body = collectSse(app.runtime, stream);
    releaseSse();
    expect(await body).toContain('"t":"sse_done"');
    expect(app.runtime.telemetry.snapshot().traceRetention).toMatchObject({
      activeTraces: 0,
      completedDecisions: 1,
    });
  });

  test("covers public runtime flows with safe, correlated, bounded records", async () => {
    const exported: TelemetryRecord[] = [];
    const exporter: TelemetryExporter = {
      export(batch) {
        exported.push(...batch);
      },
    };
    const app = harness({
      enabled: true,
      exporter,
      localSink: false,
      limits: telemetryLimits,
    });
    const primary = await app.openSession(PRIMARY_SESSION);

    await app.runtime.subscribe(primary.context, request({
      v: PROTOCOL_VERSION,
      t: "sub",
      id: QUERY_SUBSCRIPTION_ID,
      ref: "items.list",
      args: { room: 1n },
    }));
    await app.runtime.subscribe(primary.context, request({
      v: PROTOCOL_VERSION,
      t: "sub",
      id: MATCHING_EVENT_SUBSCRIPTION_ID,
      ref: "events.signals",
      args: { room: 1n },
    }));
    await app.runtime.subscribe(primary.context, request({
      v: PROTOCOL_VERSION,
      t: "sub",
      id: NONMATCHING_EVENT_SUBSCRIPTION_ID,
      ref: "events.signals",
      args: { room: 2n },
    }));

    const issuedAt = Date.now();
    const mutationId = uuidV7(issuedAt, 71);
    const first = await app.mutation(
      primary.context,
      710_000_001,
      "items.add",
      { room: 1n, body: PRIVATE_BODY },
      mutationId,
      issuedAt,
    );
    const replay = await app.mutation(
      primary.context,
      710_000_002,
      "items.add",
      { room: 1n, body: PRIVATE_BODY },
      mutationId,
      issuedAt,
    );
    expect(replay).toMatchObject({
      value: first.value,
      receipt: { replay: "replayed", commitVersion: first.receipt.commitVersion },
    });

    await app.mutation(primary.context, 710_000_003, "items.touch", { id: first.value });

    const procedureResponse = await app.runtime.runProcedure({
      id: 720_000_001,
      address: "ops.pipeline",
      args: { room: 1n, payload: PRIVATE_FETCH },
      principal: ANONYMOUS_PRINCIPAL,
      respond: ({ body, status }) => new Response(body, { status }),
    });
    expect(procedureResponse.status).toBe(200);
    expect(decode(await procedureResponse.text())).toMatchObject({
      t: "ok",
      kind: "procedure",
      value: { body: PRIVATE_FETCH },
    });

    const stream = await app.runtime.runSse({
      id: 730_000_001,
      address: "ops.stream",
      args: { payload: PRIVATE_STREAM },
      principal: ANONYMOUS_PRINCIPAL,
    });
    const sseBody = await collectSse(app.runtime, stream);
    expect(sseBody).toContain(PRIVATE_STREAM);
    expect(sseBody).toContain('"t":"sse_done"');

    const scheduleIssuedAt = Date.now();
    const scheduleMutationId = uuidV7(scheduleIssuedAt, 74);
    const dueAt = scheduleIssuedAt + 120_000;
    const scheduled = await app.mutation(primary.context, 740_000_001, "jobs.schedule", {
      label: "acceptance",
      at: dueAt,
    }, scheduleMutationId, scheduleIssuedAt);
    expect(await app.runtime.runScheduled(dueAt)).toBe(1);

    let failingPublishes = 0;
    const failing = await app.openSession(FAILING_SESSION, () => {
      failingPublishes++;
      if (failingPublishes === 1) return true;
      throw new Error(PRIVATE_DELIVERY);
    });
    await app.runtime.subscribe(failing.context, request({
      v: PROTOCOL_VERSION,
      t: "sub",
      id: FAILING_SUBSCRIPTION_ID,
      ref: "items.list",
      args: { room: 3n },
    }));
    const deliveryIssuedAt = Date.now();
    const deliveryMutationId = uuidV7(deliveryIssuedAt, 72);
    const deliveredCommit = await app.mutation(
      primary.context,
      710_000_004,
      "items.add",
      { room: 3n, body: "delivery-failure-still-commits" },
      deliveryMutationId,
      deliveryIssuedAt,
    );

    const failedMutationId = uuidV7(Date.now(), 73);
    await expect(app.mutation(
      primary.context,
      760_000_001,
      "items.fail",
      { room: 4n, body: PRIVATE_BODY },
      failedMutationId,
    )).rejects.toThrow(PRIVATE_FAILURE);

    const roomOne = await app.runtime.query(primary.context, request({
      v: PROTOCOL_VERSION,
      t: "q",
      id: 750_000_001,
      ref: "items.list",
      args: { room: 1n },
    })) as Array<{ id: bigint; room: bigint; body: string }>;
    expect(roomOne.map((row) => row.body)).toEqual([PRIVATE_BODY, PRIVATE_FETCH]);
    expect(await app.runtime.query(primary.context, request({
      v: PROTOCOL_VERSION,
      t: "q",
      id: 750_000_002,
      ref: "items.list",
      args: { room: 3n },
    }))).toHaveLength(1);
    expect(await app.runtime.query(primary.context, request({
      v: PROTOCOL_VERSION,
      t: "q",
      id: 750_000_003,
      ref: "items.list",
      args: { room: 4n },
    }))).toEqual([]);
    expect(await app.runtime.query(primary.context, request({
      v: PROTOCOL_VERSION,
      t: "q",
      id: 750_000_004,
      ref: "audit.list",
      args: {},
    }))).toMatchObject([
      { line: "sse:complete" },
      { line: "scheduled:acceptance" },
    ]);

    const queryTransitions = primary.publications.filter(
      (frame) => frame.t === "transition" && frame.id === QUERY_SUBSCRIPTION_ID,
    );
    expect(queryTransitions).toMatchObject([
      { transition: { kind: "reset" } },
      { transition: { kind: "update" } },
      { transition: { kind: "checkpoint" } },
      { transition: { kind: "update" } },
    ]);
    expect(primary.publications.filter(
      (frame) => frame.t === "event" &&
        frame.id === MATCHING_EVENT_SUBSCRIPTION_ID && frame.event.kind === "row",
    )).toHaveLength(2);
    expect(primary.publications.filter(
      (frame) => frame.t === "event" &&
        frame.id === NONMATCHING_EVENT_SUBSCRIPTION_ID && frame.event.kind === "row",
    )).toEqual([]);

    await Bun.sleep(0);
    const aggregate = app.runtime.telemetry.aggregateSnapshot();
    const aggregateStages = aggregate.series.flatMap((series) =>
      series.stage === undefined ? [] : [series.stage]
    );
    expect(aggregateStages).toEqual(expect.arrayContaining([
      "admission",
      "auth",
      "policy",
      "handler",
      "fetch",
      "statement",
      "storage",
      "commit",
      "rollback",
      "publication",
      "match",
      "evaluation",
      "changed",
      "unchanged",
      "encoding",
      "fanout",
      "queue",
      "delivery",
    ]));
    const aggregateOperations = aggregate.series.flatMap((series) =>
      series.operation === undefined ? [] : [series.operation]
    );
    expect(aggregateOperations).toEqual(expect.arrayContaining([
      "query",
      "mutation",
      "procedure",
      "sse",
      "scheduled",
      "subscription",
    ]));
    expect(aggregate.maxSeries).toBe(telemetryLimits.maxMetricSeries);
    expect(aggregate.series.length).toBeLessThanOrEqual(aggregate.maxSeries);
    expect(aggregate.series.find((series) =>
      series.operation === "mutation" &&
      series.stage === "admission" &&
      series.outcome === "ok" &&
      series.function === "items.add"
    )?.count).toBeGreaterThanOrEqual(3);

    const highCardinalityIds = [
      "710000001",
      "710000002",
      "720000001",
      "730000001",
      String(QUERY_SUBSCRIPTION_ID),
      mutationId,
      deliveryMutationId,
    ];
    const aggregateJson = JSON.stringify(aggregate);
    for (const id of highCardinalityIds) expect(aggregateJson).not.toContain(id);

    await app.runtime.telemetry.flush();
    const retainedSpans = spans(exported);
    const retainedEvents = events(exported);

    const queryAdmission = requiredSpan(retainedSpans, (span) =>
      span.operation === "query" &&
      span.stage === "admission" &&
      span.requestId === "750000001"
    );
    expectRetainedParentage(retainedSpans, queryAdmission);

    const mutationAdmission = requiredSpan(retainedSpans, (span) =>
      span.operation === "mutation" &&
      span.stage === "admission" &&
      span.requestId === "710000001" &&
      span.mutationId === mutationId
    );
    expect(mutationAdmission.connectionId).toBeDefined();
    expect(mutationAdmission.connectionId).not.toBe(PRIMARY_SESSION);
    const mutationHandler = requiredSpan(retainedSpans, (span) =>
      span.stage === "handler" &&
      span.function === "items.add" &&
      span.mutationId === mutationId
    );
    expect(mutationHandler.parentSpanId).toBe(mutationAdmission.spanId);
    const mutationStatement = requiredSpan(retainedSpans, (span) =>
      span.stage === "statement" &&
      span.function === "items.add" &&
      span.mutationId === mutationId
    );
    expect(mutationStatement.parentSpanId).toBe(mutationHandler.spanId);
    const committed = requiredSpan(retainedSpans, (span) =>
      span.stage === "commit" &&
      span.mutationId === mutationId &&
      span.commitId === String(first.receipt.commitVersion)
    );
    expect(committed.traceId).toBe(mutationAdmission.traceId);
    const replayStorage = requiredSpan(retainedSpans, (span) =>
      span.stage === "storage" &&
      span.requestId === "710000002" &&
      span.mutationId === mutationId &&
      span.replayed === true
    );
    expect(replayStorage.commitId).toBe(String(first.receipt.commitVersion));
    const replayAdmission = requiredSpan(retainedSpans, (span) =>
      span.operation === "mutation" &&
      span.stage === "admission" &&
      span.requestId === "710000002" &&
      span.mutationId === mutationId
    );
    const replaySkippedHandler = !retainedSpans.some((span) =>
      span.traceId === replayAdmission.traceId && span.stage === "handler"
    );
    expectRetainedParentage(retainedSpans, mutationAdmission);

    const procedureAdmission = requiredSpan(retainedSpans, (span) =>
      span.operation === "procedure" &&
      span.stage === "admission" &&
      span.requestId === "720000001"
    );
    const procedureHandler = requiredSpan(retainedSpans, (span) =>
      span.stage === "handler" &&
      span.function === "ops.pipeline" &&
      span.requestId === "720000001"
    );
    const nestedHandler = requiredSpan(retainedSpans, (span) =>
      span.stage === "handler" &&
      span.function === "items.add" &&
      span.requestId === "720000001"
    );
    const fetchSpan = requiredSpan(retainedSpans, (span) =>
      span.stage === "fetch" && span.requestId === "720000001"
    );
    expect(procedureHandler.parentSpanId).toBe(procedureAdmission.spanId);
    expect(nestedHandler.parentSpanId).toBe(procedureHandler.spanId);
    expect(fetchSpan.parentSpanId).toBe(procedureHandler.spanId);
    const procedureTransactionCommit = retainedSpans.find((span) =>
      span.operation === "transaction" &&
      span.stage === "commit" &&
      span.requestId === "720000001"
    );
    expectRetainedParentage(retainedSpans, procedureAdmission);

    const sseAdmission = requiredSpan(retainedSpans, (span) =>
      span.operation === "sse" &&
      span.stage === "admission" &&
      span.requestId === "730000001"
    );
    const sseHandler = requiredSpan(retainedSpans, (span) =>
      span.operation === "sse" &&
      span.stage === "handler" &&
      span.function === "ops.stream" &&
      span.requestId === "730000001"
    );
    const sseTransactionCommit = retainedSpans.find((span) =>
      span.operation === "transaction" &&
      span.stage === "commit" &&
      span.requestId === "730000001"
    );
    const sseDelivery = retainedSpans.find((span) =>
      span.operation === "sse" &&
      span.stage === "delivery" &&
      span.requestId === "730000001"
    );
    expectRetainedParentage(retainedSpans, sseAdmission);

    const subscriptionAdmission = requiredSpan(retainedSpans, (span) =>
      span.operation === "subscription" &&
      span.stage === "admission" &&
      span.requestId === String(QUERY_SUBSCRIPTION_ID) &&
      span.subscriptionId === String(QUERY_SUBSCRIPTION_ID)
    );
    const initialSubscriptionTrace = retainedSpans.filter((span) =>
      span.traceId === subscriptionAdmission.traceId
    );
    expect(initialSubscriptionTrace.length).toBeGreaterThan(1);
    expectRetainedParentage(retainedSpans, subscriptionAdmission);
    expect(requiredSpan(retainedSpans, (span) =>
      span.operation === "subscription" &&
      span.stage === "evaluation" &&
      span.subscriptionId === String(QUERY_SUBSCRIPTION_ID)
    )).toBeDefined();
    expect(requiredSpan(retainedSpans, (span) =>
      span.operation === "subscription" &&
      span.stage === "changed" &&
      span.function === "items.list"
    )).toBeDefined();
    expect(requiredSpan(retainedSpans, (span) =>
      span.operation === "subscription" &&
      span.stage === "unchanged" &&
      span.function === "items.list"
    )).toBeDefined();

    const mutationRevalidation = retainedSpans.filter((span) =>
      span.traceId === mutationAdmission.traceId && span.function === "items.list"
    );
    expect(mutationRevalidation.length).toBeGreaterThan(0);

    const unmatchedInvalidation = requiredSpan(retainedSpans, (span) =>
      span.operation === "subscription" &&
      span.stage === "match" &&
      span.mutationId === scheduleMutationId &&
      span.commitId === String(scheduled.receipt.commitVersion) &&
      span.resultCount === 0
    );
    expect(unmatchedInvalidation).toMatchObject({ dependencyCount: 2 });
    expect(unmatchedInvalidation.function).toBeUndefined();

    const scheduledAdmission = requiredSpan(retainedSpans, (span) =>
      span.operation === "scheduled" && span.stage === "admission"
    );
    const scheduledTrace = retainedSpans.filter((span) => span.traceId === scheduledAdmission.traceId);
    expect(scheduledTrace.filter((span) => span.stage === "admission")).toHaveLength(1);
    expect(scheduledTrace.map((span) => span.stage)).toEqual(expect.arrayContaining([
      "queue",
      "statement",
      "auth",
      "policy",
      "handler",
      "storage",
      "commit",
    ]));
    expect(scheduledTrace.some((span) =>
      span.function === "jobs.run" &&
      (span.operation === "scheduled" || span.operation === "transaction")
    )).toBe(true);
    const scheduledRootTraceIds = new Set(retainedSpans.filter((span) =>
      span.operation === "scheduled" && span.stage === "admission"
    ).map((span) => span.traceId));
    const scheduledRootsCoherent = retainedSpans.filter((span) =>
      span.operation === "scheduled"
    ).every((span) =>
      span.traceId !== undefined && scheduledRootTraceIds.has(span.traceId)
    ) && hasRetainedParentage(retainedSpans, scheduledAdmission);

    const eventMatches = retainedSpans.filter((span) =>
      span.operation === "subscription" && span.stage === "match" && span.function === "signals"
    );
    expect(eventMatches).toEqual(expect.arrayContaining([
      expect.objectContaining({
        subscriptionId: String(MATCHING_EVENT_SUBSCRIPTION_ID),
        resultCount: 1,
      }),
      expect.objectContaining({
        subscriptionId: String(NONMATCHING_EVENT_SUBSCRIPTION_ID),
        resultCount: 0,
      }),
    ]));
    expect(retainedSpans.some((span) =>
      span.operation === "subscription" &&
      span.stage === "delivery" &&
      span.subscriptionId === String(QUERY_SUBSCRIPTION_ID) &&
      span.mutationId === mutationId &&
      span.commitId === String(first.receipt.commitVersion)
    )).toBe(true);

    expect(retainedEvents).toContainEqual(expect.objectContaining({
      kind: "event",
      name: "failure",
      level: "error",
      operation: "mutation",
      outcome: "internal",
      function: "items.fail",
      mutationId: failedMutationId,
      errorClass: "Error",
    }));
    const reactiveFailure = retainedEvents.find((event) =>
      event.name === "failure" &&
      event.operation === "subscription" &&
      event.subscriptionId === String(FAILING_SUBSCRIPTION_ID)
    );
    expect(reactiveFailure).toMatchObject({
      traceId: requiredSpan(retainedSpans, (span) =>
        span.stage === "admission" && span.mutationId === deliveryMutationId
      ).traceId,
      mutationId: deliveryMutationId,
      commitId: String(deliveredCommit.receipt.commitVersion),
    });

    expect({
      aggregateIncludesTransactions: aggregateOperations.includes("transaction"),
      replaySkippedHandler,
      initialSubscriptionRoutedAsSubscription: initialSubscriptionTrace.every((span) =>
        span.operation === "subscription"
      ),
      revalidationRoutedAsSubscription: mutationRevalidation.every((span) =>
        span.operation === "subscription"
      ),
      procedureTransactionParentedToHandler:
        procedureTransactionCommit?.parentSpanId === procedureHandler.spanId,
      sseTransactionParentedToHandler: sseTransactionCommit?.parentSpanId === sseHandler.spanId,
      sseDeliveryParentedToHandler: sseDelivery?.parentSpanId === sseHandler.spanId,
      scheduledRootsCoherent,
    }).toEqual({
      aggregateIncludesTransactions: true,
      replaySkippedHandler: true,
      initialSubscriptionRoutedAsSubscription: true,
      revalidationRoutedAsSubscription: true,
      procedureTransactionParentedToHandler: true,
      sseTransactionParentedToHandler: true,
      sseDeliveryParentedToHandler: true,
      scheduledRootsCoherent: true,
    });

    const telemetryJson = JSON.stringify(exported);
    for (const canary of [
      PRIMARY_SESSION,
      FAILING_SESSION,
      PRIVATE_BODY,
      PRIVATE_FETCH,
      PRIVATE_STREAM,
      PRIVATE_FAILURE,
      PRIVATE_DELIVERY,
    ]) {
      expect(telemetryJson).not.toContain(canary);
    }
    for (const unsafeKey of ["args", "result", "row", "literalSql", "message", "principalId"]) {
      expect(telemetryJson).not.toContain(`"${unsafeKey}":`);
    }
    expect(exported.every(Object.isFrozen)).toBe(true);
  });

  test("samples the complete operator surface from TelemetryOptions", async () => {
    const exported: TelemetryRecord[] = [];
    const sampled = Promise.withResolvers<readonly TelemetryMetricRecord[]>();
    let samplingArmed = false;
    const exporter: TelemetryExporter = {
      export(batch) {
        exported.push(...batch);
        if (!samplingArmed) return;
        const batchMetrics = metrics(batch);
        const latest = new Map(batchMetrics.map((metric) => [metric.name, metric.value]));
        if (
          latest.get("runtime.connections") === 1 &&
          latest.get("runtime.subscriptions") === 1 &&
          (latest.get("runtime.operations") ?? 0) >= PRODUCTION_LIMITS.revalidationConcurrency + 1 &&
          (latest.get("runtime.read_queue_items") ?? 0) >= 1 &&
          latest.get("runtime.checkpoint_completed") === 1 &&
          (latest.get("runtime.mutation_replay_records") ?? 0) >= 1
        ) {
          samplingArmed = false;
          sampled.resolve(Object.freeze([...batchMetrics]));
        }
      },
    };
    const sampleIntervalMs = 10;
    const app = harness({
      enabled: true,
      exporter,
      localSink: false,
      limits: {
        ...telemetryLimits,
        batchIntervalMs: 5,
        sampleIntervalMs,
      },
    });
    expect(app.runtime.limits.telemetry.sampleIntervalMs).toBe(
      PRODUCTION_LIMITS.telemetry.sampleIntervalMs,
    );
    expect(app.runtime.telemetry.sampleIntervalMs).toBe(sampleIntervalMs);

    const session = await app.openSession("telemetry-operator-sampler");
    await app.runtime.subscribe(session.context, request({
      v: PROTOCOL_VERSION,
      t: "sub",
      id: 830_000_001,
      ref: "items.list",
      args: { room: 83n },
    }));
    const issuedAt = Date.now();
    const mutationId = uuidV7(issuedAt, 83);
    await app.mutation(
      session.context,
      830_000_002,
      "items.add",
      { room: 83n, body: "operator-sample" },
      mutationId,
      issuedAt,
    );
    await app.mutation(
      session.context,
      830_000_003,
      "items.add",
      { room: 83n, body: "operator-sample" },
      mutationId,
      issuedAt,
    );
    app.engine.checkpoint();

    const droppedObservations = 37;
    app.runtime.deliveryObserver(Object.freeze({
      transport: "websocket",
      stage: "delivery",
      lane: "application",
      source: "send",
      bytes: 64,
      durationMs: 1,
      outcome: "ok",
      droppedObservations,
    }));

    const releaseReads = Promise.withResolvers<void>();
    const readsEntered = Promise.withResolvers<void>();
    operatorReadGate = releaseReads.promise;
    operatorReadEntered = () => readsEntered.resolve();
    operatorReadCount = 0;
    const heldReads = Array.from(
      { length: PRODUCTION_LIMITS.revalidationConcurrency + 1 },
      (_, index) => app.runtime.query(session.context, request({
        v: PROTOCOL_VERSION,
        t: "q",
        id: 830_000_100 + index,
        ref: "items.hold",
        args: {},
      })),
    );

    let sampledMetrics: readonly TelemetryMetricRecord[];
    let heldStatus: ReturnType<Runtime["status"]>;
    try {
      await readsEntered.promise;
      samplingArmed = true;
      sampledMetrics = await Promise.race([
        sampled.promise,
        Bun.sleep(1_000).then(() => {
          throw new Error("Runtime did not export an operator sample at the configured interval");
        }),
      ]);
      heldStatus = app.runtime.status();
    } finally {
      samplingArmed = false;
      operatorReadGate = null;
      operatorReadEntered = null;
      releaseReads.resolve();
      await Promise.allSettled(heldReads);
    }

    const latest = new Map<string, TelemetryMetricRecord>();
    for (const metric of sampledMetrics!) latest.set(metric.name, metric);
    expect(Object.keys(operatorMetricUnits)).toHaveLength(44);
    expect([...latest.keys()]).toEqual(expect.arrayContaining(Object.keys(operatorMetricUnits)));
    for (const [name, unit] of Object.entries(operatorMetricUnits)) {
      const metric = latest.get(name);
      expect(metric).toBeDefined();
      expect(metric!.unit).toBe(unit);
      expect(Number.isFinite(metric!.value)).toBe(true);
      expect(metric!.value).toBeGreaterThanOrEqual(0);
      expect(Object.values(metric!.labels).every((value) => value === undefined)).toBe(true);
    }

    const value = (name: keyof typeof operatorMetricUnits): number => latest.get(name)!.value;
    expect(value("runtime.connections")).toBe(heldStatus!.connections);
    expect(value("runtime.operations")).toBe(heldStatus!.activeOperations);
    expect(value("runtime.operation_callers")).toBe(heldStatus!.activeOperationCallers);
    expect(value("runtime.subscriptions")).toBe(
      heldStatus!.reactive.queryListeners + heldStatus!.reactive.eventListeners,
    );
    expect(value("runtime.subscription_entries")).toBe(heldStatus!.reactive.sharedEntries);
    expect(value("runtime.read_queue_items")).toBe(heldStatus!.reader.queue.queuedItems);
    expect(value("runtime.read_queue_bytes")).toBe(heldStatus!.reader.queue.queuedBytes);
    expect(value("runtime.write_queue_items")).toBe(heldStatus!.writer.queue.queuedItems);
    expect(value("runtime.write_queue_bytes")).toBe(heldStatus!.writer.queue.queuedBytes);
    expect(value("runtime.revalidation_active")).toBe(heldStatus!.reactive.revalidation.active);
    expect(value("runtime.revalidation_queue_items")).toBe(
      heldStatus!.reactive.revalidation.queue.queuedItems,
    );
    expect(value("runtime.revalidation_queue_bytes")).toBe(
      heldStatus!.reactive.revalidation.queue.queuedBytes,
    );
    expect(value("runtime.publication_items")).toBe(heldStatus!.publication.items);
    expect(value("runtime.publication_bytes")).toBe(heldStatus!.publication.bytes);
    expect(value("runtime.database_bytes")).toBe(heldStatus!.storage.databaseBytes);
    expect(value("runtime.wal_bytes")).toBe(heldStatus!.storage.walBytes);
    expect(value("runtime.checkpoint_completed")).toBe(1);
    expect(value("runtime.recovered_from_crash")).toBe(0);
    expect(value("runtime.mutation_replay_records")).toBe(heldStatus!.storage.mutationRecords);
    expect(value("runtime.mutation_replay_bytes")).toBe(heldStatus!.storage.mutationResultBytes);
    expect(value("runtime.mutation_replay_records")).toBeGreaterThanOrEqual(1);
    expect(value("runtime.mutation_replay_bytes")).toBeGreaterThan(0);
    expect(value("runtime.telemetry_export_attempts")).toBeGreaterThanOrEqual(1);
    expect(value("runtime.rss_bytes")).toBeGreaterThan(0);

    const droppedMetrics = metrics(exported).filter((metric) =>
      metric.name === "delivery.observations_dropped"
    );
    expect(droppedMetrics).toHaveLength(1);
    const droppedMetric = droppedMetrics[0];
    expect(droppedMetric).toEqual(expect.objectContaining({
      name: "delivery.observations_dropped",
      value: droppedObservations,
      unit: "count",
      labels: expect.objectContaining({ operation: "subscription", resource: "outbound" }),
    }));
  });

  test("exporter throws and stalls fail open for application work", async () => {
    let mode: "throw" | "stall" | "capture" = "throw";
    const captured: TelemetryRecord[] = [];
    const exporter: TelemetryExporter = {
      export(batch) {
        if (mode === "throw") throw new Error("export failed");
        if (mode === "stall") return new Promise<void>(() => {});
        captured.push(...batch);
      },
    };
    const app = harness({
      enabled: true,
      exporter,
      localSink: false,
      limits: telemetryLimits,
    });
    const session = await app.openSession("telemetry-exporter-fail-open");

    await expect(app.runtime.telemetry.flush()).resolves.toBeUndefined();
    expect(app.runtime.telemetry.snapshot().exporter.failures).toBeGreaterThanOrEqual(1);

    mode = "stall";
    const stalledFlush = app.runtime.telemetry.flush();
    const mutation = await app.mutation(session.context, 910_000_001, "items.add", {
      room: 9n,
      body: "application-remains-correct",
    });
    expect(mutation.receipt.replay).toBe("executed");
    await expect(stalledFlush).resolves.toBeUndefined();
    const degraded = app.runtime.telemetry.snapshot();
    expect(degraded.exporter.failures).toBeGreaterThanOrEqual(2);
    expect(degraded.exporter.timeouts).toBeGreaterThanOrEqual(1);
    expect(degraded.queuedRecords).toBeLessThanOrEqual(telemetryLimits.maxRecords);
    expect(degraded.queuedBytes).toBeLessThanOrEqual(telemetryLimits.maxBytes);
    expect(await app.runtime.query(session.context, request({
      v: PROTOCOL_VERSION,
      t: "q",
      id: 910_000_002,
      ref: "items.list",
      args: { room: 9n },
    }))).toMatchObject([{ body: "application-remains-correct" }]);

    mode = "capture";
    await app.runtime.telemetry.flush();
    expect(captured.length).toBeGreaterThan(0);
  });

  test("disabled telemetry produces no exported records", async () => {
    const exported: TelemetryRecord[] = [];
    const app = harness({
      enabled: false,
      exporter: {
        export(batch) {
          exported.push(...batch);
        },
      },
      localSink: false,
    });
    const session = await app.openSession("telemetry-disabled");
    expect(await app.runtime.query(session.context, request({
      v: PROTOCOL_VERSION,
      t: "q",
      id: 920_000_001,
      ref: "items.list",
      args: { room: 1n },
    }))).toEqual([]);
    await app.runtime.telemetry.flush();
    expect(exported).toEqual([]);
    expect(app.runtime.telemetry.snapshot()).toMatchObject({
      enabled: false,
      queuedRecords: 0,
      exporter: { configured: false, attempts: 0 },
    });
  });
});

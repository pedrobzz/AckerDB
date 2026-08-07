import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { declareJobs, job } from "../../src/jobs/definition.ts";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  Err,
  PROTOCOL_VERSION,
  Status,
  encode,
  parseSseMessage,
  type MutationMessage,
} from "@ackerdb/core";
import {
  ANONYMOUS_PRINCIPAL,
  DEFAULT_TELEMETRY_RETENTION,
  Engine,
  PRODUCTION_LIMITS,
  Registry,
  Runtime,
  Telemetry,
  TelemetryJournal,
  TelemetryStore,
  v,
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
  type TelemetryAggregateSnapshot,
  type TelemetryEventRecord,
  type TelemetryExporter,
  type TelemetryMetricRecord,
  type TelemetryRecord,
  type TelemetryScheduler,
  type TelemetrySpanRecord,
  type Identity,
  type Principal,
} from "@ackerdb/server";
import { callerFairnessKey } from "../../src/runtime/caller.ts";

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
    id: v.primaryKey(),
    room: v.bigint(),
    body: v.string(),
  }).index(["room"]),
  signals: defineEventTable({
    id: v.primaryKey(),
    room: v.bigint(),
  }, {
    args: { room: v.bigint() },
    access: "public",
    matches: (row, args) => row.room === args.room,
  }),
  audit: defineTable({
    id: v.primaryKey(),
    line: v.string(),
  }),
});

// This test owns the Runtime boundary, not generated application types.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Ctx = any;

let operatorReadGate: Promise<void> | null = null;
let operatorReadEntered: (() => void) | null = null;
let operatorReadCount = 0;
let operatorSseGate: Promise<void> | null = null;
let operatorSseEntered: (() => void) | null = null;
let operatorWriteGate: Promise<void> | null = null;
let operatorWriteEntered: (() => void) | null = null;

const addItem = mutation({
  access: "public",
  args: { room: v.bigint(), body: v.string() },
  handler: async (ctx: Ctx, args: Ctx) => {
    const id = await ctx.db.items.insert(args);
    await ctx.db.signals.insert({ room: args.room });
    return id;
  },
});

const rejectedAnalytics = mutation({
  access: "public",
  args: {},
  errors: {
    rejected: { body: v.object({}), status: Status.BadRequest },
  },
  handler: (ctx: Ctx) => {
    ctx.analytics.track("child rejected");
    return Err("rejected", {}, Status.BadRequest);
  },
});

const policyRejectedAnalytics = mutation({
  access: (ctx: Ctx) => {
    ctx.analytics.track("child policy rejected");
    return true;
  },
  args: {},
  errors: {
    rejected: { body: v.object({}), status: Status.BadRequest },
  },
  handler: () => Err("rejected", {}, Status.BadRequest),
});

const committedAnalytics = mutation({
  access: "public",
  args: {},
  handler: (ctx: Ctx) => {
    ctx.analytics.track("child committed", { child: true });
  },
});

const identityAnalytics = mutation({
  access: "public",
  args: {},
  handler: (ctx: Ctx) => ctx.analytics.track("identity tracked"),
});

let jobsClock: number | null = null;

const declaredJobs = () => declareJobs({
  jobs: {
    run: job({
      kind: "mutation",
      args: { label: v.string() },
      handler: (tx: Ctx, args: Ctx) => {
        tx.analytics.track("scheduled job ran", { label: args.label });
        return tx.db.audit.insert({ line: `scheduled:${args.label}` });
      },
    }),
  },
});

const functions = {
  items: {
    list: query({
      access: "public",
      args: { room: v.bigint() },
      handler: (ctx: Ctx, args: Ctx) =>
        ctx.db.items.query().where((row: Ctx) => row.room.eq(args.room)).collect(),
    }),
    loggedList: query({
      access: "public",
      args: { room: v.bigint() },
      handler: (ctx: Ctx, args: Ctx) => {
        ctx.log.debug("listed room", { room: args.room });
        return ctx.db.items.query().where((row: Ctx) => row.room.eq(args.room)).collect();
      },
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
    holdAdd: mutation({
      access: "public",
      args: { room: v.bigint(), body: v.string() },
      handler: async (ctx: Ctx, args: Ctx) => {
        const id = await ctx.db.items.insert(args);
        operatorWriteEntered?.();
        if (operatorWriteGate !== null) await operatorWriteGate;
        return id;
      },
    }),
    add: addItem,
    touch: mutation({
      access: "public",
      args: { id: v.bigint() },
      handler: async (ctx: Ctx, args: Ctx) => {
        const row = await ctx.db.items.get(args.id);
        await ctx.db.items.patch(args.id, { body: row.body });
      },
    }),
    fail: mutation({
      access: "public",
      args: { room: v.bigint(), body: v.string() },
      handler: async (ctx: Ctx, args: Ctx) => {
        ctx.log.error("item insertion failed", { room: args.room });
        ctx.analytics.track("failed mutation");
        await ctx.db.items.insert(args);
        throw new Error(`${PRIVATE_FAILURE}:${args.body}`);
      },
    }),
    logSequence: query({
      access: "public",
      args: {},
      handler: (ctx: Ctx) => {
        for (let index = 0; index < 10; index++) {
          ctx.log.info(`step-${index}`, { index });
        }
        return "logged";
      },
    }),
    unsafeLog: query({
      access: "public",
      args: {},
      handler: (ctx: Ctx) => {
        const cyclic: Record<string, unknown> = {};
        cyclic.self = cyclic;
        const throwing = Object.defineProperty({}, "value", {
          enumerable: true,
          get: () => {
            throw new Error("getter must not escape logging");
          },
        });
        ctx.log.warn("x".repeat(20_000), {
          cyclic,
          date: new Date(0) as never,
          throwing,
          values: Array.from({ length: 1_000 }, () => "y".repeat(1_000)),
        });
        return "safe";
      },
    }),
    policyLog: query({
      args: {},
      access: (ctx: Ctx) => {
        ctx.log.debug("policy checked");
        return true;
      },
      handler: () => "authorized",
    }),
    track: mutation({
      access: "public",
      args: {},
      handler: async (ctx: Ctx) => {
        ctx.analytics.track("parent before", { order: 1 });
        await committedAnalytics(ctx, {});
        const rejected = await rejectedAnalytics(ctx, {});
        expect(rejected.ok).toBe(false);
        const policyRejected = await policyRejectedAnalytics(ctx, {});
        expect(policyRejected.ok).toBe(false);
        ctx.analytics.track("parent after", { order: 3 });
        return true;
      },
    }),
    identityTrack: identityAnalytics,
    rejectTrack: rejectedAnalytics,
  },
  audit: {
    list: query({
      access: "public",
      args: {},
      handler: (ctx: Ctx) => ctx.db.audit.query().collect(),
    }),
  },
  jobs: {
    schedule: mutation({
      access: "public",
      args: { label: v.string(), at: v.float() },
      handler: (ctx: Ctx, args: Ctx) =>
        ctx.jobs.jobs.run.enqueue({ label: args.label }, { at: args.at }),
    }),
  },
  ops: {
    pipeline: procedure({
      access: "public",
      http: true,
      args: { room: v.bigint(), payload: v.string() },
      handler: async (ctx: Ctx, args: Ctx) => {
        ctx.log.info("procedure started");
        const external = await (await fetch(
          `data:text/plain,${encodeURIComponent(args.payload)}`,
        )).text();
        return ctx.tx(async (tx: Ctx) => {
          tx.log.info("transaction started");
          const id = (await addItem(tx, {
            room: args.room,
            body: external,
          })).data;
          const row = await tx.db.items.get(id);
          return { id, body: row.body };
        });
      },
    }),
    stream: sseProcedure({
      access: "public",
      http: true,
      args: { payload: v.string() },
      yields: v.object({ payload: v.string() }),
      handler: async function* (ctx: Ctx, args: Ctx) {
        ctx.log.info("stream started");
        if (operatorSseGate !== null) {
          operatorSseEntered?.();
          await operatorSseGate;
        }
        yield { payload: args.payload };
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
  readonly directory = mkdtempSync(join(tmpdir(), "ackerdb-telemetry-runtime-"));
  readonly engine = new Engine(schema, join(this.directory, "data.db"));
  readonly runtime: Runtime;
  private readonly sessions: TestSession[] = [];
  private closed = false;

  constructor(
    telemetry: RuntimeOptions["telemetry"],
    options: Pick<RuntimeOptions, "now" | "telemetryExporters" | "telemetryStore"> = {},
  ) {
    reconcile(this.engine);
    this.runtime = new Runtime({
      engine: this.engine,
      registry: new Registry(functions),
      telemetry,
      jobs: declaredJobs(),
      now: () => jobsClock ?? Date.now(),
      ...options,
    });
  }

  async openSession(
    clientSessionId: string,
    publish?: (frame: RuntimePublication) => Promise<boolean> | boolean,
    principal: Principal = ANONYMOUS_PRINCIPAL,
  ): Promise<TestSession> {
    const controller = new AbortController();
    const publications: SessionApplicationMessage[] = [];
    const context: SessionRuntimeContext = Object.freeze({
      clientSessionId,
      principal,
      fairnessKey: callerFairnessKey(principal, TEST_SOURCE),
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

/** The lifecycle states of every durable framework lifecycle row, in id order. */
function lifecycleStates(
  entries: ReturnType<RuntimeHarness["runtime"]["telemetryJournal"]["readBatch"]>,
): readonly string[] {
  return entries
    .filter((entry) => entry.kind === "log" &&
      entry.source === "framework" &&
      entry.message === "lifecycle")
    .map((entry) => String(
      (entry as { metadata?: { lifecycleState?: unknown } }).metadata?.lifecycleState,
    ));
}

function harness(
  telemetry: RuntimeOptions["telemetry"],
  options?: Pick<RuntimeOptions, "now" | "telemetryExporters" | "telemetryStore">,
): RuntimeHarness {
  const created = new RuntimeHarness(telemetry, options);
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
  operatorWriteGate = null;
  operatorWriteEntered = null;
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
      const frame = parseSseMessage(JSON.parse(payload));
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
  "runtime.checkpoint_busy": "gauge",
  "runtime.checkpoint_total_frames": "gauge",
  "runtime.checkpoint_checkpointed_frames": "gauge",
  "runtime.checkpoint_residual_frames": "gauge",
  "runtime.checkpoint_duration": "milliseconds",
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
  test("persists ordered call-time application logs outside application transactions", async () => {
    const timestamp = Date.now();
    const app = harness(false, { now: () => timestamp });
    const session = await app.openSession("application-log-order");

    expect(await app.runtime.query(session.context, request({
      v: PROTOCOL_VERSION,
      t: "q",
      id: 720_000_001,
      ref: "items.logSequence",
      args: {},
    }))).toBe("logged");

    await expect(app.mutation(
      session.context,
      720_000_002,
      "items.fail",
      { room: 9n, body: "rollback" },
    )).rejects.toThrow(PRIVATE_FAILURE);
    await app.runtime.telemetryJournal.flush();
    const records = (await app.runtime.telemetryJournal.readBatch(0n, 32))
      .filter((record) => record.kind === "log");

    expect(records.map((record) => record.message)).toEqual([
      "step-0",
      "step-1",
      "step-2",
      "step-3",
      "step-4",
      "step-5",
      "step-6",
      "step-7",
      "step-8",
      "step-9",
      "item insertion failed",
    ]);
    expect(records.map((record) => record.sequence)).toEqual(
      records.map((_, index) => BigInt(index + 1)),
    );
    expect(records.every((record) => record.timestamp === timestamp)).toBe(true);
    expect(records[0]).toMatchObject({
      kind: "log",
      level: "info",
      metadata: { index: 0 },
      functionAddress: "items.logSequence",
      functionKind: "query",
      requestId: "720000001",
    });
    expect(records[10]).toMatchObject({
      kind: "log",
      level: "error",
      metadata: { room: 9n },
      functionAddress: "items.fail",
      functionKind: "mutation",
      requestId: "720000002",
    });
    expect(records.every((record) => record.traceId !== undefined)).toBe(true);
    expect(records.every((record) => record.spanId !== undefined)).toBe(true);
  });

  test("assigns one total sequence across concurrent log registrations", async () => {
    const app = harness(false);
    const session = await app.openSession("application-log-concurrent-order");

    await Promise.all(Array.from({ length: 4 }, (_, index) => app.runtime.query(
      session.context,
      request({
        v: PROTOCOL_VERSION,
        t: "q",
        id: 720_000_030 + index,
        ref: "items.logSequence",
        args: {},
      }),
    )));
    await app.runtime.telemetryJournal.flush();

    const records = (await app.runtime.telemetryJournal.readBatch(0n, 64))
      .filter((record) => record.kind === "log");
    expect(records).toHaveLength(40);
    expect(records.map((record) => record.sequence)).toEqual(
      records.map((_, index) => BigInt(index + 1)),
    );
  });

  test("logs once for each shared reactive query execution", async () => {
    const app = harness(false);
    const first = await app.openSession("application-log-shared-query-first");
    const second = await app.openSession("application-log-shared-query-second");
    const subscription = {
      v: PROTOCOL_VERSION,
      t: "sub",
      id: 720_000_011,
      ref: "items.loggedList",
      args: { room: 11n },
    } as const;

    await app.runtime.subscribe(first.context, request(subscription));
    await app.runtime.subscribe(second.context, request(subscription));
    const added = await app.mutation(
      first.context,
      720_000_012,
      "items.add",
      { room: 11n, body: "invalidate" },
    );
    await app.mutation(
      first.context,
      720_000_013,
      "items.touch",
      { id: added.value as bigint },
    );

    await app.runtime.telemetryJournal.flush();
    const logs = (await app.runtime.telemetryJournal.readBatch(0n, 32))
      .filter((record) => record.kind === "log" && record.message === "listed room");
    expect(logs).toHaveLength(3);
    expect(logs.map((record) => record.functionAddress)).toEqual([
      "items.loggedList",
      "items.loggedList",
      "items.loggedList",
    ]);
  });

  test("bounds and marks malformed application log values without throwing", async () => {
    const app = harness(false);
    const session = await app.openSession("application-log-malformed");

    expect(await app.runtime.query(session.context, request({
      v: PROTOCOL_VERSION,
      t: "q",
      id: 720_000_015,
      ref: "items.unsafeLog",
      args: {},
    }))).toBe("safe");
    await app.runtime.telemetryJournal.flush();
    const record = (await app.runtime.telemetryJournal.readBatch(0n, 4))[0];
    expect(record?.kind).toBe("log");
    if (record?.kind !== "log") throw new Error("expected application log");
    expect(record.truncated).toBe(true);
    expect(record.malformed).toBe(true);
    expect(record.message).toContain("[Truncated]");
    expect(record.metadata).toMatchObject({
      cyclic: { self: "[Truncated]" },
      date: "[Unsupported telemetry value]",
      throwing: { value: "[Unsupported telemetry value]" },
    });
    expect(app.runtime.telemetryJournal.snapshot()).toMatchObject({
      truncatedRecords: 1,
      malformedRecords: 1,
      oversizedRecords: 0,
    });
  });

  test("homes telemetry retention in start options and reports it read-only in status", async () => {
    const dayMs = 86_400_000;
    const app = harness(false, {
      telemetryStore: { retention: { debug: dayMs }, maxExpiredRowsPerPass: 64 },
    });

    expect(app.runtime.telemetryStore.path).toBe(`${app.engine.path}.telemetry`);
    expect(app.runtime.telemetryJournal.store).toBe(app.runtime.telemetryStore);
    expect(app.runtime.status().telemetryStore).toEqual({
      retention: { ...DEFAULT_TELEMETRY_RETENTION, debug: dayMs },
      expiredRecords: {
        debug: 0,
        info: 0,
        warn: 0,
        error: 0,
        spans: 0,
        analytics: 0,
        rollups: 0,
      },
    });
  });

  test("makes local journal failure unhealthy without escaping through ctx.log", async () => {
    const app = harness(false);
    const duplicate = Object.freeze({
      kind: "log" as const,
      processGeneration: "forced-journal-failure",
      sequence: 1n,
      timestamp: Date.now(),
      level: "error" as const,
      source: "app" as const,
      message: "duplicate",
      truncated: false,
      malformed: false,
      functionAddress: "tests.failure",
      functionKind: "query",
    });

    expect(app.runtime.telemetryJournal.append(duplicate)).toBe(true);
    expect(app.runtime.telemetryJournal.append(duplicate)).toBe(true);
    await expect(app.runtime.telemetryJournal.flush()).rejects.toBeDefined();

    expect(app.runtime.state).not.toBe("ready");
    expect(app.runtime.telemetryJournal.snapshot()).toMatchObject({ state: "failed" });
  });

  test("journals framework failure events durably with source framework", async () => {
    const app = harness({
      enabled: true,
      localSink: false,
      limits: telemetryLimits,
    });
    const session = await app.openSession("framework-event-durability");

    await expect(app.mutation(
      session.context,
      725_000_001,
      "items.fail",
      { room: 1n, body: "x" },
    )).rejects.toThrow(PRIVATE_FAILURE);
    await app.runtime.telemetryJournal.flush();

    const frameworkRecords = (await app.runtime.telemetryJournal.readBatch(0n, 64))
      .flatMap((record) => record.kind === "log" && record.source === "framework"
        ? [record]
        : []);
    const failure = frameworkRecords.find((record) => record.message === "failure");
    expect(failure).toMatchObject({
      level: "error",
      source: "framework",
      functionKind: "framework",
    });
    expect(failure?.metadata).toMatchObject({ operation: "mutation" });
    expect(encode(failure)).not.toContain(PRIVATE_FAILURE);

    await app.runtime.telemetrySpans.flush();
    const spanRows = app.runtime.telemetryStore.database.query(`
      SELECT trace_id AS traceId, outcome
      FROM _ackerdb_telemetry_spans
      WHERE function_address = 'items.fail'
      ORDER BY id
    `).all() as { readonly traceId: string; readonly outcome: string }[];
    expect(spanRows.length).toBeGreaterThan(0);
    expect(spanRows.some((row) => row.outcome !== "ok")).toBe(true);
    const summary = app.runtime.telemetryStore.database.query(`
      SELECT root_function AS rootFunction, span_count AS spanCount, error_count AS errorCount
      FROM _ackerdb_telemetry_traces
      WHERE trace_id = ?
    `).get(spanRows[0]!.traceId) as {
      readonly rootFunction: string;
      readonly spanCount: bigint;
      readonly errorCount: bigint;
    };
    expect(summary.rootFunction).toBe("items.fail");
    expect(summary.spanCount).toBeGreaterThan(0n);
    expect(summary.errorCount).toBeGreaterThan(0n);
  });

  test("groups unhandled failures at the operation runner funnel", async () => {
    const app = harness({
      enabled: true,
      localSink: false,
      limits: telemetryLimits,
    });
    const session = await app.openSession("error-grouping");

    // A validation failure is an expected outcome — it never joins a group.
    await expect(app.mutation(
      session.context,
      726_000_001,
      "items.fail",
      { room: "not-a-bigint", body: 42 },
    )).rejects.toBeDefined();
    expect(app.runtime.telemetryErrors.snapshot().ingestedErrors).toBe(0);

    await expect(app.mutation(
      session.context,
      726_000_002,
      "items.fail",
      { room: 1n, body: "first" },
    )).rejects.toThrow(PRIVATE_FAILURE);
    await expect(app.mutation(
      session.context,
      726_000_003,
      "items.fail",
      { room: 2n, body: "second" },
    )).rejects.toThrow(PRIVATE_FAILURE);

    expect(app.runtime.telemetryErrors.snapshot()).toMatchObject({
      ingestedErrors: 2,
      droppedErrors: 0,
    });
    const groups = app.runtime.telemetryStore.database.query(`
      SELECT name, message, times_seen AS timesSeen, status, sample_trace_id AS sampleTraceId
      FROM _ackerdb_telemetry_error_groups
    `).all() as {
      readonly name: string;
      readonly message: string;
      readonly timesSeen: bigint;
      readonly status: string;
      readonly sampleTraceId: string | null;
    }[];
    // One group despite two distinct messages: in-app frames define the key.
    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({ name: "Error", timesSeen: 2n, status: "unresolved" });
    expect(groups[0]!.sampleTraceId).not.toBeNull();
    const occurrences = app.runtime.telemetryStore.database.query(`
      SELECT function_address AS functionAddress, trace_id AS traceId
      FROM _ackerdb_telemetry_error_occurrences
      ORDER BY id
    `).all() as { readonly functionAddress: string; readonly traceId: string | null }[];
    expect(occurrences).toHaveLength(2);
    expect(occurrences.every((row) => row.functionAddress === "items.fail")).toBe(true);
    expect(occurrences.every((row) => row.traceId !== null)).toBe(true);
  });

  test("attributes policy, procedure, transaction, SSE, and system logs", async () => {
    const app = harness(false);
    const session = await app.openSession("application-log-contexts");

    expect(await app.runtime.query(session.context, request({
      v: PROTOCOL_VERSION,
      t: "q",
      id: 720_000_016,
      ref: "items.policyLog",
      args: {},
    }))).toBe("authorized");
    const response = await app.runtime.runProcedure({
      id: 720_000_017,
      address: "ops.pipeline",
      args: { room: 13n, payload: "contexts" },
      principal: ANONYMOUS_PRINCIPAL,
      respond: ({ body, status }) => new Response(body, { status }),
    });
    expect(response.status).toBe(200);
    const stream = await app.runtime.runSse({
      id: 720_000_018,
      address: "ops.stream",
      args: { payload: "contexts" },
      principal: ANONYMOUS_PRINCIPAL,
    });
    await collectSse(app.runtime, stream);
    await app.runtime.system.run("coverage.system", (ctx) => {
      ctx.log.warn("system ran");
    });

    await app.runtime.telemetryJournal.flush();
    const records = (await app.runtime.telemetryJournal.readBatch(0n, 16))
      .filter((record) => record.kind === "log");
    expect(records.map((record) => [
      record.message,
      record.functionAddress,
      record.functionKind,
    ])).toEqual([
      ["policy checked", "items.policyLog", "query"],
      ["procedure started", "ops.pipeline", "procedure"],
      ["transaction started", "ops.pipeline", "procedure"],
      ["stream started", "ops.stream", "sse"],
      ["system ran", "coverage.system", "system"],
    ]);
  });

  test("publishes analytics only after commit with durable identity", async () => {
    const app = harness(false);
    const principal = Object.freeze({
      kind: "user",
      scopes: Object.freeze([]),
      identity: 42n as Identity,
      issuer: "https://identity.test",
      subject: "private-subject",
      claims: Object.freeze({ role: "private-claim" }),
      expiresAt: Date.now() + 60_000,
      tokenId: "private-token",
    }) satisfies Principal;
    const session = await app.openSession("analytics-commit", undefined, principal);
    const issuedAt = Date.now();
    const mutationRequestId = uuidV7(issuedAt, 721);

    await app.mutation(
      session.context,
      720_000_021,
      "items.track",
      {},
      mutationRequestId,
      issuedAt,
    );
    await app.mutation(
      session.context,
      720_000_022,
      "items.track",
      {},
      mutationRequestId,
      issuedAt,
    );
    await expect(app.mutation(
      session.context,
      720_000_023,
      "items.fail",
      { room: 12n, body: "analytics rollback" },
    )).rejects.toThrow(PRIVATE_FAILURE);
    const rejected = await app.mutation(
      session.context,
      720_000_024,
      "items.rejectTrack",
      {},
    );
    expect(rejected.value).toMatchObject({ ok: false });

    await app.runtime.telemetryJournal.flush();
    const events = (await app.runtime.telemetryJournal.readBatch(0n, 32))
      .filter((record) => record.kind === "analytics");
    expect(events.map((event) => event.event)).toEqual([
      "parent before",
      "child committed",
      "parent after",
    ]);
    expect(events.map((event) => event.identity)).toEqual([
      principal.identity,
      principal.identity,
      principal.identity,
    ]);
    expect(events.map((event) => event.properties)).toEqual([
      { order: 1 },
      { child: true },
      { order: 3 },
    ]);
    expect(events.every((event) => event.commitId !== undefined)).toBe(true);
    const serialized = JSON.stringify(
      events,
      (_key, value) => typeof value === "bigint" ? value.toString() : value,
    );
    expect(serialized).not.toContain("private-subject");
    expect(serialized).not.toContain("private-claim");
    expect(serialized).not.toContain("private-token");
  });

  test("keeps anonymous, workload, and system analytics identity-less", async () => {
    const app = harness(false);
    const workload = Object.freeze({
      kind: "workload",
      issuer: "https://workload.test",
      subject: "private-workload-subject",
      claims: Object.freeze({ service: "private-workload-claim" }),
      expiresAt: Date.now() + 60_000,
      tokenId: "private-workload-token",
    }) satisfies Principal;
    const anonymousSession = await app.openSession("analytics-anonymous");
    const workloadSession = await app.openSession("analytics-workload", undefined, workload);

    await app.mutation(anonymousSession.context, 720_000_026, "items.identityTrack", {});
    await app.mutation(workloadSession.context, 720_000_027, "items.identityTrack", {});
    await app.runtime.system.run("analytics.system", (ctx) => ctx.tx((tx) => {
      tx.analytics.track("identity tracked");
    }));

    await app.runtime.telemetryJournal.flush();
    const events = (await app.runtime.telemetryJournal.readBatch(0n, 16))
      .filter((record) => record.kind === "analytics");
    expect(events.map((event) => event.identity)).toEqual([
      undefined,
      undefined,
      undefined,
    ]);
    expect(events.map((event) => event.functionAddress)).toEqual([
      "items.identityTrack",
      "items.identityTrack",
      "analytics.system",
    ]);
    const serialized = JSON.stringify(events, (_key, value) =>
      typeof value === "bigint" ? value.toString() : value);
    expect(serialized).not.toContain("private-workload-subject");
    expect(serialized).not.toContain("private-workload-claim");
    expect(serialized).not.toContain("private-workload-token");
  });

  test("publishes scheduled mutation analytics after commit", async () => {
    const app = harness(false);
    const session = await app.openSession("analytics-scheduled");
    const dueAt = Date.now() + 60_000;

    await app.mutation(session.context, 720_000_028, "jobs.schedule", {
      label: "analytics",
      at: dueAt,
    });
    jobsClock = dueAt;
    await app.runtime.runJobs();
    jobsClock = null;

    await app.runtime.telemetryJournal.flush();
    const events = (await app.runtime.telemetryJournal.readBatch(0n, 16))
      .filter((record) => record.kind === "analytics");
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      event: "scheduled job ran",
      functionAddress: "jobs.run",
      functionKind: "job",
      properties: { label: "analytics" },
    });
    expect(events[0]?.identity).toBeUndefined();
    expect(events[0]?.commitId).toBeDefined();
  });

  test("exports application signals without coupling provider failure to work", async () => {
    const exported: string[] = [];
    const warnings: string[] = [];
    const app = harness(false, {
      telemetryExporters: {
        exporters: [
          {
            name: "failing-provider",
            signals: ["log"],
            export: () => {
              throw new Error("provider unavailable");
            },
          },
          {
            name: "healthy-provider",
            signals: ["log"],
            export: (records) => {
              exported.push(...records.map((record) =>
                record.kind === "log" ? record.message : "wrong"));
            },
          },
        ],
        warn: (message) => warnings.push(message),
        limits: { retryMinMs: 10_000, retryMaxMs: 10_000 },
      },
    });
    const session = await app.openSession("application-signal-export");

    expect(await app.runtime.query(session.context, request({
      v: PROTOCOL_VERSION,
      t: "q",
      id: 720_000_031,
      ref: "items.logSequence",
      args: {},
    }))).toBe("logged");
    await app.runtime.telemetryJournal.flush();
    await app.runtime.telemetryExporters!.flush();

    expect(exported).toEqual(Array.from({ length: 10 }, (_, index) => `step-${index}`));
    expect(warnings.length).toBeGreaterThanOrEqual(1);
    expect(warnings.length).toBeLessThanOrEqual(2);
    expect(app.runtime.state).toBe("ready");
    expect(app.runtime.status().telemetryExporters).toMatchObject({
      "failing-provider": { failures: warnings.length },
      "healthy-provider": { exportedRecords: 10 },
    });
  });

  test("restores each queued writer's trace, invocation, and statement owner", async () => {
    const exported: TelemetryRecord[] = [];
    const app = harness({
      enabled: true,
      exporter: { export: (batch) => void exported.push(...batch) },
      localSink: false,
      limits: telemetryLimits,
    });
    const session = await app.openSession("telemetry-queued-writer-owner");
    const release = Promise.withResolvers<void>();
    const entered = Promise.withResolvers<void>();
    operatorWriteGate = release.promise;
    operatorWriteEntered = () => entered.resolve();
    const issuedAt = Date.now();
    const held = app.mutation(
      session.context,
      700_000_001,
      "items.holdAdd",
      { room: 7n, body: "held" },
      uuidV7(issuedAt, 701),
      issuedAt,
    );
    await entered.promise;
    const procedure = app.runtime.runProcedure({
      id: 700_000_002,
      address: "ops.pipeline",
      args: { room: 7n, payload: "queued" },
      principal: ANONYMOUS_PRINCIPAL,
      respond: ({ body, status }) => new Response(body, { status }),
    });
    try {
      for (let attempts = 0; app.runtime.status().writer.queue.queuedItems === 0; attempts++) {
        if (attempts === 100) throw new Error("procedure transaction did not enter the writer queue");
        await Bun.sleep(0);
      }
    } finally {
      operatorWriteGate = null;
      operatorWriteEntered = null;
      release.resolve();
    }
    await held;
    expect((await procedure).status).toBe(200);
    await app.runtime.telemetry.flush();

    const retained = spans(exported);
    const heldAdmission = requiredSpan(retained, (span) =>
      span.operation === "mutation" &&
      span.stage === "admission" &&
      span.requestId === "700000001"
    );
    const procedureAdmission = requiredSpan(retained, (span) =>
      span.operation === "procedure" &&
      span.stage === "admission" &&
      span.requestId === "700000002"
    );
    const heldExecution = requiredSpan(retained, (span) =>
      span.operation === "mutation" &&
      span.stage === "execution" &&
      span.function === "items.holdAdd"
    );
    const transactionExecution = requiredSpan(retained, (span) =>
      span.operation === "transaction" &&
      span.stage === "execution" &&
      span.function === "ops.pipeline"
    );
    const nestedHandler = requiredSpan(retained, (span) =>
      span.stage === "handler" &&
      span.function === "items.add" &&
      span.requestId === "700000002"
    );
    const nestedStatement = requiredSpan(retained, (span) =>
      span.stage === "statement" &&
      span.function === "items.add" &&
      span.requestId === "700000002"
    );
    expect(heldExecution.traceId).toBe(heldAdmission.traceId);
    expect(transactionExecution.traceId).toBe(procedureAdmission.traceId);
    expect(nestedHandler.traceId).toBe(procedureAdmission.traceId);
    expect(nestedStatement.traceId).toBe(procedureAdmission.traceId);
    expect(transactionExecution.traceId).not.toBe(heldExecution.traceId);
    expectRetainedParentage(retained, heldAdmission);
    expectRetainedParentage(retained, procedureAdmission);
  });

  test("closes whole-operation tail decisions after final response work", async () => {
    const exported: TelemetryRecord[] = [];
    const exportedAggregates: TelemetryAggregateSnapshot[] = [];
    const app = harness({
      enabled: true,
      exporter: {
        export(batch, aggregates) {
          exported.push(...batch);
          if (aggregates !== undefined) exportedAggregates.push(aggregates);
        },
      },
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
    expect(exportedAggregates).toEqual([app.runtime.status().telemetryAggregates]);
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
    // The lifecycle settles a few microtasks after the terminal credit closes
    // the body stream.
    for (let turn = 0; app.runtime.telemetry.snapshot().traceRetention.activeTraces !== 0; turn++) {
      if (turn === 100) break;
      await Bun.sleep(0);
    }
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
    expect(JSON.parse(await procedureResponse.text())).toMatchObject({ body: PRIVATE_FETCH });

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
    jobsClock = dueAt;
    await app.runtime.runJobs();
    jobsClock = null;

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
      "execution",
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
    // The job runner's work rides the ordinary transaction lane; its own
    // signals are the job_* transition events and gauges.
    expect(aggregateOperations).toEqual(expect.arrayContaining([
      "query",
      "mutation",
      "procedure",
      "sse",
      "transaction",
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
    // Cardinality leaks can exist only in string-valued metric dimensions.
    // Searching the full JSON also searches numeric measurements, where a
    // duration such as 0.710000001 creates a false match for request 710000001.
    const aggregateDimensions = JSON.stringify(aggregate.series.map((series) => ({
      operation: series.operation,
      stage: series.stage,
      outcome: series.outcome,
      function: series.function,
      resource: series.resource,
    })));
    for (const id of highCardinalityIds) {
      expect(aggregateDimensions).not.toContain(id);
    }

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
    const mutationExecution = requiredSpan(retainedSpans, (span) =>
      span.operation === "mutation" &&
      span.stage === "execution" &&
      span.mutationId === mutationId
    );
    expect(mutationExecution.traceId).toBe(mutationAdmission.traceId);
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
    const replaySkippedExecution = !retainedSpans.some((span) =>
      span.traceId === replayAdmission.traceId && span.stage === "execution"
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
    const procedureTransactionExecution = requiredSpan(retainedSpans, (span) =>
      span.operation === "transaction" &&
      span.stage === "execution" &&
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
    const sseTransactionExecution = requiredSpan(retainedSpans, (span) =>
      span.operation === "transaction" &&
      span.stage === "execution" &&
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
    // The enqueue writes one jobs row: its id key plus the jobs table's
    // index keys form the commit's exact dependency set.
    expect(unmatchedInvalidation).toMatchObject({ dependencyCount: 8 });
    expect(unmatchedInvalidation.function).toBeUndefined();

    // The job runner commits through the ordinary transaction path: the
    // claim+handler+settle transaction leaves one correlated trace that both
    // executed the handler's write and committed it.
    const jobStatement = requiredSpan(retainedSpans, (span) =>
      span.stage === "statement" && span.statement === "audit.insert"
    );
    const jobTrace = retainedSpans.filter((span) => span.traceId === jobStatement.traceId);
    expect(jobTrace.map((span) => span.stage)).toEqual(expect.arrayContaining([
      "statement",
      "execution",
      "storage",
      "commit",
    ]));
    const scheduledRootsCoherent = jobTrace.every((span) => span.traceId !== undefined);

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
    expect(requiredSpan(retainedSpans, (span) =>
      span.operation === "mutation" &&
      span.stage === "execution" &&
      span.mutationId === failedMutationId
    )).toMatchObject({ outcome: "internal" });

    expect({
      aggregateIncludesTransactions: aggregateOperations.includes("transaction"),
      replaySkippedHandler,
      replaySkippedExecution,
      initialSubscriptionRoutedAsSubscription: initialSubscriptionTrace.every((span) =>
        span.operation === "subscription"
      ),
      revalidationRoutedAsSubscription: mutationRevalidation.every((span) =>
        span.operation === "subscription"
      ),
      procedureTransactionParentedToHandler:
        procedureTransactionCommit?.parentSpanId === procedureHandler.spanId,
      procedureExecutionParentedToHandler:
        procedureTransactionExecution.parentSpanId === procedureHandler.spanId,
      sseTransactionParentedToHandler: sseTransactionCommit?.parentSpanId === sseHandler.spanId,
      sseExecutionParentedToHandler: sseTransactionExecution.parentSpanId === sseHandler.spanId,
      sseDeliveryParentedToHandler: sseDelivery?.parentSpanId === sseHandler.spanId,
      scheduledRootsCoherent,
    }).toEqual({
      aggregateIncludesTransactions: true,
      replaySkippedHandler: true,
      replaySkippedExecution: true,
      initialSubscriptionRoutedAsSubscription: true,
      revalidationRoutedAsSubscription: true,
      procedureTransactionParentedToHandler: true,
      procedureExecutionParentedToHandler: true,
      sseTransactionParentedToHandler: true,
      sseExecutionParentedToHandler: true,
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

  test("samples an explicit zero state before this process checkpoints", async () => {
    const checkpointMetrics = Object.keys(operatorMetricUnits).filter((name) =>
      name.startsWith("runtime.checkpoint_")
    );
    const sampled = Promise.withResolvers<ReadonlyMap<string, number>>();
    const app = harness({
      enabled: true,
      exporter: {
        export(batch) {
          const latest = new Map(metrics(batch).map((metric) => [metric.name, metric.value]));
          if (checkpointMetrics.every((name) => latest.has(name))) sampled.resolve(latest);
        },
      },
      localSink: false,
      limits: { ...telemetryLimits, batchIntervalMs: 5, sampleIntervalMs: 10 },
    });

    const latest = await Promise.race([
      sampled.promise,
      Bun.sleep(1_000).then(() => {
        throw new Error("Runtime did not export its initial checkpoint sample");
      }),
    ]);
    expect(app.runtime.status().storage.lastCheckpoint).toBeNull();
    expect(checkpointMetrics).toHaveLength(7);
    for (const name of checkpointMetrics) expect(latest.get(name)).toBe(0);
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
    expect(Object.keys(operatorMetricUnits)).toHaveLength(49);
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
    const checkpoint = heldStatus!.storage.lastCheckpoint;
    expect(checkpoint).not.toBeNull();
    expect(value("runtime.checkpoint_busy")).toBe(checkpoint!.busy);
    expect(value("runtime.checkpoint_total_frames")).toBe(
      checkpoint!.totalFrames,
    );
    expect(value("runtime.checkpoint_checkpointed_frames")).toBe(
      checkpoint!.checkpointedFrames,
    );
    expect(value("runtime.checkpoint_residual_frames")).toBe(
      checkpoint!.residualFrames,
    );
    expect(value("runtime.checkpoint_duration")).toBe(
      checkpoint!.durationMs,
    );
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

  test("coalesces delivery failure storms beyond the per-interval exemplar budget", async () => {
    const exported: TelemetryRecord[] = [];
    const app = harness({
      enabled: true,
      exporter: { export: (batch) => void exported.push(...batch) },
      localSink: false,
      limits: telemetryLimits,
    });

    // A mass-disconnect storm fails many queued frames in one turn. Only a
    // bounded exemplar set may be retained individually; the remainder must
    // be summarized instead of flooding the bounded export queue. Terminal
    // error frames that encode successfully report outcome "ok" while
    // carrying the actual failure in terminalOutcome and must coalesce too.
    for (let index = 0; index < 30; index++) {
      app.runtime.deliveryObserver(Object.freeze({
        transport: "websocket",
        stage: "delivery",
        lane: "application",
        source: "send",
        bytes: 64,
        durationMs: 1,
        outcome: "dropped",
      }));
    }
    for (let index = 0; index < 12; index++) {
      app.runtime.deliveryObserver(Object.freeze({
        transport: "websocket",
        stage: "encoding",
        lane: "control",
        source: "terminal",
        bytes: 64,
        durationMs: 1,
        outcome: "ok",
        terminalOutcome: "unavailable",
      }));
    }
    await app.runtime.drain();

    expect(spans(exported).filter((span) =>
      span.operation === "subscription" && span.stage === "delivery" && span.outcome === "unavailable"
    )).toHaveLength(8);
    // Summarized terminal observations emit no span either: this retain-all
    // configuration (slowOperationMs 0) would otherwise keep one ok-outcome
    // encoding span per summarized frame and reopen the storm.
    expect(spans(exported).filter((span) =>
      span.operation === "subscription" && span.stage === "encoding"
    )).toHaveLength(8);
    expect(events(exported).filter((event) =>
      event.name === "failure" && event.stage === "delivery" && event.outcome === "unavailable"
    )).toHaveLength(8);

    const summaries = metrics(exported).filter((metric) => metric.name === "delivery.failures_coalesced");
    expect(summaries).toHaveLength(2);
    for (const summary of summaries) {
      expect(summary.unit).toBe("count");
      expect(summary.labels.operation).toBe("subscription");
      expect(summary.labels.outcome).toBe("unavailable");
      expect(summary.labels.resource).toBe("outbound");
    }
    const byStage = new Map(summaries.map((summary) => [summary.labels.stage, summary.value]));
    expect(byStage.get("delivery")).toBe(22);
    expect(byStage.get("encoding")).toBe(4);
  });

  test("keeps coalesced failure counts observable on the default local-only profile", async () => {
    const localLines: string[] = [];
    const app = harness({
      enabled: true,
      localSink: (line) => {
        localLines.push(line);
      },
      limits: telemetryLimits,
    });

    for (let index = 0; index < 30; index++) {
      app.runtime.deliveryObserver(Object.freeze({
        transport: "websocket",
        stage: "delivery",
        lane: "application",
        source: "send",
        bytes: 64,
        durationMs: 1,
        outcome: "dropped",
      }));
    }
    await app.runtime.drain();

    // Without an exporter the console local sink is the only output, so the
    // summarized magnitude must be printed there instead of silently sitting
    // in the undeliverable retained queue.
    const summaries = localLines
      .map((line) => JSON.parse(line) as TelemetryRecord)
      .filter((record) => record.kind === "metric" && record.name === "delivery.failures_coalesced");
    expect(summaries).toHaveLength(1);
    expect((summaries[0] as TelemetryMetricRecord).value).toBe(22);
    expect((summaries[0] as TelemetryMetricRecord).labels.stage).toBe("delivery");
  });

  test("exporter throws and an indefinitely stalled export fail open for application work", async () => {
    const exporterTimeoutMs = 60_000;
    const operationDeadlineMs = 1_000;
    let pendingExporterTimeout: (() => void) | undefined;
    const scheduler: TelemetryScheduler = {
      setInterval: () => undefined,
      clearInterval: () => {},
      setTimeout(callback, delayMs) {
        if (delayMs !== exporterTimeoutMs) throw new Error(`Unexpected ${delayMs}ms timeout`);
        pendingExporterTimeout = callback;
        return callback;
      },
      clearTimeout(handle) {
        if (handle === pendingExporterTimeout) pendingExporterTimeout = undefined;
      },
    };
    let mode: "throw" | "stall" | "capture" = "throw";
    const captured: TelemetryRecord[] = [];
    const stalledExport = new Promise<void>(() => {});
    const exporter: TelemetryExporter = {
      export(batch) {
        if (mode === "throw") throw new Error("export failed");
        if (mode === "stall") return stalledExport;
        captured.push(...batch);
      },
    };
    const app = harness({
      enabled: true,
      exporter,
      localSink: false,
      scheduler,
      limits: { ...telemetryLimits, exportTimeoutMs: exporterTimeoutMs },
    });
    const session = await app.openSession("telemetry-exporter-fail-open");

    await expect(app.runtime.telemetry.flush()).resolves.toBeUndefined();
    expect(app.runtime.telemetry.snapshot().exporter.failures).toBeGreaterThanOrEqual(1);

    await app.runtime.subscribe(session.context, request({
      v: PROTOCOL_VERSION,
      t: "sub",
      id: QUERY_SUBSCRIPTION_ID,
      ref: "items.list",
      args: { room: 9n },
    }));
    mode = "stall";
    const stalledFlush = app.runtime.telemetry.flush();
    const exporterTimeout = pendingExporterTimeout;
    expect(exporterTimeout).toBeDefined();

    try {
      const { mutation, rows } = await Promise.race([
        (async () => {
          const mutation = await app.mutation(session.context, 910_000_001, "items.add", {
            room: 9n,
            body: "application-remains-correct",
          });
          const rows = await app.runtime.query(session.context, request({
            v: PROTOCOL_VERSION,
            t: "q",
            id: 910_000_002,
            ref: "items.list",
            args: { room: 9n },
          }));
          return { mutation, rows };
        })(),
        Bun.sleep(operationDeadlineMs).then(() => {
          throw new Error("application work waited for the stalled telemetry exporter");
        }),
      ]);
      expect(mutation.receipt).toMatchObject({
        replay: "executed",
        obligations: [QUERY_SUBSCRIPTION_ID],
      });
      expect(rows).toMatchObject([{ body: "application-remains-correct" }]);
      expect(session.publications.findLast(
        (frame) => frame.t === "transition" && frame.id === QUERY_SUBSCRIPTION_ID,
      )).toMatchObject({
        transition: {
          kind: "update",
          to: { commitVersion: mutation.receipt.commitVersion },
          value: [{ room: 9n, body: "application-remains-correct" }],
        },
      });
      const exporting = app.runtime.telemetry.snapshot();
      expect(exporting.exporter).toMatchObject({
        inFlight: true,
        attempts: 2,
        failures: 1,
        timeouts: 0,
      });
      expect(exporting.queuedRecords).toBeLessThanOrEqual(telemetryLimits.maxRecords);
      expect(exporting.queuedBytes).toBeLessThanOrEqual(telemetryLimits.maxBytes);
    } finally {
      exporterTimeout!();
      await stalledFlush;
    }
    const degraded = app.runtime.telemetry.snapshot();
    expect(degraded.exporter.failures).toBeGreaterThanOrEqual(2);
    expect(degraded.exporter.timeouts).toBeGreaterThanOrEqual(1);
    expect(degraded.queuedRecords).toBeLessThanOrEqual(telemetryLimits.maxRecords);
    expect(degraded.queuedBytes).toBeLessThanOrEqual(telemetryLimits.maxBytes);

    mode = "capture";
    await app.runtime.telemetry.flush();
    expect(captured.length).toBeGreaterThan(0);
  });

  test("an injected Telemetry instance still feeds the durable read model", async () => {
    const app = harness(new Telemetry({ localSink: false }));
    const session = await app.openSession("telemetry-injected");
    expect(await app.runtime.query(session.context, request({
      v: PROTOCOL_VERSION,
      t: "q",
      id: 930_000_001,
      ref: "items.list",
      args: { room: 1n },
    }))).toEqual([]);
    await app.runtime.telemetry.flush();
    await app.runtime.telemetrySpans.flush();
    // The durable pipeline is Runtime-owned wiring: whichever Telemetry the
    // Runtime uses, spans and framework events land in the read model.
    expect(app.runtime.telemetrySpans.snapshot().storedSpans).toBeGreaterThan(0);
    await app.runtime.telemetryJournal.flush();
    const frameworkLogs = app.runtime.telemetryJournal
      .readBatch(0n, 1_000)
      .filter((entry) => entry.kind === "log" && entry.source === "framework");
    expect(frameworkLogs.length).toBeGreaterThan(0);
  });

  test("drain releases the durable sink; recording afterwards is a clean no-op", async () => {
    const telemetry = new Telemetry({ localSink: false });
    const app = harness(telemetry);
    const session = await app.openSession("telemetry-released");
    expect(await app.runtime.query(session.context, request({
      v: PROTOCOL_VERSION,
      t: "q",
      id: 940_000_001,
      ref: "items.list",
      args: { room: 1n },
    }))).toEqual([]);
    await app.runtime.drain();
    const drained = app.runtime.telemetrySpans.snapshot();

    // The caller still owns the instance: recording keeps working and no
    // longer reaches the closed read-model stores.
    expect(telemetry.recordSpan({
      operation: "query",
      stage: "handler",
      outcome: "ok",
      functionName: "items.list",
      durationMs: 1,
      context: {
        traceId: "0193a0e2-1111-7000-8000-000000000009",
        spanId: "0193a0e2-2222-7000-8000-000000000009",
      },
    })).toBe(true);
    expect(app.runtime.telemetrySpans.snapshot()).toEqual(drained);
  });

  test("the terminal lifecycle row is stopped, durably last, exactly once", async () => {
    const telemetry = new Telemetry({ localSink: false });
    const store = new TelemetryStore({ path: ":memory:" });
    const app = harness(telemetry, { telemetryStore: store });
    const session = await app.openSession("telemetry-terminal-clean");
    expect(await app.runtime.query(session.context, request({
      v: PROTOCOL_VERSION,
      t: "q",
      id: 970_000_001,
      ref: "items.list",
      args: { room: 1n },
    }))).toEqual([]);
    await app.runtime.drain();

    const entries = app.runtime.telemetryJournal.readBatch(0n, 10_000);
    const lifecycle = lifecycleStates(entries);
    expect(lifecycle.filter((state) => state === "stopped")).toHaveLength(1);
    expect(lifecycle).not.toContain("failed");
    // The terminal row is structurally the LAST durable record.
    const last = entries.at(-1)!;
    expect(last).toMatchObject({ kind: "log", message: "lifecycle" });
    expect((last as { metadata?: { lifecycleState?: string } }).metadata?.lifecycleState)
      .toBe("stopped");

    // The lease released exactly once: a NEW sink attached by a later owner
    // survives the repeated drain's release backstop.
    const captured: unknown[] = [];
    const detach = telemetry.attachDurableSink({ span: (record) => void captured.push(record) });
    await app.runtime.drain();
    expect(telemetry.recordSpan({
      operation: "query",
      stage: "handler",
      outcome: "ok",
      functionName: "items.list",
      durationMs: 1,
      context: {
        traceId: "0193a0e2-1111-7000-8000-000000000012",
        spanId: "0193a0e2-2222-7000-8000-000000000012",
      },
    })).toBe(true);
    expect(captured).toHaveLength(1);
    detach();
    store.close();
  });

  test.each([
    ["exporter", (app: RuntimeHarness) => app.runtime.telemetryExporters!],
    ["journal", (app: RuntimeHarness) => app.runtime.telemetryJournal],
    ["spans", (app: RuntimeHarness) => app.runtime.telemetrySpans],
  ] as const)(
    "a failing %s drain leaves failed as the last durable lifecycle row",
    async (_kind, target) => {
      const telemetry = new Telemetry({ localSink: false });
      const store = new TelemetryStore({ path: ":memory:" });
      const app = harness(telemetry, {
        telemetryStore: store,
        telemetryExporters: {
          exporters: [{ name: "noop", signals: ["log"], export: () => {} }],
        },
      });
      const drainSpy = spyOn(target(app), "drain").mockRejectedValueOnce(
        new Error("finalization flush failed"),
      );
      await expect(app.runtime.drain()).rejects.toThrow("finalization flush failed");
      drainSpy.mockRestore();

      const entries = app.runtime.telemetryJournal.readBatch(0n, 10_000);
      const lifecycle = lifecycleStates(entries);
      expect(lifecycle.filter((state) => state === "failed")).toHaveLength(1);
      expect(lifecycle).not.toContain("stopped");
      const last = entries.at(-1)!;
      expect((last as { metadata?: { lifecycleState?: string } }).metadata?.lifecycleState)
        .toBe("failed");
      store.close();
    },
  );

  test("a finalization blocked past the deadline still writes one failed terminal row", async () => {
    const telemetry = new Telemetry({ localSink: false });
    const store = new TelemetryStore({ path: ":memory:" });
    const app = harness(telemetry, { telemetryStore: store });
    let release!: () => void;
    const stalled = new Promise<void>((resolve) => {
      release = resolve;
    });
    // The span flush hangs far past the shutdown deadline: the deadline
    // must both bound the drain AND own the terminal outcome — the stalled
    // finalizer must never later persist `stopped` on a failed Runtime.
    const drainSpy = spyOn(app.runtime.telemetrySpans, "drain")
      .mockImplementationOnce(() => stalled);
    await expect(app.runtime.drain(Date.now() + 100)).rejects.toThrow();
    // drain settled only after the finalization finished: the terminal row
    // is already durable and readable, exactly once, and it says failed.
    const entries = app.runtime.telemetryJournal.readBatch(0n, 10_000);
    const lifecycle = lifecycleStates(entries);
    expect(lifecycle.filter((state) => state === "failed")).toHaveLength(1);
    expect(lifecycle).not.toContain("stopped");
    const last = entries.at(-1)! as { metadata?: { lifecycleState?: string; outcome?: string } };
    expect(last.metadata?.lifecycleState).toBe("failed");
    expect(last.metadata?.outcome).toBe("deadline_exceeded");
    release();
    drainSpy.mockRestore();
    store.close();
  });

  test("a failing terminal append rejects the drain and surfaces in accounting", async () => {
    const telemetry = new Telemetry({ localSink: false });
    const store = new TelemetryStore({ path: ":memory:" });
    const app = harness(telemetry, { telemetryStore: store });
    // The sidecar dies between the queue flushes and the terminal append: a
    // terminal row that could not be written must never let the drain
    // resolve clean with zero terminal rows and no explanation.
    const drainSpy = spyOn(app.runtime.telemetrySpans, "drain")
      .mockImplementationOnce(async () => {
        store.close();
      });
    await expect(app.runtime.drain()).rejects.toThrow();
    drainSpy.mockRestore();
    expect(app.runtime.telemetryJournal.snapshot()).toMatchObject({
      state: "failed",
      droppedRecords: 1,
    });
  });

  test("a record landing mid-drain is durably flushed or cleanly bypasses the sink", async () => {
    const telemetry = new Telemetry({ localSink: false });
    const app = harness(telemetry);
    const session = await app.openSession("telemetry-mid-drain");
    expect(await app.runtime.query(session.context, request({
      v: PROTOCOL_VERSION,
      t: "q",
      id: 960_000_001,
      ref: "items.list",
      args: { room: 1n },
    }))).toEqual([]);
    await app.runtime.telemetry.flush();
    await app.runtime.telemetrySpans.flush();
    await app.runtime.telemetryJournal.flush();

    // Fire from inside the drain-time flushes: the journal persists the
    // final lifecycle event while already draining, and the span store
    // persists its tail while already draining — records arriving in those
    // windows must never be accepted by Telemetry yet dropped by a
    // not-ready store.
    const stopJournalListener = app.runtime.telemetryJournal.onPersist(() => {
      telemetry.recordEvent({
        name: "lifecycle",
        level: "info",
        operation: "lifecycle",
      });
    });
    const stopSpanListener = app.runtime.telemetrySpans.onPersist(() => {
      telemetry.recordSpan({
        operation: "query",
        stage: "handler",
        outcome: "ok",
        functionName: "items.list",
        durationMs: 1,
        context: {
          traceId: "0193a0e2-1111-7000-8000-000000000010",
          spanId: "0193a0e2-2222-7000-8000-000000000010",
        },
      });
    });
    // A span queued at drain time makes the span store persist mid-drain.
    telemetry.recordSpan({
      operation: "query",
      stage: "handler",
      outcome: "ok",
      functionName: "items.list",
      durationMs: 1,
      context: {
        traceId: "0193a0e2-1111-7000-8000-000000000011",
        spanId: "0193a0e2-2222-7000-8000-000000000011",
      },
    });
    await app.runtime.drain();
    stopJournalListener();
    stopSpanListener();

    expect(app.runtime.telemetryJournal.snapshot().droppedRecords).toBe(0);
    expect(app.runtime.telemetrySpans.snapshot().droppedRecords).toBe(0);
  });

  test("one injected Telemetry serves two sequential Runtimes", async () => {
    const telemetry = new Telemetry({ localSink: false });
    const first = harness(telemetry);
    await first.runtime.drain();
    harnesses.delete(first);
    await first.close();

    const second = harness(telemetry);
    const session = await second.openSession("telemetry-reused");
    expect(await second.runtime.query(session.context, request({
      v: PROTOCOL_VERSION,
      t: "q",
      id: 950_000_001,
      ref: "items.list",
      args: { room: 1n },
    }))).toEqual([]);
    await second.runtime.telemetry.flush();
    await second.runtime.telemetrySpans.flush();
    expect(second.runtime.telemetrySpans.snapshot().storedSpans).toBeGreaterThan(0);
  });

  test("a failed Runtime construction releases the injected instance", async () => {
    const telemetry = new Telemetry({ localSink: false });
    const store = new TelemetryStore({ path: ":memory:" });
    const journal = new TelemetryJournal({ store });
    await journal.drain();
    const directory = mkdtempSync(join(tmpdir(), "ackerdb-telemetry-release-"));
    const engine = new Engine(schema, join(directory, "data.db"));
    try {
      reconcile(engine);
      // The drained journal fails construction AFTER the sink attached.
      expect(() => new Runtime({
        engine,
        registry: new Registry(functions),
        telemetry,
        telemetryJournal: journal,
      })).toThrow("ready telemetry journal");
      // The failed Runtime released its claim: the instance serves a new one.
      const runtime = new Runtime({
        engine,
        registry: new Registry(functions),
        telemetry,
      });
      await runtime.drain();
    } finally {
      store.close();
      engine.close("clean");
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("an injected Telemetry carrying its own durable sink is rejected", () => {
    const directory = mkdtempSync(join(tmpdir(), "ackerdb-telemetry-conflict-"));
    const engine = new Engine(schema, join(directory, "data.db"));
    try {
      reconcile(engine);
      expect(() => new Runtime({
        engine,
        registry: new Registry(functions),
        telemetry: new Telemetry({
          localSink: false,
          durableSink: { span: () => {} },
        }),
      })).toThrow("durable sink");
    } finally {
      engine.close("clean");
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("disabled telemetry produces no exported records", async () => {
    const exported: TelemetryRecord[] = [];
    const exportedAggregates: TelemetryAggregateSnapshot[] = [];
    const app = harness({
      enabled: false,
      exporter: {
        export(batch, aggregates) {
          exported.push(...batch);
          if (aggregates !== undefined) exportedAggregates.push(aggregates);
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
    expect(exportedAggregates).toEqual([]);
    expect(app.runtime.status().telemetryAggregates).toEqual({
      maxSeries: 0,
      overflowedRecords: 0,
      series: [],
    });
    expect(app.runtime.telemetry.snapshot()).toMatchObject({
      enabled: false,
      queuedRecords: 0,
      exporter: { configured: false, attempts: 0 },
    });
  });
});

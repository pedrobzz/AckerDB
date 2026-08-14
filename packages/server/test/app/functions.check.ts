/**
 * Compile-time assertions for server-side composition: direct function
 * calls with the context lattice enforcing the calling rules. Never
 * executed — `bun run typecheck` failing is the test.
 */
import { Err, Failure, Status } from "@ackerdb/core";
import {
  v,
  defineSchema,
  defineTable,
  mutation,
  procedure,
  query,
  realtime,
  sseProcedure,
  type MutationBuilder,
  type ProcedureBuilder,
  type QueryBuilder,
  type RealtimeBuilder,
  type SseBuilder,
} from "@ackerdb/server";

const schema = defineSchema({
  counters: defineTable({
    id: v.primaryKey(),
    key: v.string(),
    value: v.int(),
  }).index(["key"], { unique: true }),
});
type S = typeof schema;

const typedQuery = query as QueryBuilder<S>;
const typedMutation = mutation as MutationBuilder<S>;
const typedProcedure = procedure as ProcedureBuilder<S>;

typedQuery({
  args: {},
  access: "public",
  handler: () => null,
});

typedMutation({
  args: {},
  access: "public",
  handler: () => {},
});

typedProcedure({
  args: {},
  access: "public",
  handler: async (ctx) => {
    await ctx.tx(() => {});
  },
});

const nestedProfileRequired = () =>
  Err("guest.profile-required", {}, Status.NotFound);

// `returns` constrains only successful values; declared application errors
// remain valid branches of an async handler.
typedProcedure({
  args: { found: v.boolean() },
  returns: v.object({ value: v.string() }),
  errors: {
    "value.not-found": {
      body: v.object({}),
      status: Status.NotFound,
    },
  },
  access: "public",
  handler: async (_ctx, args) => {
    if (!args.found) {
      return Err("value.not-found", {}, Status.NotFound);
    }
    return { value: "found" };
  },
});

typedProcedure({
  args: {},
  // @ts-expect-error handler success must match the returns validator
  returns: v.string(),
  access: "public",
  handler: () => 123,
});

typedProcedure({
  args: {},
  // @ts-expect-error every returned Err code must be declared
  errors: {},
  access: "public",
  handler: () => Err("undeclared", {}, Status.BadRequest),
});

typedProcedure({
  args: {},
  errors: {
    // @ts-expect-error every declared error must remain reachable from the handler
    unused: { body: v.object({}), status: Status.BadRequest },
  },
  access: "public",
  handler: () => "success",
});

typedProcedure({
  args: {},
  errors: {
    invalid: {
      // @ts-expect-error a returned error body must satisfy its declaration
      body: v.object({ expected: v.string() }),
      status: Status.BadRequest,
    },
  },
  access: "public",
  handler: () => Err("invalid", { actual: true }, Status.BadRequest),
});

typedProcedure({
  args: {},
  access: "public",
  // @ts-expect-error registered handlers cannot return non-application Failure Results
  handler: () => Failure(new Error("unexpected")),
});

typedMutation({
  args: {},
  // @ts-expect-error errors returned by nested helpers must also be declared
  errors: {},
  access: "public",
  handler: () => nestedProfileRequired(),
});

const chargePayment = typedMutation({
  args: { available: v.boolean() },
  errors: {
    "stripe.timeout": {
      body: v.object({ retryAfterMs: v.int() }),
      status: Status.ServiceUnavailable,
    },
  },
  access: "public",
  handler: (_ctx, args) =>
    args.available
      ? { chargeId: "charge-1" }
      : Err(
          "stripe.timeout",
          { retryAfterMs: 500 },
          Status.ServiceUnavailable,
        ),
});

typedMutation({
  args: {},
  errors: {
    "payment.unavailable": {
      body: v.object({ retryAfterMs: v.int() }),
      status: Status.ServiceUnavailable,
    },
  },
  access: "public",
  handler: async (ctx) => {
    const payment = await chargePayment(ctx, { available: false });
    if (!payment.ok) {
      return payment.mapErr({
        "stripe.timeout": (error) =>
          Err(
            "payment.unavailable",
            { retryAfterMs: error.body.retryAfterMs },
            Status.ServiceUnavailable,
          ),
      });
    }
    return payment.data;
  },
});

type QueryPluginCapabilities = {
  readonly cache: {
    get(key: string): Promise<string | undefined>;
  };
};
type MutationPluginCapabilities = QueryPluginCapabilities & {
  readonly cache: QueryPluginCapabilities["cache"] & {
    set(key: string, value: string): Promise<void>;
  };
};
type ProcedurePluginCapabilities = MutationPluginCapabilities & {
  readonly external: {
    fetch(key: string): Promise<string>;
  };
};

const pluginQuery = query as QueryBuilder<S, QueryPluginCapabilities>;
const pluginMutation = mutation as MutationBuilder<S, MutationPluginCapabilities>;
const pluginProcedure = procedure as ProcedureBuilder<
  S,
  ProcedurePluginCapabilities,
  MutationPluginCapabilities
>;
const pluginRealtime = realtime as unknown as RealtimeBuilder<
  S,
  ProcedurePluginCapabilities,
  MutationPluginCapabilities
>;

pluginQuery({
  args: {},
  access: "public",
  handler: async (ctx) => {
    const timestamp: number = ctx.timestamp;
    await ctx.cache.get("key");
    // @ts-expect-error query contexts receive no mutation Plugin operations
    ctx.cache.set;
    // @ts-expect-error procedure-only Plugin mounts are absent from queries
    ctx.external;
    return timestamp;
  },
});

pluginMutation({
  args: {},
  access: "public",
  handler: async (ctx) => {
    await ctx.cache.get("key");
    await ctx.cache.set("key", "value");
    // @ts-expect-error procedure-only Plugin mounts are absent from mutations
    ctx.external;
  },
});

pluginProcedure({
  args: {},
  access: "public",
  handler: async (ctx) => {
    await ctx.external.fetch("key");
    await ctx.tx(async (tx) => {
      const inheritedTimestamp: number = tx.timestamp;
      await tx.cache.set("key", "value");
      // @ts-expect-error explicit tx contexts exclude procedure-only Plugin mounts
      tx.external;
      return inheritedTimestamp;
    });
  },
});

const realtimeCallableProcedure = pluginProcedure({
  args: { key: v.string() },
  access: "public",
  handler: async (ctx, args) => {
    const external = await ctx.external.fetch(args.key);
    return ctx.tx((tx) => tx.cache.set(args.key, external));
  },
});

pluginRealtime({
  args: {},
  clientEvents: {
    invoke: v.object({ key: v.string() }),
  },
  serverEvents: {},
  access: "public",
  handler: (ctx) => {
    void ctx.external.fetch("ready");
    ctx.run(async () => {
      await realtimeCallableProcedure(ctx, { key: "provider-callback" });
      await ctx.tx((tx) => tx.cache.set("provider-callback", "direct"));
    });
    ctx.on("invoke", async ({ key }) => {
      await realtimeCallableProcedure(ctx, { key });
      await ctx.tx((tx) => tx.cache.set(key, "direct"));
    });
  },
});

const getCounter = typedQuery({
  args: { key: v.string() },
  access: (_ctx, args) => args.key.length > 0,
  handler: (ctx, args) => ctx.db.counters.query().where((row) => row.key.eq(args.key)).unique(),
});

const bump = typedMutation({
  args: { key: v.string() },
  access: "authenticated",
  handler: async (ctx, args) => {
    // a mutation calls a query with its own ctx: read/write ⊇ read-only
    const existing = await getCounter(ctx, { key: args.key });
    return ctx.db.counters.upsert({ key: args.key }, { value: (existing.data?.value ?? 0) + 1 });
  },
});

export const _pipeline = typedProcedure({
  args: { key: v.string() },
  access: "system",
  handler: async (ctx, args) => {
    // procedures compose queries and mutations inside explicit transactions;
    // several calls in one ctx.tx commit atomically together
    const value = await ctx.tx(async (tx) => {
      await bump(tx, { key: args.key });
      const row = await getCounter(tx, { key: args.key });
      return row.data!.value;
    });
    // @ts-expect-error refs/addresses are for clients; the old runQuery is gone
    void ctx.runQuery;
    // Registered procedures compose in-process with the same Result boundary.
    void _pipeline(ctx, { key: args.key });
    return value;
  },
});


export const _readOnly = typedQuery({
  args: {},
  access: "public",
  handler: async (ctx) => {
    await getCounter(ctx, { key: "fine" }); // query -> query: fine
    // @ts-expect-error a query cannot call a mutation — its ctx has no writes
    await bump(ctx, { key: "nope" });
    return null;
  },
});

// Missing access is rejected at definition time; there is no implicit public mode.
// @ts-expect-error every function must declare its access policy
typedQuery({
  args: {},
  handler: () => null,
});

// --- SSE declarations: required yields validator, chunk-typed sources --------

const typedSse = sseProcedure as SseBuilder<S>;

export const _ticker = typedSse({
  args: { key: v.string() },
  yields: v.object({ key: v.string(), value: v.int() }),
  access: "public",
  handler: async function* (ctx, args) {
    const row = await ctx.tx((tx) => getCounter(tx, { key: args.key }));
    yield { key: args.key, value: row.data?.value ?? 0 };
  },
});

// The registered phantom is the validated chunk type, never the completion.
type TickerChunk = NonNullable<(typeof _ticker)["_retType"]>;
const _tickerChunk: TickerChunk = { key: "k", value: 1 };
// @ts-expect-error the chunk shape follows the yields validator exactly
const _wrongTickerChunk: TickerChunk = { key: "k", value: "1" };

// @ts-expect-error SSE declarations require a yields chunk validator
typedSse({
  args: {},
  access: "public",
  handler: async function* () {},
});

typedSse({
  args: {},
  yields: v.float(),
  access: "public",
  // @ts-expect-error yielded values must satisfy the yields validator
  handler: async function* () {
    yield "not a number";
  },
});

// A handler may return a ReadableStream of the declared chunks directly.
export const _streamed = typedSse({
  args: {},
  yields: v.float(),
  access: "public",
  handler: () => new ReadableStream<number>(),
});

typedSse({
  args: {},
  yields: v.float(),
  access: "public",
  // @ts-expect-error a stream of the wrong chunk type is rejected
  handler: () => new ReadableStream<string>(),
});

typedSse({
  args: {},
  yields: v.float(),
  access: "public",
  // @ts-expect-error SSE handlers must return a chunk source, not a bare value
  handler: () => 1,
});

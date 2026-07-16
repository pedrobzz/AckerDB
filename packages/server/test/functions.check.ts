/**
 * Compile-time assertions for server-side composition: direct function
 * calls with the context lattice enforcing the calling rules. Never
 * executed — `bun run typecheck` failing is the test.
 */
import {
  dbz,
  defineSchema,
  defineTable,
  mutation,
  procedure,
  query,
  sseProcedure,
  type MutationBuilder,
  type ProcedureBuilder,
  type QueryBuilder,
  type SseBuilder,
} from "@dbzz/server";

const schema = defineSchema({
  counters: defineTable({
    id: dbz.primaryKey(),
    key: dbz.string(),
    value: dbz.number(),
  }).index("by_key", ["key"], { unique: true }),
});
type S = typeof schema;

const typedQuery = query as QueryBuilder<S>;
const typedMutation = mutation as MutationBuilder<S>;
const typedProcedure = procedure as ProcedureBuilder<S>;

const getCounter = typedQuery({
  args: { key: dbz.string() },
  access: (_ctx, args) => args.key.length > 0,
  handler: (ctx, args) => ctx.db.counters.byKey((q) => q.eq("key", args.key)).unique(),
});

const bump = typedMutation({
  args: { key: dbz.string() },
  access: "authenticated",
  handler: async (ctx, args) => {
    // a mutation calls a query with its own ctx: read/write ⊇ read-only
    const existing = await getCounter(ctx, { key: args.key });
    return ctx.db.counters.byKey.upsert({ key: args.key }, { value: (existing?.value ?? 0) + 1 });
  },
});

export const _pipeline = typedProcedure({
  args: { key: dbz.string() },
  access: "system",
  handler: async (ctx, args) => {
    // procedures compose queries and mutations inside explicit transactions;
    // several calls in one ctx.tx commit atomically together
    const value = await ctx.tx(async (tx) => {
      await bump(tx, { key: args.key });
      const row = await getCounter(tx, { key: args.key });
      return row!.value;
    });
    // @ts-expect-error refs/addresses are for clients; the old runQuery is gone
    void ctx.runQuery;
    // @ts-expect-error procedures cannot be called in-process
    void _pipeline(ctx, { key: args.key });
    return value;
  },
});

defineTable({ id: dbz.primaryKey(), at: dbz.scheduleAt() }).scheduled(bump);
// @ts-expect-error scheduled handlers must be mutations so deletion shares their commit
defineTable({ id: dbz.primaryKey(), at: dbz.scheduleAt() }).scheduled(_pipeline);

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
  args: { key: dbz.string() },
  yields: dbz.object({ key: dbz.string(), value: dbz.number() }),
  access: "public",
  handler: async function* (ctx, args) {
    const row = await ctx.tx((tx) => getCounter(tx, { key: args.key }));
    yield { key: args.key, value: row?.value ?? 0 };
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
  yields: dbz.number(),
  access: "public",
  // @ts-expect-error yielded values must satisfy the yields validator
  handler: async function* () {
    yield "not a number";
  },
});

// A handler may return a ReadableStream of the declared chunks directly.
export const _streamed = typedSse({
  args: {},
  yields: dbz.number(),
  access: "public",
  handler: () => new ReadableStream<number>(),
});

typedSse({
  args: {},
  yields: dbz.number(),
  access: "public",
  // @ts-expect-error a stream of the wrong chunk type is rejected
  handler: () => new ReadableStream<string>(),
});

typedSse({
  args: {},
  yields: dbz.number(),
  access: "public",
  // @ts-expect-error SSE handlers must return a chunk source, not a bare value
  handler: () => 1,
});

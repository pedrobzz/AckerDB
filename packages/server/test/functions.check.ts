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
  type MutationBuilder,
  type ProcedureBuilder,
  type QueryBuilder,
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

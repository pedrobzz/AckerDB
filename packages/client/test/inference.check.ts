/**
 * Compile-time assertions for generated client return inference. This file is
 * never executed — `bun run typecheck` failing (including an unused
 * @ts-expect-error) is the test.
 */
import { AckerDBClient } from "@ackerdb/client";
import {
  Err,
  Status,
  anyApi,
  type ApiFromModules,
  type MutationReceipt,
  type SseRef,
} from "@ackerdb/core";
import {
  v,
  defineSchema,
  mutation,
  procedure,
  query,
  sseProcedure,
  type MutationBuilder,
  type ProcedureBuilder,
  type QueryBuilder,
  type SseBuilder,
} from "@ackerdb/server";

const schema = defineSchema({});
type Schema = typeof schema;

const generatedQuery = query as QueryBuilder<Schema>;
const generatedMutation = mutation as MutationBuilder<Schema>;
const generatedProcedure = procedure as ProcedureBuilder<Schema>;

const authorizationSummary = generatedQuery({
  args: { label: v.string() },
  access: "public",
  handler: (ctx, args) => ({ kind: ctx.auth.kind, label: args.label }),
});

const createItem = generatedMutation({
  args: { label: v.string() },
  access: "authenticated",
  handler: async (ctx, args) => {
    const authorization = await authorizationSummary(ctx, args);
    return {
      id: 1n,
      authorization: authorization.data,
    };
  },
});

const pipeline = generatedProcedure({
  args: { label: v.string() },
  access: "authenticated",
  handler: (ctx, args) => ctx.tx(async (tx) => {
    const item = await createItem(tx, args);
    return { item: item.data, committed: true as const };
  }),
});

const findItem = generatedQuery({
  args: { found: v.boolean() },
  access: "public",
  handler: (_ctx, { found }) =>
    found
      ? { id: 1n }
      : Err("item-not-found", { id: 1n }, Status.NotFound),
});

const generatedSse = sseProcedure as SseBuilder<Schema>;

const ticker = generatedSse({
  args: { label: v.string() },
  yields: v.object({ label: v.string(), tick: v.int() }),
  access: "public",
  handler: async function* (_ctx, args) {
    yield { label: args.label, tick: 0 };
  },
});

const api = anyApi as unknown as ApiFromModules<{
  generated: {
    authorizationSummary: typeof authorizationSummary;
    createItem: typeof createItem;
    pipeline: typeof pipeline;
    findItem: typeof findItem;
    ticker: typeof ticker;
  };
}>;

// Generated SSE references carry the yields validator's chunk type.
const _tickerRef: SseRef<{ label: string }, { label: string; tick: number }> = api.generated.ticker;
// @ts-expect-error the SSE reference chunk is the validated yield, not the handler completion
const _completionRef: SseRef<{ label: string }, void> = api.generated.ticker;

declare const client: AckerDBClient;

export async function _generatedClientInference(): Promise<void> {
  const queryResult = await client.query(api.generated.authorizationSummary, { label: "query" });
  if (!queryResult.ok) throw queryResult.error;
  const _queryLabel: string = queryResult.data.label;
  const _principalKind: "anonymous" | "user" | "mcp" | "workload" | "system" = queryResult.data.kind;
  // @ts-expect-error query handler inference keeps label as string
  const _wrongQueryLabel: number = queryResult.data.label;

  const mutationResult = await client.mutation(api.generated.createItem, { label: "mutation" });
  if (!mutationResult.ok) throw mutationResult.error;
  const _mutationId: bigint = mutationResult.data.id;
  const _nestedLabel: string = mutationResult.data.authorization.label;
  // @ts-expect-error the protocol receipt does not replace the application result type
  const _wrongMutationResult: MutationReceipt = mutationResult;

  const procedureResult = await client.procedure(api.generated.pipeline, { label: "procedure" });
  if (!procedureResult.ok) throw procedureResult.error;
  const _procedureId: bigint = procedureResult.data.item.id;
  const _committed: true = procedureResult.data.committed;
  // @ts-expect-error nested mutation inference remains intact through the procedure result
  const _wrongProcedureId: string = procedureResult.data.item.id;

  const missing = await client.query(api.generated.findItem, { found: false });
  if (!missing.ok && missing.error.kind === "application") {
    const _code: "item-not-found" = missing.error.code;
    const _id: bigint = missing.error.body.id;
  }

  for await (const chunk of client.sse(api.generated.ticker, { label: "sse" })) {
    const _tick: number = chunk.tick;
    const _label: string = chunk.label;
    // @ts-expect-error the SSE chunk type follows the yields validator
    const _wrongTick: string = chunk.tick;
  }
  // @ts-expect-error SSE arguments are inferred from the reference
  client.sse(api.generated.ticker, { label: 1 });
}

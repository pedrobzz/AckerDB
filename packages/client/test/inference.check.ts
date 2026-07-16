/**
 * Compile-time assertions for generated client return inference. This file is
 * never executed — `bun run typecheck` failing (including an unused
 * @ts-expect-error) is the test.
 */
import { DbzzClient } from "@dbzz/client";
import { anyApi, type ApiFromModules, type MutationReceipt, type SseRef } from "@dbzz/core";
import {
  dbz,
  defineSchema,
  mutation,
  procedure,
  query,
  sseProcedure,
  type MutationBuilder,
  type ProcedureBuilder,
  type QueryBuilder,
  type SseBuilder,
} from "@dbzz/server";

const schema = defineSchema({});
type Schema = typeof schema;

const generatedQuery = query as QueryBuilder<Schema>;
const generatedMutation = mutation as MutationBuilder<Schema>;
const generatedProcedure = procedure as ProcedureBuilder<Schema>;

const authorizationSummary = generatedQuery({
  args: { label: dbz.string() },
  access: "public",
  handler: (ctx, args) => ({ kind: ctx.auth.kind, label: args.label }),
});

const createItem = generatedMutation({
  args: { label: dbz.string() },
  access: "authenticated",
  handler: async (ctx, args) => ({
    id: 1n,
    authorization: await authorizationSummary(ctx, args),
  }),
});

const pipeline = generatedProcedure({
  args: { label: dbz.string() },
  access: "authenticated",
  handler: (ctx, args) => ctx.tx(async (tx) => ({
    item: await createItem(tx, args),
    committed: true as const,
  })),
});

const generatedSse = sseProcedure as SseBuilder<Schema>;

const ticker = generatedSse({
  args: { label: dbz.string() },
  yields: dbz.object({ label: dbz.string(), tick: dbz.number() }),
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
    ticker: typeof ticker;
  };
}>;

// Generated SSE references carry the yields validator's chunk type.
const _tickerRef: SseRef<{ label: string }, { label: string; tick: number }> = api.generated.ticker;
// @ts-expect-error the SSE reference chunk is the validated yield, not the handler completion
const _completionRef: SseRef<{ label: string }, void> = api.generated.ticker;

declare const client: DbzzClient;

export async function _generatedClientInference(): Promise<void> {
  const queryResult = await client.query(api.generated.authorizationSummary, { label: "query" });
  const _queryLabel: string = queryResult.label;
  const _principalKind: "anonymous" | "user" | "workload" | "system" = queryResult.kind;
  // @ts-expect-error query handler inference keeps label as string
  const _wrongQueryLabel: number = queryResult.label;

  const mutationResult = await client.mutation(api.generated.createItem, { label: "mutation" });
  const _mutationId: bigint = mutationResult.id;
  const _nestedLabel: string = mutationResult.authorization.label;
  // @ts-expect-error the Protocol 2 receipt does not replace the application result type
  const _wrongMutationResult: MutationReceipt = mutationResult;

  const procedureResult = await client.procedure(api.generated.pipeline, { label: "procedure" });
  const _procedureId: bigint = procedureResult.item.id;
  const _committed: true = procedureResult.committed;
  // @ts-expect-error nested mutation inference remains intact through the procedure result
  const _wrongProcedureId: string = procedureResult.item.id;

  for await (const chunk of client.sse(api.generated.ticker, { label: "sse" })) {
    const _tick: number = chunk.tick;
    const _label: string = chunk.label;
    // @ts-expect-error the SSE chunk type follows the yields validator
    const _wrongTick: string = chunk.tick;
  }
  // @ts-expect-error SSE arguments are inferred from the reference
  client.sse(api.generated.ticker, { label: 1 });
}

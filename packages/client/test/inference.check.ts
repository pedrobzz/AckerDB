/**
 * Compile-time assertions for generated client return inference. This file is
 * never executed — `bun run typecheck` failing (including an unused
 * @ts-expect-error) is the test.
 */
import { DbzzClient } from "@dbzz/client";
import { anyApi, type ApiFromModules, type MutationReceipt } from "@dbzz/core";
import {
  dbz,
  defineSchema,
  mutation,
  procedure,
  query,
  type MutationBuilder,
  type ProcedureBuilder,
  type QueryBuilder,
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

const api = anyApi as unknown as ApiFromModules<{
  generated: {
    authorizationSummary: typeof authorizationSummary;
    createItem: typeof createItem;
    pipeline: typeof pipeline;
  };
}>;

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
}

/**
 * Compile-time assertions for generated client return inference. This file is
 * never executed — `bun run typecheck` failing (including an unused
 * @ts-expect-error) is the test.
 */
import {
  AckerDBClient,
  type FileId,
  type FileUploadSession,
} from "@ackerdb/client";
import {
  Err,
  Ok,
  Status,
  anyApi,
  type ApiFromModules,
  type MutationReceipt,
  type SseRef,
} from "@ackerdb/core";
import {
  v,
  channel,
  defineSchema,
  mutation,
  procedure,
  query,
  sseProcedure,
  type MutationBuilder,
  type ChannelBuilder,
  type ProcedureBuilder,
  type QueryBuilder,
  type SseBuilder,
} from "@ackerdb/server";

const schema = defineSchema({});
type Schema = typeof schema;

const generatedQuery = query as QueryBuilder<Schema>;
const generatedMutation = mutation as MutationBuilder<Schema>;
const generatedProcedure = procedure as ProcedureBuilder<Schema>;
const generatedChannel = channel as ChannelBuilder<Schema>;

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

const createFileUpload = generatedMutation({
  args: { organizationId: v.bigint() },
  access: "authenticated",
  handler: (_ctx, args) =>
    args.organizationId > 0n
      ? ({
          url: "https://uploads.ackerdb.test/session",
          expiresAt: 2_000,
          maxBytes: 1_024,
        } satisfies FileUploadSession)
      : Err(
          "organization-not-found",
          { organizationId: args.organizationId },
          Status.NotFound,
        ),
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

const chatRoom = generatedChannel({
  args: { threadId: v.bigint() },
  room: v.string(),
  clientEvents: {
    message: v.object({ body: v.string() }),
    typing: v.boolean(),
  },
  serverEvents: {
    message: v.object({ id: v.bigint(), body: v.string() }),
    typing: v.object({ active: v.boolean() }),
  },
  access: "authenticated",
  authorize: (_ctx, args) =>
    args.threadId > 0n
      ? Ok({ threadId: args.threadId })
      : Err("thread-not-found", { threadId: args.threadId }, Status.NotFound),
  on: {
    message: (ctx, payload) =>
      ctx.publish("message", { id: ctx.state.threadId, body: payload.body }),
    typing: (ctx, active) => ctx.publish("typing", { active }),
  },
});

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
    createFileUpload: typeof createFileUpload;
    pipeline: typeof pipeline;
    findItem: typeof findItem;
    ticker: typeof ticker;
    chatRoom: typeof chatRoom;
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

  const fileResult = await client.files.upload({
    createSession: api.generated.createFileUpload,
    args: { organizationId: 1n },
    file: new Uint8Array([1, 2, 3]),
  });
  if (fileResult.ok) {
    const _fileId: FileId = fileResult.data;
    // @ts-expect-error the helper returns the File identity, not its upload session
    const _session: FileUploadSession = fileResult.data;
  } else if (fileResult.error.kind === "application") {
    const _code: "organization-not-found" = fileResult.error.code;
    const _organizationId: bigint = fileResult.error.body.organizationId;
  }
  client.files.upload({
    createSession: api.generated.createFileUpload,
    args: {
      // @ts-expect-error upload arguments are inferred from the application mutation
      organizationId: "1",
    },
    file: new Uint8Array(),
  });
  client.files.upload({
    // @ts-expect-error the session creator must return FileUploadSession
    createSession: api.generated.createItem,
    args: { label: "document" },
    file: new Uint8Array(),
  });
  client.files.upload({
    // @ts-expect-error the helper requires a typed application MutationRef
    createSession: "documents.createUpload",
    args: {},
    file: new Uint8Array(),
  });

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

  const chat = client.channel(
    api.generated.chatRoom,
    { threadId: 1n },
    {
      room: "support",
      handlerKey: "useChatRoom",
      on: (event) => {
        if (event.type === "message") {
          const _id: bigint = event.payload.id;
          const _body: string = event.payload.body;
        } else {
          const _active: boolean = event.payload.active;
        }
      },
    },
  );
  chat.send("message", { body: "hello" });
  chat.send("typing", true);
  // @ts-expect-error roomed channels require a room
  client.channel(api.generated.chatRoom, { threadId: 1n });
  // @ts-expect-error client event payloads are inferred from the declaration
  chat.send("message", { body: 1 });

  if (chat.currentState.phase === "rejected") {
    const _code: "thread-not-found" = chat.currentState.error.code;
    const _threadId: bigint = chat.currentState.error.body.threadId;
  }
}

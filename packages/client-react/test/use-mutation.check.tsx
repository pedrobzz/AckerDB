// Compile-time contract for useMutation. This file is typechecked (see the
// package tsconfig) and never executed — `bun run typecheck` failing
// (including an unused @ts-expect-error) is the test.
import {
  anyApi,
  type ApiFromModules,
  type ClientResult,
} from "@ackerdb/client";
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
import type { ReactNode } from "react";
import {
  useMutation,
  type AckerDBClientError,
} from "@ackerdb/client-react";

const schema = defineSchema({});
type Schema = typeof schema;

const generatedQuery = query as QueryBuilder<Schema>;
const generatedMutation = mutation as MutationBuilder<Schema>;
const generatedProcedure = procedure as ProcedureBuilder<Schema>;
const generatedSse = sseProcedure as SseBuilder<Schema>;

const listMessages = generatedQuery({
  args: { channelId: v.bigint() },
  access: "public",
  handler: (_ctx, args) => [{ id: 1n, channelId: args.channelId }],
});

const sendMessage = generatedMutation({
  args: { channelId: v.bigint(), body: v.string() },
  access: "public",
  handler: (_ctx, args) => ({ id: 1n, body: args.body }),
});

const exportChannel = generatedProcedure({
  args: { channelId: v.bigint() },
  access: "public",
  handler: () => "done" as const,
});

const streamChannel = generatedSse({
  args: { channelId: v.bigint() },
  yields: v.string(),
  access: "public",
  handler: async function* () {
    yield "chunk";
  },
});

const api = anyApi as unknown as ApiFromModules<{
  messages: {
    list: typeof listMessages;
    send: typeof sendMessage;
    export: typeof exportChannel;
    stream: typeof streamChannel;
  };
}>;

// --- argument and result inference -------------------------------------------

export function InferredMutation(): ReactNode {
  const send = useMutation(api.messages.send);

  // The callable infers the generated argument object exactly.
  void send({ channelId: 1n, body: "hello" });
  // @ts-expect-error arguments must match the generated validator types
  void send({ channelId: 1, body: "hello" });
  // @ts-expect-error missing arguments fail at compile time
  void send({ channelId: 1n });
  // @ts-expect-error unknown arguments fail at compile time
  void send({ channelId: 1n, body: "hello", extra: true });

  const settle = async (): Promise<void> => {
    const result = await send({ channelId: 1n, body: "hello" });
    if (!result.ok) {
      const _error: AckerDBClientError = result.error;
      void _error;
      return;
    }
    const _id: bigint = result.data.id;
    const _body: string = result.data.body;
    // @ts-expect-error the handler result keeps body as string
    const _wrongBody: number = result.data.body;
  };
  void settle;
  return null;
}

// --- reference kinds ----------------------------------------------------------

export function WrongReferenceKinds(): ReactNode {
  // @ts-expect-error a query reference is not a mutation reference
  useMutation(api.messages.list);
  // @ts-expect-error a procedure reference is not a mutation reference
  useMutation(api.messages.export);
  // @ts-expect-error an SSE reference is not a mutation reference
  useMutation(api.messages.stream);
  // @ts-expect-error raw address strings carry no inference; only generated references are accepted
  useMutation("api.messages.send");
  return null;
}

// --- callable shape -----------------------------------------------------------

export function CallableShape(): ReactNode {
  const send = useMutation(api.messages.send);
  const _callable: (
    args: { channelId: bigint; body: string },
  ) => Promise<ClientResult<{ id: bigint; body: string }>> = send;
  // @ts-expect-error the callable takes exactly one argument object; there is no options parameter
  void send({ channelId: 1n, body: "hello" }, { signal: undefined });
  void _callable;
  return null;
}

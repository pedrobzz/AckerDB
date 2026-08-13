/**
 * Compile-time assertions for API-path grouping: `ApiFromModules` selects one
 * group, every group carries fully typed references, and a socket-addressed
 * declaration has no group to name. Never executed — `bun run typecheck`
 * failing is the test.
 */
import type { ApiFromModules, FunctionReference } from "@ackerdb/core";
import { channel, mutation, procedure, query, sseProcedure, v } from "@ackerdb/server";

const listMessages = query({
  access: "public",
  args: {},
  handler: () => [] as string[],
});

const compact = mutation({
  apiPath: "internal",
  access: "system",
  args: { limit: v.int() },
  handler: (_ctx, args) => args.limit,
});

const payInvoice = procedure({
  apiPath: "internal",
  access: "authenticated",
  args: { invoiceId: v.string() },
  handler: (_ctx, args) => args.invoiceId,
});

const room = channel({
  access: "public",
  args: {},
  clientEvents: {},
  serverEvents: {},
  on: {},
});

channel({
  // @ts-expect-error a channel is addressed over the socket, so it has no
  // HTTP root to group and no apiPath to name
  apiPath: "internal",
  access: "public",
  args: {},
  clientEvents: {},
  serverEvents: {},
  on: {},
});

// A group must be exactly one string literal: every shape less precise than
// that names no group a generated tree can select, so the function would
// answer on a live route and appear in no binding at all.
declare const computed: string;
query({
  // @ts-expect-error a widened string is not one literal
  apiPath: computed,
  access: "public",
  args: {},
  handler: () => null,
});

declare const either: "internal" | "admin";
query({
  // @ts-expect-error a union of literals is not one literal
  apiPath: either,
  access: "public",
  args: {},
  handler: () => null,
});

declare const maybe: "internal" | undefined;
query({
  // @ts-expect-error a literal that may be absent is not one literal
  apiPath: maybe,
  access: "public",
  args: {},
  handler: () => null,
});

sseProcedure({
  // @ts-expect-error the same rule reaches sse declarations
  apiPath: either,
  access: "public",
  args: {},
  yields: v.string(),
  handler: async function* () {},
});

type Modules = {
  messages: { list: typeof listMessages; compact: typeof compact };
  billing: { payInvoice: typeof payInvoice };
  presence: { room: typeof room };
};

declare const api: ApiFromModules<Modules>;
declare const internal: ApiFromModules<Modules, "internal">;

// The default group holds the functions that named no group, plus every
// socket-addressed contract.
api.messages.list satisfies FunctionReference<"query">;
api.presence.room;
// @ts-expect-error a function in another group is absent from this binding
api.messages.compact;
// @ts-expect-error a function in another group is absent from this binding
api.billing.payInvoice;

// The `internal` group carries exactly its own functions, fully typed.
internal.messages.compact satisfies FunctionReference<"mutation">;
internal.billing.payInvoice satisfies FunctionReference<"procedure", { invoiceId: string }>;
// @ts-expect-error a function in another group is absent from this binding
internal.messages.list;
// @ts-expect-error socket-addressed contracts live in the default group alone
internal.presence.room;

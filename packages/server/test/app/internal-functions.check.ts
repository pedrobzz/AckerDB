/**
 * Compile-time assertions for internal-function erasure: `ApiFromModules`
 * drops `internal: true` keys, `InternalFromModules` keeps exactly them, and
 * the field accepts only the literal `true`. Never executed — `bun run
 * typecheck` failing is the test.
 */
import type {
  ApiFromModules,
  FunctionReference,
  InternalFromModules,
} from "@ackerdb/core";
import { mutation, procedure, query, v } from "@ackerdb/server";

const listMessages = query({
  access: "public",
  args: {},
  handler: () => [] as string[],
});

const compact = mutation({
  internal: true,
  access: "system",
  args: { limit: v.int() },
  handler: (_ctx, args) => args.limit,
});

const payInvoice = procedure({
  internal: true,
  access: "authenticated",
  args: { invoiceId: v.string() },
  handler: (_ctx, args) => args.invoiceId,
});

declare const computed: boolean;
query({
  // @ts-expect-error internal accepts only the literal true — a computed
  // boolean cannot silently widen a function into the client surface
  internal: computed,
  access: "public",
  args: {},
  handler: () => null,
});

type Modules = {
  messages: { list: typeof listMessages; compact: typeof compact };
  billing: { payInvoice: typeof payInvoice };
};

declare const api: ApiFromModules<Modules>;
declare const internal: InternalFromModules<Modules>;

// The public tree keeps the public function and erases the internal ones.
api.messages.list satisfies FunctionReference<"query">;
// @ts-expect-error internal functions have no client-facing reference
api.messages.compact;
// @ts-expect-error internal functions have no client-facing reference
api.billing.payInvoice;

// The internal tree carries exactly the erased references, fully typed.
internal.messages.compact satisfies FunctionReference<"mutation">;
internal.billing.payInvoice satisfies FunctionReference<"procedure", { invoiceId: string }>;
// @ts-expect-error public functions do not appear on the internal tree
internal.messages.list;

/** Compile-time Identity ownership assertions. `bun run typecheck` is the test. */
import {
  v,
  defineSchema,
  defineTable,
  mutation,
  procedure,
  type Identity,
  type ExternalAccount,
  type MutationBuilder,
  type MutationCtx,
  type Principal,
  type ProcedureBuilder,
  type QueryCtx,
  type SseCtx,
  type TxCtx,
  type UserPrincipal,
  type VerifiedUserCredential,
} from "@dbzz/server";

const schema = defineSchema({
  owned: defineTable({
    id: v.primaryKey(),
    userId: v.identity(),
    value: v.string(),
  }),
});

const typedMutation = mutation as MutationBuilder<typeof schema>;
const typedProcedure = procedure as ProcedureBuilder<typeof schema>;

export const _writeOwnedRow = typedMutation({
  args: { value: v.string() },
  access: (ctx) => ctx.auth.kind === "user",
  handler: (ctx, args) => {
    if (ctx.auth.kind !== "user") throw new Error("user required");
    const identity: Identity = ctx.auth.identity;
    // @ts-expect-error internal framework tables never enter the generated application database surface
    void ctx.db._dbz_identities;
    return ctx.db.owned.insert({ userId: identity, value: args.value });
  },
});

export const _linkAccount = typedProcedure({
  args: { rawBearerToken: v.string() },
  access: (ctx) => ctx.auth.kind === "user",
  handler: (ctx, args) => ctx.linkAccount(args.rawBearerToken),
});

export const _unlinkAccount = typedProcedure({
  args: { issuer: v.string(), subject: v.string() },
  access: (ctx) => ctx.auth.kind === "user",
  handler: (ctx, account) => ctx.unlinkAccount(account),
});

declare const queryCtx: QueryCtx<typeof schema>;
declare const mutationCtx: MutationCtx<typeof schema>;
declare const txCtx: TxCtx<typeof schema>;
declare const sseCtx: SseCtx<typeof schema>;
declare const account: ExternalAccount;
const unlinkFromSse: Promise<void> = sseCtx.unlinkAccount(account);
void unlinkFromSse;
// @ts-expect-error linking performs external verification and is unavailable to queries
void queryCtx.linkAccount;
// @ts-expect-error linking performs external verification and is unavailable to mutations
void mutationCtx.linkAccount;
// @ts-expect-error exact account attachment is owned by the procedure capability
void txCtx.linkAccount;
// @ts-expect-error unlinking is unavailable to queries
void queryCtx.unlinkAccount;
// @ts-expect-error unlinking is unavailable to mutations
void mutationCtx.unlinkAccount;
// @ts-expect-error exact account detachment is owned by the procedure capability
void txCtx.unlinkAccount;

declare const principal: Principal;
if (principal.kind === "user") {
  const identity: Identity = principal.identity;
  void identity;
} else {
  // @ts-expect-error non-user principals structurally have no application Identity
  void principal.identity;
}

const evidence: VerifiedUserCredential = {
  kind: "user",
  issuer: "https://issuer.example/",
  subject: "alice",
  claims: {},
  expiresAt: 1,
  tokenId: null,
};
// @ts-expect-error verified credential evidence is not yet an application principal
void evidence.identity;

// @ts-expect-error a user principal cannot exist before durable Identity resolution
const identitylessPrincipal: UserPrincipal = evidence;
void identitylessPrincipal;

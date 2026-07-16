/** Compile-time Identity ownership assertions. `bun run typecheck` is the test. */
import {
  dbz,
  defineSchema,
  defineTable,
  mutation,
  type Identity,
  type MutationBuilder,
  type Principal,
  type UserPrincipal,
  type VerifiedUserCredential,
} from "@dbzz/server";

const schema = defineSchema({
  owned: defineTable({
    id: dbz.primaryKey(),
    userId: dbz.identity(),
    value: dbz.string(),
  }),
});

const typedMutation = mutation as MutationBuilder<typeof schema>;

export const _writeOwnedRow = typedMutation({
  args: { value: dbz.string() },
  access: (ctx) => ctx.auth.kind === "user",
  handler: (ctx, args) => {
    if (ctx.auth.kind !== "user") throw new Error("user required");
    const identity: Identity = ctx.auth.identity;
    // @ts-expect-error internal framework tables never enter the generated application database surface
    void ctx.db._dbz_identities;
    return ctx.db.owned.insert({ userId: identity, value: args.value });
  },
});

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

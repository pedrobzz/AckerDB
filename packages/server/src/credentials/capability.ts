/**
 * `ctx.credentials`: the Credentials module bound to one invocation.
 *
 * The two scopes differ in exactly two things — who may ask, and what bounds
 * the request — and both are settled here, before the module runs. Owner
 * operations need a user Identity and are bounded by the grant that Identity
 * currently holds. `ctx.credentials.manage` needs nothing and is bounded by
 * nothing: reaching a registered function is the whole admission decision, and
 * that decision is the application's own access policy.
 *
 * Everything else the operations owe — the safe projection, the delegation
 * check, the descendant cascade, the one-time mark, the staged invalidations —
 * belongs to the module, so the two scopes cannot drift apart by one of them
 * forgetting an invariant.
 */
import type { Identity } from "@ackerdb/core";
import type { Principal } from "../auth/credentials.ts";
import { AckerDBError } from "../shared/errors.ts";
import type {
  CredentialMutationCapability,
  CredentialQueryCapability,
  IssueCredentialInput,
  IssuedCredential,
  UpdateCredentialInput,
} from "./api.ts";
import { Credentials, GLOBAL_SCOPE, type CredentialScope } from "./module.ts";

/**
 * The owner scope, or the refusal. Anonymous has no Identity to own anything,
 * and the system principal is the framework's own authority rather than a
 * credential holder — neither can be guessed into an owner, so both fail as
 * unauthenticated rather than returning somebody else's empty list.
 */
function ownerScope(principal: Principal): CredentialScope & { readonly identity: Identity } {
  if (principal.kind !== "user") {
    throw new AckerDBError(
      "unauthenticated",
      "owner-scoped credential operations require a user identity",
    );
  }
  return Object.freeze({ kind: "owner" as const, identity: principal.identity });
}

/** The grant an owner may delegate: exactly what it currently holds. */
function delegatedBy(principal: Principal): readonly string[] {
  return principal.kind === "user" ? principal.scopes : [];
}

export function credentialQueryCapability(
  credentials: Credentials,
  principal: Principal,
): CredentialQueryCapability {
  return Object.freeze({
    query: () => credentials.query(ownerScope(principal)),
    manage: Object.freeze({ query: () => credentials.query(GLOBAL_SCOPE) }),
  });
}

export function credentialMutationCapability(
  credentials: Credentials,
  principal: Principal,
): CredentialMutationCapability {
  return Object.freeze({
    query: () => credentials.query(ownerScope(principal)),
    issue: (input: IssueCredentialInput): Promise<IssuedCredential> => {
      const owner = ownerScope(principal);
      return credentials.issue({
        parentIdentity: owner.identity,
        credential: input,
        delegatedBy: delegatedBy(principal),
      });
    },
    update: (id: string, input: UpdateCredentialInput) =>
      credentials.update(ownerScope(principal), id, input),
    updateScopes: (id: string, scopes: readonly string[]) =>
      credentials.updateScopes(ownerScope(principal), id, scopes, delegatedBy(principal)),
    revoke: async (id: string) => {
      await credentials.revoke(ownerScope(principal), id);
    },
    manage: Object.freeze({
      query: () => credentials.query(GLOBAL_SCOPE),
      issueRoot: (input: IssueCredentialInput) =>
        credentials.issue({ parentIdentity: null, credential: input }),
      issueFor: (parentIdentity: Identity, input: IssueCredentialInput) =>
        credentials.issue({ parentIdentity, credential: input }),
      update: (id: string, input: UpdateCredentialInput) =>
        credentials.update(GLOBAL_SCOPE, id, input),
      updateScopes: (id: string, scopes: readonly string[]) =>
        credentials.updateScopes(GLOBAL_SCOPE, id, scopes),
      revoke: async (id: string) => {
        await credentials.revoke(GLOBAL_SCOPE, id);
      },
      revokeMany: (ids: readonly string[]) => credentials.revokeMany(GLOBAL_SCOPE, ids),
    }),
  });
}

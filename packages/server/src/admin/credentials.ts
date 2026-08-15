/**
 * The Admin Credential: the bearer an operator authenticates with, and the two
 * of its three issuance paths that belong to a running application — the boot
 * that mints it and the rotation that replaces it.
 *
 * **It is a credential and nothing else.** An Admin Credential is a root
 * identity credential in the one vault, holding the grant `["*", "_*"]` — no
 * marker column, no flag, no second table. That is what lets it work on an
 * application with no authentication authority configured at all: the vault
 * verifier exists whether or not an application verifier does, so the very
 * first thing an operator can do with a fresh database is authenticate.
 *
 * **Boot-mint** answers the zero-config case. A server whose vault holds no
 * Admin Credential mints one during the boot — through the vault, before any
 * application code is imported and before the Runtime exists — and hands the
 * plaintext back once, for the boot's reporter to print. It is deliberately
 * conditional on the vault's own definition of the master rather than on a
 * marker of its own, so the offline break-glass reset and this path can never
 * disagree about what they are counting.
 *
 * **Rotation** answers the routine case, and is the reason this file's
 * functions are a query and a mutation rather than procedures: the credential
 * capability is bound for reads and writes and not for procedure contexts, and
 * that split is what keeps "a write needs a write set" a type rather than a
 * runtime assertion.
 *
 * The third path — `acker credential reset`, for an operator locked out of a
 * server that may not even start — cannot live here, because it must run
 * against a stopped database with no application compiled. It reads the same
 * vault definition from `database/credential-reset.ts`.
 */
import {
  ADMIN_API_PATH,
  type AdminCredential,
  type AdminCredentialIssued,
} from "@ackerdb/core";
import {
  mutation,
  query,
  type MutationCtx,
  type QueryCtx,
} from "../app/functions.ts";
import { adminCredentials } from "../auth/credential-context.ts";
import { credentialVaultOwner, type CredentialLimits } from "../auth/credential-vault.ts";
import { ADMINISTRATIVE_GRANT, type ScopeRequirement } from "../auth/scopes.ts";
import type { Engine } from "../database/engine.ts";
import { v } from "../validation/v.ts";
import type { AdminScope } from "./scopes.ts";

/**
 * What every Admin Credential is called. It is a constant rather than an
 * argument because the product manages one master and the surface that would
 * ask for a name — issuing credentials to named agents — is not this one.
 */
export const ADMIN_CREDENTIAL_NAME = "Admin Credential";

const credentialShape = v.object({
  id: v.string(),
  name: v.string(),
  createdAt: v.float(),
});

/**
 * What one boot decided about the Admin Credential. A token is present on
 * exactly the boot that minted one, because the plaintext exists for that one
 * moment and no read can recover it afterwards.
 */
export interface AdminCredentialBoot {
  readonly id: string;
  readonly token?: string;
}

/** What the boot-mint needs beyond the reconciled engine; nothing here is a Runtime. */
export interface AdminCredentialMint {
  /** Application scopes plus the framework's: what the administrative grant expands against. */
  readonly vocabulary: readonly string[];
  readonly limits: CredentialLimits;
  readonly now: () => number;
}

/**
 * Mint the Admin Credential if the vault holds none, directly through the vault.
 *
 * The existence test runs twice, against the one vault definition, and both
 * readings earn their place. The read on the open Engine is what keeps a boot
 * with nothing to do from writing at all — every other conditional startup
 * step, from schema reconciliation to the FileStore binding, holds the same
 * rule, and a server that rewrote a row on every restart would make a restart
 * indistinguishable from a change. The read inside the immediate transaction is
 * the decision: only there are "none exists" and "now one does" the same
 * instant, so no arrangement of concurrent work can produce two masters.
 *
 * It goes through the vault and not through `systemCredentials.create` because
 * at boot no Runtime exists, and the two live-runtime concerns that surface
 * carries — recording the reactive read key, marking a token-bearing result
 * one-time — have no subject yet. Break-glass calls the vault directly for the
 * same reason. That is what lets the mint precede every application module
 * import and the Runtime's start (ADR-0031).
 *
 * Failure is the caller's to make loud. A server nobody can administer, that
 * printed nothing to say so, is discovered at the moment administration is
 * needed most.
 */
export function ensureAdminCredential(engine: Engine, mint: AdminCredentialMint): AdminCredentialBoot {
  const vault = engine[credentialVaultOwner];
  const present = vault.listAdministrative(engine.reader)[0];
  if (present !== undefined) return Object.freeze({ id: present.id });
  return engine.writer.transaction((): AdminCredentialBoot => {
    const held = vault.listAdministrative(engine.writer)[0];
    if (held !== undefined) return Object.freeze({ id: held.id });
    const created = vault.create(
      null,
      { name: ADMIN_CREDENTIAL_NAME, scopes: ADMINISTRATIVE_GRANT },
      mint.vocabulary,
      mint.limits,
      mint.now(),
    );
    return Object.freeze({ id: created.id, token: created.token });
  }).immediate();
}

/**
 * The framework's `admin.credentials.*` module. Unlike `admin.system.*` it
 * closes over no configuration — what a credential is does not depend on how
 * the operator described the application — so it is a value rather than a
 * builder.
 */
export const credentialsModule = Object.freeze({
  list: query({
    apiPath: ADMIN_API_PATH,
    http: { openapi: false },
    title: "Admin Credentials",
    description: "Every credential holding administrative authority.",
    access: "authenticated",
    scopes: { anyOf: ["_admin:credentials:read"] } satisfies ScopeRequirement<AdminScope>,
    args: {},
    returns: v.array(credentialShape),
    handler: (ctx: QueryCtx): AdminCredential[] =>
      adminCredentials.list(ctx).map((credential) => ({
        id: credential.id,
        name: credential.name,
        createdAt: credential.createdAt,
      })),
  }),
  rotate: mutation({
    apiPath: ADMIN_API_PATH,
    http: { openapi: false },
    title: "Rotate the Admin Credential",
    description: "Issues a new Admin Credential and revokes the ones it replaces.",
    access: "authenticated",
    scopes: { anyOf: ["_admin:credentials:write"] } satisfies ScopeRequirement<AdminScope>,
    args: {},
    returns: v.object({ id: v.string(), token: v.string() }),
    handler: (ctx: MutationCtx): AdminCredentialIssued => {
      const created = adminCredentials.rotate(ctx, ADMIN_CREDENTIAL_NAME);
      return { id: created.id, token: created.token };
    },
  }),
});

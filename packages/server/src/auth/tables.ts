/**
 * The framework's Identity tables: who a principal is, and which external
 * accounts answer to that principal.
 *
 * They are ordinary managed logical tables — planned, transactional, and
 * reactive like any application table — contributed to the framework schema by
 * this module rather than created as Engine-internal SQL. That is what lets
 * account linking, credential issuance, and the lineage walk all run through
 * one database interface instead of a second, raw one.
 *
 * `_ackerdb_identities` carries nothing but its own key: an Identity is a
 * durable number and every fact about it lives in the tables that reference it.
 * `_ackerdb_identity_accounts` maps one verified external account, keyed by its
 * exact `(issuer, subject)` pair, onto exactly one Identity; the reverse index
 * answers "which accounts does this Identity hold", which is the question the
 * credential lineage walk asks about the root it ends at.
 *
 * Both are hidden from `ctx.db`: applications change account links only through
 * `ctx.auth.linkAccount` and `ctx.auth.unlinkAccount`, which hold the invariants
 * that raw row writes would not (a verified bearer, the final-account floor).
 */
import type { Identity } from "@ackerdb/core";
import type { ManagedTable } from "../database/managed.ts";
import { Schema, TableDef } from "../schema/definition.ts";
import { v } from "../validation/v.ts";

export const IDENTITIES_TABLE = "_ackerdb_identities";
export const IDENTITY_ACCOUNTS_TABLE = "_ackerdb_identity_accounts";

export interface IdentityRow {
  readonly id: Identity;
}

export interface IdentityAccountRow {
  readonly id: bigint;
  readonly issuer: string;
  readonly subject: string;
  readonly identity: Identity;
}

/** The Identity half of `ctx.internal.db`. */
export interface IdentityDatabase {
  readonly [IDENTITIES_TABLE]: ManagedTable<IdentityRow>;
  readonly [IDENTITY_ACCOUNTS_TABLE]: ManagedTable<IdentityAccountRow>;
}

/** The Identity tables, as one framework schema contribution. */
export function identitySchema(): Schema {
  return new Schema(
    {
      [IDENTITIES_TABLE]: new TableDef({ id: v.primaryKey() }, "table"),
      [IDENTITY_ACCOUNTS_TABLE]: new TableDef({
        id: v.primaryKey(),
        issuer: v.string(),
        subject: v.string(),
        identity: v.identity(),
      }, "table")
        .index(["issuer", "subject"], { unique: true })
        .index(["identity"]) as TableDef,
    },
    new Map(),
  );
}

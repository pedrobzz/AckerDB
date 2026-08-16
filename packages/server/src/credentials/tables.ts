/**
 * The framework's Credential table, and the row it stores.
 *
 * Every credential IS an Identity: the row carries the Identity minted for it,
 * and `parentIdentity` records delegation lineage — null for a root credential
 * whose grant comes straight from the vocabulary, otherwise the issuing
 * Identity whose current grant bounds this one at use.
 *
 * The stored grant is a *pattern* set, not an expansion: authority is whatever
 * those patterns expand to against the vocabulary at the moment the principal
 * is built, which is what lets a wildcard cover a scope declared after the
 * credential was minted. Patterns and metadata are stored in their wire
 * encoding, exactly as Jobs stores its arguments, because neither is a
 * filterable column and re-modelling them as rows would buy nothing.
 *
 * `secretDigest` is the only column that never crosses a public interface. It
 * is why this table is hidden from `ctx.db`: a generic read would hand out
 * stored authentication material, and a generic write would let an application
 * mint authority without the delegation check.
 */
import type { Identity } from "@ackerdb/core";
import type { IdentityDatabase } from "../auth/tables.ts";
import type { ManagedTable } from "../database/managed.ts";
import { Schema, TableDef } from "../schema/definition.ts";
import { v } from "../validation/v.ts";

export const CREDENTIALS_TABLE = "_ackerdb_credentials";

export interface CredentialRow {
  /** Creation sequence: the default order of every credential query. */
  readonly id: bigint;
  /** The public half of the bearer token, and the credential's public name. */
  readonly tokenId: string;
  /** The credential's own first-class Identity. */
  readonly identity: Identity;
  /** The issuing Identity whose current grant bounds this one, or null for a root. */
  readonly parentIdentity: Identity | null;
  /** SHA-256 of the secret half. Never leaves this module. */
  readonly secretDigest: Uint8Array;
  readonly name: string;
  /** Wire-encoded operator metadata object. */
  readonly metadataJson: string;
  /** Wire-encoded grant patterns. */
  readonly scopesJson: string;
  readonly createdAt: number;
  readonly updatedAt: number;
}

/**
 * What the Credentials module addresses: its own table and the Identity tables
 * a credential is one of. It is the framework-managed slice of `ctx.internal.db`
 * this domain uses, narrowed once here rather than cast at each call.
 */
export interface CredentialDatabase extends IdentityDatabase {
  readonly [CREDENTIALS_TABLE]: ManagedTable<CredentialRow>;
}

/** The Credential table, as one framework schema contribution. */
export function credentialSchema(): Schema {
  return new Schema(
    {
      [CREDENTIALS_TABLE]: new TableDef({
        id: v.primaryKey(),
        tokenId: v.string(),
        identity: v.identity(),
        parentIdentity: v.identity().nullable(),
        secretDigest: v.bytes(),
        name: v.string(),
        metadataJson: v.string(),
        scopesJson: v.string(),
        createdAt: v.float(),
        updatedAt: v.float(),
      }, "table")
        .index(["tokenId"], { unique: true })
        .index(["identity"], { unique: true })
        // The owner index answers both halves of the lineage walk: one level of
        // descendants from a parent Identity. Creation order rides along,
        // because the primary key is every query's implicit tie-breaker.
        .index(["parentIdentity"]) as TableDef,
    },
    new Map(),
  );
}

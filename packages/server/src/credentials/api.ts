/**
 * The credential capability an application handler holds, in types.
 *
 * `ctx.credentials` is scoped to the calling user Identity: it addresses the
 * credentials that Identity issued directly, and every grant it asks for is
 * bounded by the grant it holds. `ctx.credentials.manage` is global and carries
 * no framework authorization at all — the registered function's own access
 * policy and declared scopes are the whole admission decision, which is what
 * makes administration the application's product rather than AckerDB's.
 *
 * Reads are the ordinary table-query interface over a safe descriptor, so a
 * management screen filters, orders, paginates, counts and subscribes exactly
 * as it does over its own tables. There is no `list()`: it would be
 * `query().collect()` under another name.
 */
import type { Identity } from "@ackerdb/core";
import type { OrderedTableQuery, TableQuery } from "../database/query/types.ts";
import type {
  NullableValidator,
  StandardValidator,
} from "../validation/validator.ts";

/**
 * One credential as every reader sees it. The secret digest is absent by
 * construction — this type is the only shape a credential leaves the module in,
 * so no query, projection, or aggregate can reach stored authentication
 * material.
 */
export interface Credential {
  /** The public half of the bearer token: how every operation names a credential. */
  readonly id: string;
  /** The credential's own first-class Identity. */
  readonly identity: Identity;
  /** The Identity that issued it, or null for a root credential. */
  readonly parentIdentity: Identity | null;
  readonly name: string;
  readonly metadata: Readonly<Record<string, unknown>>;
  /** The grant as stored: patterns, not their expansion. */
  readonly scopes: readonly string[];
  readonly createdAt: number;
  readonly updatedAt: number;
}

/** A freshly issued credential. `token` is the whole bearer, and it is shown once. */
export interface IssuedCredential extends Credential {
  readonly token: string;
}

export interface IssueCredentialInput {
  readonly name: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
  /** Grant patterns; absent is the empty grant. */
  readonly scopes?: readonly string[];
}

export type UpdateCredentialInput =
  | {
      readonly name: string;
      readonly metadata?: Readonly<Record<string, unknown>>;
    }
  | {
      readonly name?: string;
      readonly metadata: Readonly<Record<string, unknown>>;
    };

/**
 * The safe projection of the private framework table, expressed through the
 * ordinary query DSL. Only these columns exist to filter and order by: the
 * stored digest is not among them, and the two wire-encoded columns are not
 * predicates anybody could write usefully.
 */
type CredentialColumns = {
  readonly id: StandardValidator<string, "string">;
  readonly identity: StandardValidator<Identity, "identity">;
  readonly parentIdentity: NullableValidator<StandardValidator<Identity, "identity">>;
  readonly name: StandardValidator<string, "string">;
  readonly createdAt: StandardValidator<number, "float">;
  readonly updatedAt: StandardValidator<number, "float">;
};

export type CredentialQuery = TableQuery<CredentialColumns, Credential>;
export type OrderedCredentialQuery = OrderedTableQuery<CredentialColumns, Credential>;

/** Reads, on every invocation context. */
export interface CredentialReadCapability {
  query(): CredentialQuery;
}

/**
 * Global credential administration, with no framework access check of its own.
 *
 * "No access check" is about who may reach these operations, not about what
 * they may store: a child issued or rescoped here is still bounded by its
 * parent's current effective grant, because a stored grant that exceeded its
 * source would spring open the moment that source widened.
 */
export interface ManageCredentialCapability extends CredentialReadCapability {
  /** Issue a root credential: a new Identity with no parent to bound it. */
  issueRoot(input: IssueCredentialInput): Promise<IssuedCredential>;
  /**
   * Issue a credential whose new Identity has the chosen Identity as its
   * parent, bounded by what that parent currently holds.
   */
  issueFor(parentIdentity: Identity, input: IssueCredentialInput): Promise<IssuedCredential>;
  update(id: string, input: UpdateCredentialInput): Promise<void>;
  updateScopes(id: string, scopes: readonly string[]): Promise<void>;
  /** Revoke one credential and every credential delegated beneath it. */
  revoke(id: string): Promise<void>;
  /** Revoke many, atomically. Missing ids are ignored; the affected ids come back. */
  revokeMany(ids: readonly string[]): Promise<readonly string[]>;
}

/** What a query context holds: reads only, on both scopes. */
export interface CredentialQueryCapability extends CredentialReadCapability {
  readonly manage: CredentialReadCapability;
}

/** What a mutation or transaction context holds. */
export interface CredentialMutationCapability extends CredentialReadCapability {
  /** Issue a child credential: a new Identity parented by the calling one. */
  issue(input: IssueCredentialInput): Promise<IssuedCredential>;
  update(id: string, input: UpdateCredentialInput): Promise<void>;
  updateScopes(id: string, scopes: readonly string[]): Promise<void>;
  revoke(id: string): Promise<void>;
  readonly manage: ManageCredentialCapability;
}

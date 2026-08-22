/**
 * The serializable filter expression: the closed, wire-safe vocabulary a
 * caller sends to describe which rows it wants. Clauses compare or test
 * membership of one declared field, and nested `all`/`any` groups combine
 * them. `any` — OR — is in the contract from the first version, because the
 * server's predicate layer already composes AND, OR, and NOT; the serializable
 * form mirrors that layer rather than describing a weaker one. Indexes never
 * appear: they are transparent, planner-owned storage configuration.
 *
 * Core owns only the shapes that cross the wire. Validating an expression
 * against a table's declared filterable fields, and compiling it into
 * predicate nodes, belong to the server package — where a failure comes back
 * as an ordinary application error rather than a throw.
 */

/** A comparable literal. `null` is only meaningful with `eq` and `neq`. */
export type FilterValue = string | number | boolean | bigint | null;

export type FilterComparisonOperator = "eq" | "neq" | "gt" | "gte" | "lt" | "lte";
export type FilterMembershipOperator = "anyOf" | "noneOf";
export type FilterOperator = FilterComparisonOperator | FilterMembershipOperator;

/** `field <op> value`. `eq`/`neq` against `null` test presence, as SQL does. */
export interface FilterComparison {
  readonly field: string;
  readonly op: FilterComparisonOperator;
  readonly value: FilterValue;
}

/** `field` is (or is not) one of `values`. `null` members are rejected — use `eq null`. */
export interface FilterMembership {
  readonly field: string;
  readonly op: FilterMembershipOperator;
  readonly values: readonly FilterValue[];
}

/** Every member must match. An empty `all` matches every row. */
export interface FilterAllGroup {
  readonly all: readonly FilterExpression[];
}

/** At least one member must match. An empty `any` matches no row. */
export interface FilterAnyGroup {
  readonly any: readonly FilterExpression[];
}

export type FilterExpression =
  | FilterComparison
  | FilterMembership
  | FilterAllGroup
  | FilterAnyGroup;

/**
 * One reason an expression was rejected. `path` locates the offending node
 * from the expression root — `$`, `$.all[1].value` — so a caller can attach
 * the message to the control that produced it instead of showing one opaque
 * failure for the whole filter.
 */
export interface FilterIssue {
  readonly path: string;
  readonly message: string;
}

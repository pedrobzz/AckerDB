/**
 * The serializable filter expression contract (#193): the closed, wire-safe
 * vocabulary clients send to describe row filters. Comparisons and membership
 * tests target declared filterable fields — plain columns or JSON paths like
 * `metadata.<key>` — and compose through nested `all`/`any` groups. OR (`any`)
 * is part of the contract from day 1; AND-only chips are a UI constraint.
 *
 * Core owns only the wire types. Validation against a table's declared
 * filterable fields and compilation to parameterized SQL live in the server
 * package, with validation failures returned as data (`FilterIssue[]`).
 */

/** A comparable literal. `null` is only meaningful with `eq`/`neq`. */
export type FilterValue = string | number | boolean | bigint | null;

export type FilterComparisonOperator = "eq" | "neq" | "gt" | "gte" | "lt" | "lte";
export type FilterMembershipOperator = "anyOf" | "noneOf";
export type FilterOperator = FilterComparisonOperator | FilterMembershipOperator;

/** `field <op> value`. `eq`/`neq` against `null` test presence (SQL NULL). */
export interface FilterComparison {
  readonly field: string;
  readonly op: FilterComparisonOperator;
  readonly value: FilterValue;
}

/** `field` is (not) one of `values`. `null` entries are rejected — use `eq null`. */
export interface FilterMembership {
  readonly field: string;
  readonly op: FilterMembershipOperator;
  readonly values: readonly FilterValue[];
}

/** Every member must match. An empty group matches every row. */
export interface FilterAllGroup {
  readonly all: readonly FilterExpression[];
}

/** At least one member must match. An empty group matches no row. */
export interface FilterAnyGroup {
  readonly any: readonly FilterExpression[];
}

export type FilterExpression =
  | FilterComparison
  | FilterMembership
  | FilterAllGroup
  | FilterAnyGroup;

/**
 * One validation failure, as data: `path` locates the offending node from the
 * expression root (`$`, `$.all[1].value`, ...), `message` says what is wrong.
 */
export interface FilterIssue {
  readonly path: string;
  readonly message: string;
}

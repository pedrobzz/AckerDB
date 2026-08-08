/**
 * Serializable filters, independent of what is being filtered.
 *
 * Validation is a walk over the wire expression against a map of declared
 * fields, and folding turns the validated tree into an ordinary predicate node
 * through a caller-supplied encoder. Neither step needs a table, a schema, or a
 * database file: a field is a kind, a nullability, and a check. That is what
 * lets a second store accept the same expression a table accepts, so a client
 * learns one filter vocabulary rather than one per surface.
 *
 * The expression arrives from a caller, so validation never throws: it returns
 * `filter.invalid` carrying one issue per offending node, located by path. Only
 * a *declaration* throws, and declarations belong to whoever owns the fields.
 */
import {
  Err,
  Ok,
  Status,
  type ApplicationError,
  type FilterIssue,
  type Result,
} from "@ackerdb/core";
import { isValidationError } from "../../validation/error.ts";
import {
  ORDERED_KINDS,
  type ComparisonOperator,
  type PredicateNode,
} from "../query/predicate.ts";

/** Contract bound: groups may nest at most this deep. */
export const MAX_FILTER_DEPTH = 8;
/** Contract bound: one expression may hold at most this many clauses and groups. */
export const MAX_FILTER_NODES = 128;
/**
 * Contract bound: comparison values and membership members one expression may
 * carry. Each becomes one SQL parameter, so this bound is what keeps a filter
 * clear of SQLite's variable limit while leaving the rest of the statement —
 * other predicates, the cursor tuple — its own room.
 */
export const MAX_FILTER_VALUES = 1_024;

const OPERATORS: Readonly<Record<string, ComparisonOperator>> = {
  eq: "eq",
  neq: "ne",
  gt: "gt",
  gte: "gte",
  lt: "lt",
  lte: "lte",
};

/** The rejection a caller renders: every issue, located by expression path. */
export type FilterInvalid = ApplicationError<
  "filter.invalid",
  { readonly issues: readonly FilterIssue[] },
  400
>;

/** What a store promises about one filterable field. */
export interface FilterableField {
  readonly kind: string;
  readonly nullable: boolean;
  check(value: unknown, path: string): unknown;
}

/** A checked but un-encoded clause tree; storage encoding waits for the fold. */
export type ValidatedFilterNode =
  | { readonly kind: "column"; readonly column: string; readonly op: ComparisonOperator; readonly value: unknown }
  | { readonly kind: "null"; readonly column: string; readonly isNull: boolean }
  | { readonly kind: "set"; readonly column: string; readonly negated: boolean; readonly values: readonly unknown[] }
  | { readonly kind: "group"; readonly op: "all" | "any"; readonly children: readonly ValidatedFilterNode[] };

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** One walk's shared state: the issues found and the budgets left to spend. */
interface Walk {
  readonly issues: FilterIssue[];
  nodes: number;
  values: number;
  overflowed: boolean;
}

class FilterValidator {
  constructor(private readonly fields: ReadonlyMap<string, FilterableField>) {}

  /**
   * Report the first budget an expression overruns and end the walk. Both
   * budgets exist so an untrusted expression cannot buy work; a wall of
   * identical issues would be exactly the work they refuse to sell.
   */
  private overflow(walk: Walk, path: string, bound: string): undefined {
    if (!walk.overflowed) {
      walk.overflowed = true;
      walk.issues.push({ path, message: `a filter may hold ${bound}` });
    }
    return undefined;
  }

  validate(expression: unknown): Result<ValidatedFilterNode, FilterInvalid> {
    const walk: Walk = { issues: [], nodes: 0, values: 0, overflowed: false };
    const node = this.node(expression, "$", 0, walk);
    if (node === undefined || walk.issues.length > 0) {
      return Err("filter.invalid", { issues: Object.freeze(walk.issues) }, Status.BadRequest);
    }
    return Ok(node);
  }

  private node(
    raw: unknown,
    path: string,
    depth: number,
    walk: Walk,
  ): ValidatedFilterNode | undefined {
    if (walk.nodes++ >= MAX_FILTER_NODES) {
      return this.overflow(walk, path, `at most ${MAX_FILTER_NODES} clauses and groups`);
    }
    if (!isPlainObject(raw)) {
      walk.issues.push({ path, message: "expected a filter expression object" });
      return undefined;
    }
    const keys = Object.keys(raw);
    if (!keys.includes("all") && !keys.includes("any")) return this.clause(raw, path, walk);
    if (keys.length !== 1) {
      walk.issues.push({ path, message: 'a group has exactly one key: "all" or "any"' });
      return undefined;
    }
    const op = keys[0] as "all" | "any";
    const members = raw[op];
    if (!Array.isArray(members)) {
      walk.issues.push({ path: `${path}.${op}`, message: `"${op}" must be an array` });
      return undefined;
    }
    if (depth >= MAX_FILTER_DEPTH) {
      walk.issues.push({
        path,
        message: `groups may not nest deeper than ${MAX_FILTER_DEPTH} levels`,
      });
      return undefined;
    }
    const children: ValidatedFilterNode[] = [];
    let failed = false;
    for (let index = 0; index < members.length; index++) {
      // An overrun ends the walk here rather than visiting the rest of a
      // caller-sized array: the bounds are what a filter may hold, so reading
      // past them would be the work they exist to refuse.
      if (walk.overflowed) return undefined;
      const child = this.node(members[index], `${path}.${op}[${index}]`, depth + 1, walk);
      if (child === undefined) failed = true;
      else children.push(child);
    }
    return failed ? undefined : { kind: "group", op, children };
  }

  private clause(
    raw: Record<string, unknown>,
    path: string,
    walk: Walk,
  ): ValidatedFilterNode | undefined {
    const op = raw["op"];
    const field = raw["field"];
    if (typeof field !== "string" || typeof op !== "string") {
      walk.issues.push({
        path,
        message: 'a clause declares "field" and "op" (or is an "all"/"any" group)',
      });
      return undefined;
    }
    const membership = op === "anyOf" || op === "noneOf";
    if (!membership && OPERATORS[op] === undefined) {
      walk.issues.push({ path: `${path}.op`, message: `unknown operator ${JSON.stringify(op)}` });
      return undefined;
    }
    const valueKey = membership ? "values" : "value";
    for (const key of Object.keys(raw)) {
      if (key !== "field" && key !== "op" && key !== valueKey) {
        walk.issues.push({ path: `${path}.${key}`, message: `unexpected key ${JSON.stringify(key)}` });
        return undefined;
      }
    }
    if (!Object.hasOwn(raw, valueKey)) {
      walk.issues.push({ path, message: `operator ${JSON.stringify(op)} requires "${valueKey}"` });
      return undefined;
    }
    const plan = this.fields.get(field);
    if (plan === undefined) {
      walk.issues.push({
        path: `${path}.field`,
        message: `unknown filterable field ${JSON.stringify(field)}`,
      });
      return undefined;
    }
    return membership
      ? this.membership(field, plan, op === "noneOf", raw["values"], path, walk)
      : this.comparison(field, plan, op, raw["value"], path, walk);
  }

  private comparison(
    field: string,
    plan: FilterableField,
    op: string,
    value: unknown,
    path: string,
    walk: Walk,
  ): ValidatedFilterNode | undefined {
    const equality = op === "eq" || op === "neq";
    if (value === null) {
      if (!equality) {
        walk.issues.push({
          path: `${path}.value`,
          message: 'null combines only with "eq" and "neq", which test presence',
        });
        return undefined;
      }
      if (!plan.nullable) {
        walk.issues.push({ path: `${path}.value`, message: "this field is not nullable" });
        return undefined;
      }
      return { kind: "null", column: field, isNull: op === "eq" };
    }
    if (!equality && !ORDERED_KINDS.has(plan.kind)) {
      walk.issues.push({
        path: `${path}.op`,
        message: `a ${plan.kind} field does not support ${JSON.stringify(op)}`,
      });
      return undefined;
    }
    if (walk.values++ >= MAX_FILTER_VALUES) {
      return this.overflow(walk, `${path}.value`, `at most ${MAX_FILTER_VALUES} values`);
    }
    const checked = this.checked(plan, value, `${path}.value`, walk);
    return checked === undefined
      ? undefined
      : { kind: "column", column: field, op: OPERATORS[op]!, value: checked.value };
  }

  private membership(
    field: string,
    plan: FilterableField,
    negated: boolean,
    raw: unknown,
    path: string,
    walk: Walk,
  ): ValidatedFilterNode | undefined {
    if (!Array.isArray(raw)) {
      walk.issues.push({ path: `${path}.values`, message: '"values" must be an array' });
      return undefined;
    }
    const values: unknown[] = [];
    let failed = false;
    for (let index = 0; index < raw.length; index++) {
      const memberPath = `${path}.values[${index}]`;
      // Every member becomes one SQL parameter, so members are charged against
      // the same budget a comparison value is. Without this a single clause
      // could pass validation and then fail inside the compiler — turning the
      // promise of failures-as-data into a thrown framework error.
      if (walk.values++ >= MAX_FILTER_VALUES) {
        return this.overflow(walk, memberPath, `at most ${MAX_FILTER_VALUES} values`);
      }
      if (raw[index] === null) {
        walk.issues.push({
          path: memberPath,
          message: 'null is not a member value — use "eq" or "neq" against null',
        });
        failed = true;
        continue;
      }
      const checked = this.checked(plan, raw[index], memberPath, walk);
      if (checked === undefined) failed = true;
      else values.push(checked.value);
    }
    return failed ? undefined : { kind: "set", column: field, negated, values };
  }

  /** The field's own validator decides; its rejection becomes this node's issue. */
  private checked(
    plan: FilterableField,
    value: unknown,
    path: string,
    walk: Walk,
  ): { readonly value: unknown } | undefined {
    try {
      return { value: plan.check(value, path) };
    } catch (error) {
      if (!isValidationError(error)) throw error;
      const prefix = `${path}: `;
      walk.issues.push({
        path,
        message: error.message.startsWith(prefix) ? error.message.slice(prefix.length) : error.message,
      });
      return undefined;
    }
  }
}

/** Validate one wire expression against declared fields. Failures are data. */
export function validateFilterExpression(
  fields: ReadonlyMap<string, FilterableField>,
  expression: unknown,
): Result<ValidatedFilterNode, FilterInvalid> {
  return new FilterValidator(fields).validate(expression);
}

/**
 * Constant alternatives an empty group folds to. They exist so `all: []` and
 * `any: []` keep their exact meaning without inventing a SQL literal node: a
 * filter that matches everything adds no predicate at all, and one that
 * matches nothing becomes the empty `IN ()` the compiler already renders.
 */
const TRUE: unique symbol = Symbol("filter.true");
const FALSE: unique symbol = Symbol("filter.false");
type FoldedNode = PredicateNode | typeof TRUE | typeof FALSE;

/**
 * Fold a validated filter into a predicate node. `encode` turns one checked
 * logical value into the storage value the predicate compares against, and
 * `matchNothing` names the column an unsatisfiable filter tests, since "match
 * nothing" has to be spelled against some column the store actually has.
 * `null` means the filter matches every row, so the query gains no predicate.
 */
export function foldFilterNode(
  node: ValidatedFilterNode,
  encode: (column: string, value: unknown) => unknown,
  matchNothing: string,
): PredicateNode | null {
  const folded = fold(node, encode);
  if (folded === TRUE) return null;
  if (folded === FALSE) return { kind: "in", column: matchNothing, values: [] };
  return folded;
}

function fold(
  node: ValidatedFilterNode,
  encode: (column: string, value: unknown) => unknown,
): FoldedNode {
  switch (node.kind) {
    case "column":
      return {
        kind: "comparison",
        column: node.column,
        op: node.op,
        value: encode(node.column, node.value),
      };
    case "null":
      return { kind: "null", column: node.column, isNull: node.isNull };
    case "set": {
      if (node.values.length === 0) return node.negated ? TRUE : FALSE;
      const membership: PredicateNode = {
        kind: "in",
        column: node.column,
        values: node.values.map((value) => encode(node.column, value)),
      };
      return node.negated ? { kind: "not", expression: membership } : membership;
    }
    case "group": {
      const identity = node.op === "all" ? TRUE : FALSE;
      const absorbing = node.op === "all" ? FALSE : TRUE;
      let combined: FoldedNode = identity;
      for (const child of node.children) {
        const folded = fold(child, encode);
        if (folded === absorbing) return absorbing;
        if (folded === identity) continue;
        combined = combined === identity
          ? folded
          : {
              kind: node.op === "all" ? "and" : "or",
              left: combined as PredicateNode,
              right: folded as PredicateNode,
            };
      }
      return combined;
    }
  }
}

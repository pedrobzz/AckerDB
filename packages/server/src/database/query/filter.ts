/**
 * Serializable filters: the server half of the wire vocabulary core declares.
 * A table names the fields it is willing to be filtered on, and an expression
 * that survives validation becomes an ordinary predicate node — the same node
 * a `.where` callback produces, encoded by the same column codec. There is no
 * second query path: a validated filter composes with ordering, cursor
 * pagination, aggregates, and reactive dependency recording because by the
 * time the query sees it, it is indistinguishable from a hand-written
 * predicate.
 *
 * The expression arrives from a caller, so validation never throws: it returns
 * the application error `filter.invalid` carrying one issue per offending
 * node, which a client renders beside the control that produced it. Only the
 * *declaration* throws — naming a column that does not exist is the
 * developer's mistake, found at startup.
 *
 * A field must be declared because the filter is an oracle: filtering on a
 * column the query never returns would let a caller binary-search a value it
 * cannot read. The declared list is that boundary, and it is a list of
 * columns, exactly like a declared index.
 */
import {
  Err,
  Ok,
  Status,
  type ApplicationError,
  type FilterIssue,
  type Result,
} from "@ackerdb/core";
import { isTableDef, type TableDef } from "../../schema/definition.ts";
import type { ObjectShape } from "../../validation/composites.ts";
import { baseValidator } from "../../validation/validator.ts";
import { isValidationError, ValidationError } from "../../validation/error.ts";
import type { TablePlan } from "../engine.ts";
import {
  EQUATABLE_KINDS,
  ORDERED_KINDS,
  toSqlPredicateValue,
  type ComparisonOperator,
  type PredicateNode,
} from "./predicate.ts";

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

declare const TABLE_FILTER: unique symbol;

/**
 * A validated filter, bound to the table whose declared fields validated it.
 * Pass it to that table's `query().where(filter)`.
 */
export interface TableFilter<C extends ObjectShape = ObjectShape> {
  readonly [TABLE_FILTER]: C;
}

export interface FilterableFields<C extends ObjectShape = ObjectShape> {
  /** Validate one wire expression. Failures come back as data, never thrown. */
  validate(expression: unknown): Result<TableFilter<C>, FilterInvalid>;
}

interface FieldPlan {
  readonly kind: string;
  readonly nullable: boolean;
  check(value: unknown, path: string): unknown;
}

/** A checked but un-encoded clause tree; storage encoding waits for the plan. */
type ValidatedNode =
  | { readonly kind: "column"; readonly column: string; readonly op: ComparisonOperator; readonly value: unknown }
  | { readonly kind: "null"; readonly column: string; readonly isNull: boolean }
  | { readonly kind: "set"; readonly column: string; readonly negated: boolean; readonly values: readonly unknown[] }
  | { readonly kind: "group"; readonly op: "all" | "any"; readonly children: readonly ValidatedNode[] };

interface TableFilterMeta {
  readonly table: TableDef;
  readonly node: ValidatedNode;
}

const tableFilters = new WeakMap<object, TableFilterMeta>();

/** The runtime meta behind a branded `TableFilter`, if `value` is one. */
export function tableFilterMeta(value: unknown): TableFilterMeta | undefined {
  return value !== null && (typeof value === "object" || typeof value === "function")
    ? tableFilters.get(value)
    : undefined;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Declare the columns a table accepts serializable filters on. Build it once
 * beside the schema: the declaration is checked here, so a validated
 * expression only ever describes columns that exist and can be compared.
 */
export function filterableFields<C extends ObjectShape>(
  table: TableDef<C>,
  fields: readonly (keyof C & string)[],
): FilterableFields<C> {
  if (!isTableDef(table)) {
    throw new TypeError("filterableFields: expected a table from defineTable()");
  }
  if (table.kind === "event") {
    throw new ValidationError(
      "filterableFields: event tables never persist rows, so nothing can be filtered",
    );
  }
  if (!Array.isArray(fields) || fields.length === 0) {
    throw new ValidationError("filterableFields: declare at least one filterable column");
  }
  const plans = new Map<string, FieldPlan>();
  for (const field of fields) {
    if (plans.has(field)) {
      throw new ValidationError(`filterableFields: column ${JSON.stringify(field)} is declared twice`);
    }
    const validator = table.columns[field];
    if (validator === undefined) {
      throw new ValidationError(`filterableFields: unknown column ${JSON.stringify(field)}`);
    }
    const inner = baseValidator(validator);
    if (!EQUATABLE_KINDS.has(inner.kind)) {
      throw new ValidationError(
        `filterableFields: column ${JSON.stringify(field)} (${inner.kind}) cannot be compared`,
      );
    }
    plans.set(field, {
      kind: inner.kind,
      nullable: validator.kind === "nullable",
      check: (value, path) => inner.check(value, path),
    });
  }
  const validator = new FilterValidator(table as TableDef, plans);
  return {
    validate: (expression) => validator.validate(expression) as Result<TableFilter<C>, FilterInvalid>,
  };
}

/** One walk's shared state: the issues found and the budgets left to spend. */
interface Walk {
  readonly issues: FilterIssue[];
  nodes: number;
  values: number;
  overflowed: boolean;
}

class FilterValidator {
  constructor(
    private readonly table: TableDef,
    private readonly fields: ReadonlyMap<string, FieldPlan>,
  ) {}

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

  validate(expression: unknown): Result<TableFilter, FilterInvalid> {
    const walk: Walk = { issues: [], nodes: 0, values: 0, overflowed: false };
    const node = this.node(expression, "$", 0, walk);
    if (node === undefined || walk.issues.length > 0) {
      return Err("filter.invalid", { issues: Object.freeze(walk.issues) }, Status.BadRequest);
    }
    const filter = Object.freeze({}) as TableFilter;
    tableFilters.set(filter, { table: this.table, node });
    return Ok(filter);
  }

  private node(
    raw: unknown,
    path: string,
    depth: number,
    walk: Walk,
  ): ValidatedNode | undefined {
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
    const children: ValidatedNode[] = [];
    let failed = false;
    for (let index = 0; index < members.length; index++) {
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
  ): ValidatedNode | undefined {
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
    plan: FieldPlan,
    op: string,
    value: unknown,
    path: string,
    walk: Walk,
  ): ValidatedNode | undefined {
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
    plan: FieldPlan,
    negated: boolean,
    raw: unknown,
    path: string,
    walk: Walk,
  ): ValidatedNode | undefined {
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

  /** The column's own validator decides; its rejection becomes this node's issue. */
  private checked(
    plan: FieldPlan,
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
 * Compile a validated filter against one table plan. `null` means the filter
 * matches every row, so the query gains no predicate.
 */
export function filterPredicate(plan: TablePlan, meta: TableFilterMeta): PredicateNode | null {
  if (meta.table !== plan.table) {
    throw new ValidationError(
      `${plan.displayName}.query.where: this filter was validated for a different table`,
    );
  }
  const folded = fold(plan, meta.node);
  if (folded === TRUE) return null;
  if (folded === FALSE) return { kind: "in", column: plan.pk, values: [] };
  return folded;
}

function fold(plan: TablePlan, node: ValidatedNode): FoldedNode {
  switch (node.kind) {
    case "column":
      return {
        kind: "comparison",
        column: node.column,
        op: node.op,
        value: toSqlPredicateValue(plan, node.column, node.value, false),
      };
    case "null":
      return { kind: "null", column: node.column, isNull: node.isNull };
    case "set": {
      if (node.values.length === 0) return node.negated ? TRUE : FALSE;
      const membership: PredicateNode = {
        kind: "in",
        column: node.column,
        values: node.values.map((value) => toSqlPredicateValue(plan, node.column, value, false)),
      };
      return node.negated ? { kind: "not", expression: membership } : membership;
    }
    case "group": {
      const identity = node.op === "all" ? TRUE : FALSE;
      const absorbing = node.op === "all" ? FALSE : TRUE;
      let combined: FoldedNode = identity;
      for (const child of node.children) {
        const folded = fold(plan, child);
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
